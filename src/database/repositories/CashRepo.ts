/**
 * CashRepo — v25 (round-32 #3) the cash-movements ledger repository.
 * ─────────────────────────────────────────────────────────────────
 * نظام المصروفات والسحب من الخزينة — the Loyverse/Square cash-drawer
 * discipline studied and adapted to سيلا:
 *
 *  • expense    (EXP-…) — a business expense paid FROM the drawer
 *    (electricity, rent, supplies…) with a category + note.
 *  • withdrawal (WD-…)  — the owner pulling cash OUT of the drawer
 *    (سحب رصيد) — secured by fingerprint/PIN at entry time and the
 *    auth method is WRITTEN INTO the row (audit).
 *  • deposit    (DEP-…) — cash put BACK into the drawer (change
 *    top-up, returned withdrawals…).
 *
 * Numbering follows the app's invoice discipline (MMKV counter +
 * DB-max, the larger wins — a restore or a counter reset can never
 * re-issue a number) and the ref series is per-KIND per-DAY:
 *   EXP-20261007-0001, WD-20261007-0001, DEP-20261007-0001.
 *
 * Rows are IMMUTABLE — this repo deliberately exposes NO update or
 * delete APIs. A wrong entry is corrected by a counter-entry, never
 * erased (the global-POS audit-trail rule the merchant asked for:
 * «دون مشاكل او فقدان»).
 */
import {getDb} from '../connection';
import {localNow, localToday} from '../../core/format';
import {getNumber, getString, setNumber, setString} from '../../storage/storage';
import {logDiag} from '../../core/diagnostics';
import type {
  CashAuthMethod,
  CashCategoryTotal,
  CashMovementKind,
  CashMovementRecord,
  CashMovementTotals,
} from '../../core/types';

const KEYS = {
  day: (kind: CashMovementKind) => `cash_mov_day_${kind}` as const,
  counter: (kind: CashMovementKind) =>
    `cash_mov_counter_${kind}` as const,
};

const PREFIX: Record<CashMovementKind, string> = {
  expense: 'EXP',
  withdrawal: 'WD',
  deposit: 'DEP',
};

function rowToRecord(row: Record<string, unknown>): CashMovementRecord {
  return {
    local_id: Number(row.local_id ?? 0),
    ref: String(row.ref ?? ''),
    kind: (row.kind as CashMovementKind) ?? 'expense',
    category: String(row.category ?? 'أخرى'),
    note: (row.note as string | null) ?? null,
    amount_minor: Number(row.amount_minor ?? 0),
    auth_method: (row.auth_method as CashAuthMethod) ?? 'none',
    created_at: String(row.created_at ?? ''),
  };
}

async function maxSequenceInDb(
  kind: CashMovementKind,
  today: string,
): Promise<number> {
  const prefix = `${PREFIX[kind]}-${today.replace(/-/g, '')}-`;
  const result = await getDb().execute(
    `SELECT ref FROM cash_movements WHERE ref LIKE ? || '%'`,
    [prefix],
  );
  let max = 0;
  for (const row of result.rows ?? []) {
    const seq = Number(String((row as {ref?: string}).ref ?? '').slice(prefix.length));
    if (Number.isFinite(seq) && seq > max) {
      max = seq;
    }
  }
  return max;
}

/** Reserves the next ref for the kind TODAY (counter + DB max). */
async function reserveRef(kind: CashMovementKind): Promise<string> {
  const today = localToday();
  const dbMax = await maxSequenceInDb(kind, today);
  const lastDay = getString(KEYS.day(kind), '');
  const counter = getNumber(KEYS.counter(kind), 0);
  const mmkvNext = lastDay === today ? counter + 1 : 1;
  const next = Math.max(mmkvNext, dbMax + 1);
  setNumber(KEYS.counter(kind), next);
  setString(KEYS.day(kind), today);
  return `${PREFIX[kind]}-${today.replace(/-/g, '')}-${String(next).padStart(4, '0')}`;
}

export const CashRepo = {
  /** Appends ONE immutable movement. Unique-ref retry is the
   *  caller's discipline (CashService) — a UNIQUE clash here
   *  rejects the insert and the transaction stays atomic. */
  async add(input: {
    kind: CashMovementKind;
    category?: string;
    note?: string | null;
    amountMinor: number;
    authMethod?: CashAuthMethod;
  }): Promise<CashMovementRecord> {
    if (!Number.isFinite(input.amountMinor) || input.amountMinor <= 0) {
      throw new Error('المبلغ غير صالح — يجب أن يكون أكبر من صفر');
    }
    const defaultCategory =
      input.kind === 'withdrawal'
        ? 'سحب رصيد'
        : input.kind === 'deposit'
        ? 'إيداع نقدي'
        : 'متفرقات';
    const db = getDb();
    const ref = await reserveRef(input.kind);
    const insert = await db.execute(
      `INSERT INTO cash_movements
        (ref, kind, category, note, amount_minor, auth_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        ref,
        input.kind,
        input.category?.trim() || defaultCategory,
        input.note?.trim() ? input.note.trim() : null,
        Math.round(input.amountMinor),
        input.authMethod ?? 'none',
        localNow(),
      ],
    );
    const id = insert.insertId ?? -1;
    if (id < 0) {
      throw new Error('فشل تسجيل الحركة المالية');
    }
    logDiag(
      'cash',
      `سُجّلت حركة خزينة ${ref} (${input.kind}) بمبلغ ${(
        input.amountMinor / 100
      ).toFixed(2)} ₪ — فئة «${input.category}»`,
    );
    const row = await db.execute(
      'SELECT * FROM cash_movements WHERE local_id = ? LIMIT 1',
      [id],
    );
    const record = row.rows?.[0];
    if (record == null) {
      throw new Error('فشل قراءة الحركة بعد تسجيلها');
    }
    return rowToRecord(record as Record<string, unknown>);
  },

  /** The period statement list (newest first).
   *  v39 (الجولة 47): البحث في سجل الحركات — نص حر يطابق الملاحظة
   *  أو السند أو الفئة (LIKE)، وفلتر فئة صريح (نقاط المصروف). */
  async list(input: {
    from: string;
    to: string;
    kind?: CashMovementKind | 'all';
    limit?: number;
    offset?: number;
    /** v39: نص بحث حر — يطابق الملاحظة/السند/الفئة (اختياري). */
    search?: string;
    /** v39: فئة بعينها (مثل «كهرباء») أو null للكل (اختياري). */
    category?: string | null;
  }): Promise<CashMovementRecord[]> {
    const clauses = ["date(created_at) BETWEEN date(?) AND date(?)"];
    const params: (string | number)[] = [input.from, input.to];
    if (input.kind != null && input.kind !== 'all') {
      clauses.push('kind = ?');
      params.push(input.kind);
    }
    const search = input.search?.trim();
    if (search != null && search.length > 0) {
      clauses.push(
        '(note LIKE ? OR ref LIKE ? OR category LIKE ?)',
      );
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (input.category != null && input.category.length > 0) {
      clauses.push('category = ?');
      params.push(input.category);
    }
    // v26 (round-34 #5): the cap rose to 10,000 — the EXPORT paths
    // (PDF A4 / thermal statement) must carry EVERY row of the
    // period, never a truncated first page; the UI ledger stays paged
    // by its own small page size.
    params.push(Math.min(Math.max(input.limit ?? 100, 1), 10000));
    params.push(Math.max(input.offset ?? 0, 0));
    const result = await getDb().execute(
      `SELECT * FROM cash_movements
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, local_id DESC
       LIMIT ? OFFSET ?`,
      params,
    );
    return (result.rows ?? []).map(row =>
      rowToRecord(row as Record<string, unknown>),
    );
  },

  /** v26 (round-34 #5): how many movements the period+filter
   *  holds IN TOTAL — the paged ledger's «عرض X من Y سند» counter
   *  and its «load more» visibility.
   *  v39 (الجولة 47): نفس البحث الحر وفلتر الفئة يعملان على العدّ
   *  كي يبقى العداد صادقاً مع النتائج المرشّحة. */
  async countFor(
    from: string,
    to: string,
    kind: CashMovementKind | 'all' = 'all',
    search?: string,
    category?: string | null,
  ): Promise<number> {
    try {
      const clauses = ['date(created_at) BETWEEN date(?) AND date(?)'];
      const params: (string | number)[] = [from, to];
      if (kind !== 'all') {
        clauses.push('kind = ?');
        params.push(kind);
      }
      const text = search?.trim();
      if (text != null && text.length > 0) {
        clauses.push('(note LIKE ? OR ref LIKE ? OR category LIKE ?)');
        const like = `%${text}%`;
        params.push(like, like, like);
      }
      if (category != null && category.length > 0) {
        clauses.push('category = ?');
        params.push(category);
      }
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt FROM cash_movements WHERE ${clauses.join(' AND ')}`,
        params,
      );
      const row = (result.rows?.[0] ?? {}) as {cnt?: number};
      return Number(row.cnt ?? 0);
    } catch {
      return 0;
    }
  },

  /** Period totals for the statement + reports. */
  async totalsFor(from: string, to: string): Promise<CashMovementTotals> {
    const result = await getDb().execute(
      `SELECT kind,
              COUNT(*) AS cnt,
              COALESCE(SUM(amount_minor), 0) AS total
       FROM cash_movements
       WHERE date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY kind`,
      [from, to],
    );
    let expensesMinor = 0;
    let withdrawalsMinor = 0;
    let depositsMinor = 0;
    let expensesCount = 0;
    let withdrawalsCount = 0;
    let depositsCount = 0;
    for (const raw of result.rows ?? []) {
      const row = raw as {kind?: string; cnt?: number; total?: number};
      if (row.kind === 'expense') {
        expensesMinor = Number(row.total ?? 0);
        expensesCount = Number(row.cnt ?? 0);
      } else if (row.kind === 'withdrawal') {
        withdrawalsMinor = Number(row.total ?? 0);
        withdrawalsCount = Number(row.cnt ?? 0);
      } else if (row.kind === 'deposit') {
        depositsMinor = Number(row.total ?? 0);
        depositsCount = Number(row.cnt ?? 0);
      }
    }
    return {
      expensesMinor,
      withdrawalsMinor,
      depositsMinor,
      expensesCount,
      withdrawalsCount,
      depositsCount,
      netMinor: depositsMinor - expensesMinor - withdrawalsMinor,
    };
  },

  /** All-time totals for the treasury snapshot (single query). */
  async allTimeTotals(): Promise<{
    expensesMinor: number;
    withdrawalsMinor: number;
    depositsMinor: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT kind, COALESCE(SUM(amount_minor), 0) AS total
         FROM cash_movements GROUP BY kind`,
      );
      let expensesMinor = 0;
      let withdrawalsMinor = 0;
      let depositsMinor = 0;
      for (const raw of result.rows ?? []) {
        const row = raw as {kind?: string; total?: number};
        if (row.kind === 'expense') {
          expensesMinor = Number(row.total ?? 0);
        } else if (row.kind === 'withdrawal') {
          withdrawalsMinor = Number(row.total ?? 0);
        } else if (row.kind === 'deposit') {
          depositsMinor = Number(row.total ?? 0);
        }
      }
      return {expensesMinor, withdrawalsMinor, depositsMinor};
    } catch {
      // A fresh install has no table yet — the honest answer is 0.
      return {expensesMinor: 0, withdrawalsMinor: 0, depositsMinor: 0};
    }
  },

  /** Category breakdown (expenses + withdrawals) for the period —
   *  feeds the PDF statement's grouped section. */
  async categoryTotals(from: string, to: string): Promise<CashCategoryTotal[]> {
    const result = await getDb().execute(
      `SELECT category, COUNT(*) AS cnt, COALESCE(SUM(amount_minor), 0) AS total
       FROM cash_movements
       WHERE date(created_at) BETWEEN date(?) AND date(?)
         AND kind IN ('expense','withdrawal')
       GROUP BY category
       ORDER BY total DESC`,
      [from, to],
    );
    return (result.rows ?? []).map(raw => {
      const row = raw as {category?: string; cnt?: number; total?: number};
      return {
        category: String(row.category ?? 'أخرى'),
        count: Number(row.cnt ?? 0),
        totalMinor: Number(row.total ?? 0),
      };
    });
  },

  /** One movement by its local id (statement row detail). */
  async byId(localId: number): Promise<CashMovementRecord | null> {
    const result = await getDb().execute(
      'SELECT * FROM cash_movements WHERE local_id = ? LIMIT 1',
      [localId],
    );
    const row = result.rows?.[0];
    return row ? rowToRecord(row as Record<string, unknown>) : null;
  },
};
