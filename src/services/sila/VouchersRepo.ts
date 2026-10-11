/**
 * sila/VouchersRepo — local persistence for the VOUCHER campaigns
 * book (SILA_POS_VOUCHERS_API §5).
 * ─────────────────────────────────────────────────────────────────
 * Three tables, one discipline:
 *  - voucher_redemptions: one row per redemption ATTEMPT, created
 *    with ONE idempotency_key that never changes. NOT an offline
 *    queue — the row stays pending on a network cut and the sync
 *    engine retries the LIVE call with the SAME key (§5 rule 1,
 *    §7.3) until it resolves (ok | permanent failure).
 *  - campaign_debts: the campaigns claim ledger — every figure is
 *    written from SERVER snapshots only (the redeem answer's
 *    settlement block + the settlements feed). The POS never sums
 *    or subtracts on its own (§5 rule 3).
 *  - campaign_settlements: the mirror of the settlements[] feed
 *    (§4.2) that feeds the period reports and the treasury
 *    (confirmed = money actually received).
 */
import {getDb, toMessage} from '../../database/connection';
import {logDiag} from '../../core/diagnostics';
import {classifyCampaignKind} from './campaignKind';
import type {
  CampaignDebtRow,
  CampaignSettlementRow,
  CampaignStoreState,
  VoucherRedemptionRow,
} from '../../core/types';
import type {SilaCampaignServerRow, SilaVoucherRedeemResult} from './SilaApi';

function rowToRedemption(row: Record<string, unknown>): VoucherRedemptionRow {
  return {
    local_id: Number(row.local_id ?? 0),
    idempotency_key: String(row.idempotency_key ?? ''),
    payload: String(row.payload ?? ''),
    campaign_id: (row.campaign_id as string) ?? null,
    campaign_name: (row.campaign_name as string) ?? null,
    campaign_kind:
      (row.campaign_kind as VoucherRedemptionRow['campaign_kind']) ?? null,
    voucher_id: (row.voucher_id as string) ?? null,
    value_minor: Number(row.value_minor ?? 0),
    pos_receipt_ref: (row.pos_receipt_ref as string) ?? null,
    reference_code: (row.reference_code as string) ?? null,
    beneficiary_last4: (row.beneficiary_last4 as string) ?? null,
    redeemed_at: String(row.redeemed_at ?? ''),
    state: (row.state as VoucherRedemptionRow['state']) ?? 'pending',
    cart_json: (row.cart_json as string) ?? null,
    sale_id: row.sale_id == null ? null : Number(row.sale_id),
    counter_extra_minor: Number(row.counter_extra_minor ?? 0),
    error_code: (row.error_code as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    retry_count: Number(row.retry_count ?? 0),
    synced_at: (row.synced_at as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

function rowToCampaign(row: Record<string, unknown>): CampaignDebtRow {
  return {
    campaign_id: String(row.campaign_id ?? ''),
    campaign_name: String(row.campaign_name ?? ''),
    kind: (row.kind as CampaignDebtRow['kind']) ?? 'voucher',
    campaign_status: (row.campaign_status as string) ?? null,
    merchant_status: (row.merchant_status as string) ?? null,
    starts_at: (row.starts_at as string) ?? null,
    ends_at: (row.ends_at as string) ?? null,
    redeemed_count: Number(row.redeemed_count ?? 0),
    redeemed_value_minor: Number(row.redeemed_value_minor ?? 0),
    settled_minor: Number(row.settled_minor ?? 0),
    settled_pending_minor: Number(row.settled_pending_minor ?? 0),
    settled_confirmed_minor: Number(row.settled_confirmed_minor ?? 0),
    due_minor: Number(row.due_minor ?? 0),
    settlement_state:
      (row.settlement_state as CampaignDebtRow['settlement_state']) ?? 'none',
    last_redemption_at: (row.last_redemption_at as string) ?? null,
    last_settlement_at: (row.last_settlement_at as string) ?? null,
    updated_at: (row.updated_at as string) ?? null,
    store_state:
      row.store_state === 'completed'
        ? 'completed'
        : row.store_state === 'active'
        ? 'active'
        : 'available',
  };
}

function rowToSettlement(row: Record<string, unknown>): CampaignSettlementRow {
  return {
    settlement_id: String(row.settlement_id ?? ''),
    campaign_id: String(row.campaign_id ?? ''),
    campaign_name: (row.campaign_name as string) ?? null,
    amount_minor: Number(row.amount_minor ?? 0),
    kind: String(row.kind ?? 'compensation'),
    status: (row.status as CampaignSettlementRow['status']) ?? 'pending',
    method: (row.method as string) ?? null,
    reference: (row.reference as string) ?? null,
    created_at: String(row.created_at ?? ''),
  };
}

export interface CreateRedemptionInput {
  idempotencyKey: string;
  payload: string;
  posReceiptRef: string;
  redeemedAt: string;
  /** JSON snapshot of the cart (nullable for standalone redemptions). */
  cartJson: string | null;
}

export const VouchersRepo = {
  // ── voucher_redemptions ───────────────────────────────────────

  /** Creates the attempt row (§5 rule 1 — one idempotency key forever). */
  async createRedemption(
    input: CreateRedemptionInput,
  ): Promise<VoucherRedemptionRow> {
    await getDb().execute(
      `INSERT INTO voucher_redemptions (
        idempotency_key, payload, pos_receipt_ref, redeemed_at,
        cart_json, state
      ) VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        input.idempotencyKey,
        input.payload,
        input.posReceiptRef,
        input.redeemedAt,
        input.cartJson,
      ],
    );
    const row = await getDb().execute(
      'SELECT * FROM voucher_redemptions WHERE idempotency_key = ?',
      [input.idempotencyKey],
    );
    logDiag('sila', `بدء صرف قسيمة — إيصال ${input.posReceiptRef}`);
    return rowToRedemption(row.rows?.[0] ?? {});
  },

  /** Books a successful redemption: server facts + the sale link.
   *  Returns false when the row was ALREADY ok (an idempotent
   *  replay after a crash — the sale must not be created twice). */
  async markRedeemed(
    localId: number,
    result: SilaVoucherRedeemResult,
    counterExtraMinor: number,
  ): Promise<boolean> {
    const db = getDb();
    const existing = await db.execute(
      'SELECT state, sale_id FROM voucher_redemptions WHERE local_id = ?',
      [localId],
    );
    const prior = existing.rows?.[0] as
      | {state?: string; sale_id?: number | null}
      | undefined;
    if (prior?.state === 'ok') {
      return false; // already booked — idempotent by design.
    }
    await db.execute(
      `UPDATE voucher_redemptions
       SET state = 'ok', value_minor = ?, campaign_id = ?,
           campaign_name = ?, campaign_kind = ?, voucher_id = ?,
           reference_code = ?, beneficiary_last4 = ?,
           counter_extra_minor = ?, synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           error_code = NULL, error_message = NULL
       WHERE local_id = ?`,
      [
        result.value_minor,
        result.campaign_id,
        result.campaign_name,
        result.kind,
        result.voucher_id,
        result.reference_code,
        result.beneficiary_last4 ?? null,
        Math.max(0, counterExtraMinor),
        localId,
      ],
    );
    return true;
  },

  /** Links the created INV-V sale row (after markRedeemed). */
  async attachSale(localId: number, saleId: number): Promise<void> {
    await getDb().execute(
      'UPDATE voucher_redemptions SET sale_id = ? WHERE local_id = ?',
      [saleId, localId],
    );
  },

  async markFailed(
    localId: number,
    code: string,
    message: string,
  ): Promise<void> {
    await getDb().execute(
      `UPDATE voucher_redemptions
       SET state = 'failed', error_code = ?, error_message = ?
       WHERE local_id = ?`,
      [code, message, localId],
    );
  },

  /** Transient failure — stays pending, retry count grows. */
  async markRetry(localId: number): Promise<void> {
    await getDb().execute(
      `UPDATE voucher_redemptions
       SET retry_count = retry_count + 1
       WHERE local_id = ?`,
      [localId],
    );
  },

  /** §5 rule 1/§7.3: pending rows retried LIVE with the same key. */
  async pendingRedemptions(): Promise<VoucherRedemptionRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM voucher_redemptions
       WHERE state = 'pending'
       ORDER BY created_at ASC, local_id ASC`,
    );
    return (result.rows ?? []).map(row =>
      rowToRedemption(row as Record<string, unknown>),
    );
  },

  async counts(): Promise<{pending: number; ok: number; failed: number}> {
    try {
      const result = await getDb().execute(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'ok' THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM voucher_redemptions`,
      );
      const row = (result.rows?.[0] ?? {}) as {
        pending?: number | null;
        ok?: number | null;
        failed?: number | null;
      };
      return {
        pending: Number(row.pending ?? 0),
        ok: Number(row.ok ?? 0),
        failed: Number(row.failed ?? 0),
      };
    } catch {
      return {pending: 0, ok: 0, failed: 0};
    }
  },

  /** Paged history for the القسائم tab (newest first, search
   *  across receipt ref / reference / campaign / code). */
  async recent(
    limit: number,
    offset: number,
    state?: VoucherRedemptionRow['state'],
    search?: string,
  ): Promise<VoucherRedemptionRow[]> {
    const where: string[] = [];
    // v45 (round-53): op-sqlite 11 types execute() params as Scalar[]
    const params: (string | number | boolean | null)[] = [];
    if (state != null) {
      where.push('state = ?');
      params.push(state);
    }
    if (search && search.trim().length > 0) {
      where.push(
        '(pos_receipt_ref LIKE ? OR reference_code LIKE ? OR campaign_name LIKE ? OR payload LIKE ?)',
      );
      const needle = `%${search.trim()}%`;
      params.push(needle, needle, needle, needle);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await getDb().execute(
      `SELECT * FROM voucher_redemptions ${whereSql}
       ORDER BY created_at DESC, local_id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return (result.rows ?? []).map(row =>
      rowToRedemption(row as Record<string, unknown>),
    );
  },

  async redemptionsCount(
    state?: VoucherRedemptionRow['state'],
    search?: string,
  ): Promise<number> {
    try {
      const where: string[] = [];
      // v45 (round-53): op-sqlite 11 types execute() params as Scalar[]
      const params: (string | number | boolean | null)[] = [];
      if (state != null) {
        where.push('state = ?');
        params.push(state);
      }
      if (search && search.trim().length > 0) {
        where.push(
          '(pos_receipt_ref LIKE ? OR reference_code LIKE ? OR campaign_name LIKE ? OR payload LIKE ?)',
        );
        const needle = `%${search.trim()}%`;
        params.push(needle, needle, needle, needle);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt FROM voucher_redemptions ${whereSql}`,
        params,
      );
      const row = result.rows?.[0] as {cnt?: number} | undefined;
      return Number(row?.cnt ?? 0);
    } catch {
      return 0;
    }
  },

  async byReceiptRef(receiptRef: string): Promise<VoucherRedemptionRow | null> {
    const result = await getDb().execute(
      'SELECT * FROM voucher_redemptions WHERE pos_receipt_ref = ? LIMIT 1',
      [receiptRef],
    );
    const row = result.rows?.[0];
    return row ? rowToRedemption(row as Record<string, unknown>) : null;
  },

  async byId(localId: number): Promise<VoucherRedemptionRow | null> {
    const result = await getDb().execute(
      'SELECT * FROM voucher_redemptions WHERE local_id = ? LIMIT 1',
      [localId],
    );
    const row = result.rows?.[0];
    return row ? rowToRedemption(row as Record<string, unknown>) : null;
  },

  /** v20 reports: redemptions that LANDED in a local-date range —
   *  the store's «مبيعات القسائم بالفترة» (server-stated values,
   *  state='ok' only: a failed redemption is not a sale). The
   *  v19 UTC→local discipline: redeemed_at is a UTC ISO stamp, the
   *  boundaries are LOCAL days — 'localtime' keeps after-midnight
   *  redemptions in the right day.
   *  v21 (round-27 #1): ACTIVE-IN-STORE campaigns only — the sales
   *  of a campaign the merchant disabled no longer count in the
   *  period reports (it is not committed to it in this store).
   *  v22 (round-28 #4): the accounting set is the ACTIVATED
   *  campaigns (active + completed) — completed keeps counting. */
  async okInRange(
    from: string,
    to: string,
  ): Promise<{count: number; valueMinor: number; counterExtraMinor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT
           COUNT(*) AS cnt,
           COALESCE(SUM(vr.value_minor), 0) AS value_minor,
           COALESCE(SUM(vr.counter_extra_minor), 0) AS counter_extra
         FROM voucher_redemptions vr
         WHERE vr.state = 'ok'
           AND EXISTS (
             SELECT 1 FROM campaign_debts cd
             WHERE cd.campaign_id = vr.campaign_id
               AND cd.store_state IN ('active','completed')
           )
           AND date(vr.redeemed_at, 'localtime') >= ?
           AND date(vr.redeemed_at, 'localtime') <= ?`,
        [from, to],
      );
      const row = (result.rows?.[0] ?? {}) as {
        cnt?: number | null;
        value_minor?: number | null;
        counter_extra?: number | null;
      };
      return {
        count: Number(row.cnt ?? 0),
        valueMinor: Number(row.value_minor ?? 0),
        counterExtraMinor: Number(row.counter_extra ?? 0),
      };
    } catch {
      return {count: 0, valueMinor: 0, counterExtraMinor: 0};
    }
  },

  // ── campaign_debts (server-truth mirror) ──────────────────────

  /** Writes a campaign row from the REDEMPT answer's settlement
   *  snapshot (§4.1) — merges into whatever the settlements feed
   *  already knew (the redeem snapshot carries the four core
   *  figures; the feed's extra columns survive the merge).
   *  v22 (round-28 #4): a REAL redemption is a commitment the صلة
   *  server already booked against this store — an 'available'
   *  campaign becomes 'active' (the claim can never hide from the
   *  books), but a COMPLETED campaign stays completed forever: the
   *  one-way lifecycle is never walked backwards. */
  async applyRedeemSnapshot(
    campaignId: string,
    campaignName: string,
    kind: string,
    settlement: SilaVoucherRedeemResult['settlement'],
  ): Promise<void> {
    await getDb().execute(
      `INSERT INTO campaign_debts (
        campaign_id, campaign_name, kind,
        redeemed_value_minor, settled_minor, due_minor, settlement_state,
        last_redemption_at, updated_at, store_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
      ON CONFLICT(campaign_id) DO UPDATE SET
        campaign_name = excluded.campaign_name,
        kind = COALESCE(NULLIF(excluded.kind, ''), campaign_debts.kind),
        redeemed_value_minor = excluded.redeemed_value_minor,
        settled_minor = excluded.settled_minor,
        due_minor = excluded.due_minor,
        settlement_state = excluded.settlement_state,
        last_redemption_at = excluded.last_redemption_at,
        updated_at = excluded.updated_at,
        store_state = CASE
          WHEN campaign_debts.store_state = 'completed' THEN 'completed'
          ELSE 'active' END`,
      [
        campaignId,
        campaignName,
        kind,
        settlement.redeemed_value_minor,
        settlement.settled_minor,
        settlement.due_minor,
        settlement.state,
        new Date().toISOString(),
      ],
    );
  },

  /** Writes a campaign row from the settlements FEED (§4.2) — the
   *  full picture including pending/confirmed split, period and
   *  merchant status. Returns the previous state so the caller can
   *  fire the partial→full notification (§6).
   *  v22 (round-28 #4): a feed-discovered campaign starts
   *  'available' — the merchant must consciously ACTIVATE it in his
   *  store before it can be redeemed here; the UPDATE never touches
   *  the merchant's lifecycle state (available/active/completed
   *  survives every sync, relink and backup restore as is). */
  async upsertCampaignFromFeed(
    server: SilaCampaignServerRow,
  ): Promise<CampaignDebtRow | null> {
    const db = getDb();
    const previous = await db.execute(
      'SELECT * FROM campaign_debts WHERE campaign_id = ?',
      [server.campaign_id],
    );
    const before = previous.rows?.[0];
    await db.execute(
      `INSERT INTO campaign_debts (
        campaign_id, campaign_name, kind, campaign_status, merchant_status,
        starts_at, ends_at, redeemed_count, redeemed_value_minor,
        settled_minor, settled_pending_minor, settled_confirmed_minor,
        due_minor, settlement_state, last_redemption_at,
        last_settlement_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(campaign_id) DO UPDATE SET
        campaign_name = excluded.campaign_name,
        kind = excluded.kind,
        campaign_status = excluded.campaign_status,
        merchant_status = excluded.merchant_status,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        redeemed_count = excluded.redeemed_count,
        redeemed_value_minor = excluded.redeemed_value_minor,
        settled_minor = excluded.settled_minor,
        settled_pending_minor = excluded.settled_pending_minor,
        settled_confirmed_minor = excluded.settled_confirmed_minor,
        due_minor = excluded.due_minor,
        settlement_state = excluded.settlement_state,
        last_redemption_at = excluded.last_redemption_at,
        last_settlement_at = excluded.last_settlement_at,
        updated_at = excluded.updated_at`,
      [
        server.campaign_id,
        server.campaign_name,
        server.kind,
        server.campaign_status,
        server.merchant_status,
        server.starts_at,
        server.ends_at,
        server.redeemed_count,
        server.redeemed_value_minor,
        server.settled_minor,
        server.settled_pending_minor,
        server.settled_confirmed_minor,
        server.due_minor,
        server.settlement_state,
        server.last_redemption_at,
        server.last_settlement_at,
      ],
    );
    return before ? rowToCampaign(before as Record<string, unknown>) : null;
  },

  /** v22 (round-28 #4): ACTIVATE a campaign in this store —
   *  ONE-WAY (available → active) and guarded at the SQL level:
   *  an already-active/completed campaign can NEVER be activated
   *  twice (returns false when the guard rejects the move). Once
   *  active, its dues/settlements enter the books and the POS cart
   *  shows the قسيمة button. */
  async activateCampaign(campaignId: string): Promise<boolean> {
    const result = await getDb().execute(
      `UPDATE campaign_debts SET store_state = 'active'
       WHERE campaign_id = ? AND store_state = 'available'`,
      [campaignId],
    );
    const changed = Number(result.rowsAffected ?? 0) > 0;
    if (changed) {
      logDiag(
        'sila',
        `فُعّلت الحملة ${campaignId} في المتجر — تُحتسب مستحقاتها وتسوياتها`,
      );
    }
    return changed;
  },

  /** v22 (round-28 #4): COMPLETE a campaign — ONE-WAY (active →
   *  completed) and SQL-guarded (a completed campaign can't be
   *  completed again; an available one can't jump to completed).
   *  The row keeps mirroring the server and its standing dues stay
   *  in the books exactly as they were («تبقى محفوظة كما هي») —
   *  only the POS cart's قسيمة button stops counting it. */
  async completeCampaign(campaignId: string): Promise<boolean> {
    const result = await getDb().execute(
      `UPDATE campaign_debts SET store_state = 'completed'
       WHERE campaign_id = ? AND store_state = 'active'`,
      [campaignId],
    );
    const changed = Number(result.rowsAffected ?? 0) > 0;
    if (changed) {
      logDiag(
        'sila',
        `أُنهيت الحملة ${campaignId} في المتجر (مكتملة) — بياناتها ومستحقاتها القائمة تبقى محفوظة كما هي، وزر القسيمة يختفي من سلة البيع`,
      );
    }
    return changed;
  },

  /** v22 (round-28 #4) → v25 (round-32 #2): how many campaigns
   *  drive the POS cart's قسيمة button. THREE changes:
   *   1. KIND filter — PURCHASE-COUPON campaigns only. Parcel
   *      campaigns NEVER show the cart button (they redeem from the
   *      القسائم tab's parcel button only — no mixing, the
   *      merchant's round-31 rule).
   *   2. Status robustness — the merchant ACTIVATED the campaign in
   *      his store (store_state='active'), so the button must appear
   *      regardless of the server's status vocabulary. Only clearly
   *      DEAD statuses (ended/completed/cancelled/archived) hide it.
   *   3. v25 (round-32 #2): TITLE-based classification — the type is
   *      read from the campaign TITLE first («قسيمة شرائية _» →
   *      purchase, «طرد …» → parcel), the institution's naming
   *      convention the merchant himself pointed out. The server's
   *      kind field is the fallback, and a kind-less untitled row
   *      defaults to purchase. This makes the button's presence
   *      correct the moment the feed lands — no delay, no misses. */
  async activeCampaignsCount(): Promise<number> {
    try {
      const result = await getDb().execute(
        `SELECT campaign_name, kind FROM campaign_debts
         WHERE store_state = 'active'
           AND LOWER(COALESCE(campaign_status, 'active')) NOT IN
               ('ended', 'completed', 'cancelled', 'canceled',
                'archived', 'inactive')`,
      );
      const rows = (result.rows ?? []) as {
        campaign_name?: string | null;
        kind?: string | null;
      }[];
      return rows.filter(
        row => classifyCampaignKind(row.kind, row.campaign_name) === 'voucher',
      ).length;
    } catch {
      return 0;
    }
  },

  /** The campaigns list for «مستحقات الحملات» — ACTIVE first, then
   *  COMPLETED (their standing dues stay in the books), then the
   *  AVAILABLE ones the merchant may still activate. Unpaid first
   *  within each group. */
  async campaigns(): Promise<CampaignDebtRow[]> {
    const result = await getDb().execute(
      `SELECT * FROM campaign_debts
       ORDER BY CASE store_state
                  WHEN 'active' THEN 0
                  WHEN 'completed' THEN 1
                  ELSE 2 END,
                due_minor DESC, updated_at DESC`,
    );
    return (result.rows ?? []).map(row =>
      rowToCampaign(row as Record<string, unknown>),
    );
  },

  /** Σ server-stated figures for the ACTIVATED campaigns (§4.2
   *  totals.due_minor mirrors this; computed from the mirrored rows
   *  so it also works offline). v22 (round-28 #2/#4): the accounting
   *  set is 'active' + 'completed' — a completed campaign's standing
   *  dues stay in the books exactly as they were, and only the POS
   *  cart's قسيمة button drops it. 'available' campaigns never count
   *  (the merchant is not committed to them in this store).
   *  - dueMinor          → the part added to الدين القائم (المستحق).
   *  - settledMinorTotal → the part added to النقد بالخزينة (المستلم). */
  async campaignsTotals(): Promise<{
    dueMinor: number;
    redeemedMinor: number;
    settledMinorTotal: number;
    settledConfirmedMinor: number;
    settledPendingMinor: number;
    campaignsCount: number;
    activeCount: number;
    completedCount: number;
    fullCount: number;
  }> {
    try {
      const result = await getDb().execute(
        `SELECT
           COUNT(*) AS campaigns_count,
           COALESCE(SUM(due_minor), 0) AS due_minor,
           COALESCE(SUM(redeemed_value_minor), 0) AS redeemed_minor,
           COALESCE(SUM(settled_minor), 0) AS settled_total,
           COALESCE(SUM(settled_confirmed_minor), 0) AS settled_confirmed,
           COALESCE(SUM(settled_pending_minor), 0) AS settled_pending,
           SUM(CASE WHEN store_state = 'active' THEN 1 ELSE 0 END) AS active_count,
           SUM(CASE WHEN store_state = 'completed' THEN 1 ELSE 0 END) AS completed_count,
           SUM(CASE WHEN settlement_state = 'full' THEN 1 ELSE 0 END) AS full_count
         FROM campaign_debts
         WHERE store_state IN ('active','completed')`,
      );
      const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
      return {
        dueMinor: Number(row.due_minor ?? 0),
        redeemedMinor: Number(row.redeemed_minor ?? 0),
        settledMinorTotal: Number(row.settled_total ?? 0),
        settledConfirmedMinor: Number(row.settled_confirmed ?? 0),
        settledPendingMinor: Number(row.settled_pending ?? 0),
        campaignsCount: Number(row.campaigns_count ?? 0),
        activeCount: Number(row.active_count ?? 0),
        completedCount: Number(row.completed_count ?? 0),
        fullCount: Number(row.full_count ?? 0),
      };
    } catch {
      return {
        dueMinor: 0,
        redeemedMinor: 0,
        settledMinorTotal: 0,
        settledConfirmedMinor: 0,
        settledPendingMinor: 0,
        campaignsCount: 0,
        activeCount: 0,
        completedCount: 0,
        fullCount: 0,
      };
    }
  },

  // ── campaign_settlements (feed mirror) ────────────────────────

  /** Mirrors the settlements[] entries of one campaign (§4.2 — last
   *  20 per campaign, newest first). Returns the entries that were
   *  NEW (never mirrored before) so the caller can notify «تسوية
   *  جديدة وصلت» (§6 — one clear notification, not per change). */
  async upsertSettlements(
    campaignId: string,
    campaignName: string,
    entries: SilaCampaignServerRow['settlements'],
  ): Promise<SilaCampaignServerRow['settlements']> {
    const fresh: SilaCampaignServerRow['settlements'] = [];
    const db = getDb();
    for (const entry of entries ?? []) {
      try {
        const known = await db.execute(
          'SELECT 1 AS hit FROM campaign_settlements WHERE settlement_id = ?',
          [entry.settlement_id],
        );
        const existed = (known.rows?.length ?? 0) > 0;
        await db.execute(
          `INSERT INTO campaign_settlements (
            settlement_id, campaign_id, campaign_name, amount_minor,
            kind, status, method, reference, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(settlement_id) DO UPDATE SET
            status = excluded.status,
            amount_minor = excluded.amount_minor,
            kind = excluded.kind,
            method = excluded.method,
            reference = excluded.reference`,
          [
            entry.settlement_id,
            campaignId,
            campaignName,
            entry.amount_minor,
            entry.kind,
            entry.status,
            entry.method,
            entry.reference,
            entry.created_at,
          ],
        );
        if (!existed) {
          fresh.push(entry);
        }
      } catch (error) {
        logDiag(
          'sila',
          `تعذر تخزين تسوية ${entry.settlement_id}: ${toMessage(error)}`,
          'warn',
        );
      }
    }
    return fresh;
  },

  /** v20 reports: settlements CONFIRMED in a local-date range —
   *  «تحصيلات الحملات بالفترة» (money actually received from the
   *  institutions; pending ones appear on the campaigns screen
   *  until the merchant confirms receipt in the Sila app). The
   *  server's created_at is a UTC stamp — 'localtime' keeps the
   *  v19 after-midnight discipline.
   *  v21 (round-27 #1): ACTIVE-IN-STORE campaigns only — an
   *  inactive campaign's settlements never enter the books.
   *  v22 (round-28 #4): the ACTIVATED set (active + completed). */
  async settlementsConfirmedInRange(
    from: string,
    to: string,
  ): Promise<{count: number; minor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(cs.amount_minor), 0) AS minor
         FROM campaign_settlements cs
         WHERE cs.status = 'confirmed'
           AND EXISTS (
             SELECT 1 FROM campaign_debts cd
             WHERE cd.campaign_id = cs.campaign_id
               AND cd.store_state IN ('active','completed')
           )
           AND date(cs.created_at, 'localtime') >= ?
           AND date(cs.created_at, 'localtime') <= ?`,
        [from, to],
      );
      const row = (result.rows?.[0] ?? {}) as {
        cnt?: number | null;
        minor?: number | null;
      };
      return {count: Number(row.cnt ?? 0), minor: Number(row.minor ?? 0)};
    } catch {
      return {count: 0, minor: 0};
    }
  },

  /** v22 (round-28 #2): settlements RECEIVED in a local-date range
   *  — «المستلم من الحملات بالفترة» — the server-truth settled
   *  amount (pending + confirmed; cancelled/disputed excluded, the
   *  server is the reference §6) that entered the treasury. Feeds
   *  the reports' collected-cash figure exactly like the campaign
   *  card's «مستلم» row. ACTIVATED campaigns only (active +
   *  completed). */
  async settlementsReceivedInRange(
    from: string,
    to: string,
  ): Promise<{count: number; minor: number}> {
    try {
      const result = await getDb().execute(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(cs.amount_minor), 0) AS minor
         FROM campaign_settlements cs
         WHERE cs.status NOT IN ('cancelled','disputed')
           AND EXISTS (
             SELECT 1 FROM campaign_debts cd
             WHERE cd.campaign_id = cs.campaign_id
               AND cd.store_state IN ('active','completed')
           )
           AND date(cs.created_at, 'localtime') >= ?
           AND date(cs.created_at, 'localtime') <= ?`,
        [from, to],
      );
      const row = (result.rows?.[0] ?? {}) as {
        cnt?: number | null;
        minor?: number | null;
      };
      return {count: Number(row.cnt ?? 0), minor: Number(row.minor ?? 0)};
    } catch {
      return {count: 0, minor: 0};
    }
  },

  /** v22 (round-28 #1): updates the counter-extra figure on a
   *  redemption row whose sale was booked AFTER the cashier topped
   *  the cart up (the deferred completion path — the snapshot at
   *  redeem time was smaller than the voucher). */
  async updateCounterExtra(
    localId: number,
    counterExtraMinor: number,
  ): Promise<void> {
    await getDb().execute(
      'UPDATE voucher_redemptions SET counter_extra_minor = ? WHERE local_id = ?',
      [Math.max(0, counterExtraMinor), localId],
    );
  },

  /** v43 (الجولة 51 #3): عمليات الصرف المكتملة على الخادم (state='ok')
   *  والمقيّدة بسلة (cart_json) التي لم تُنشأ لها فاتورة بضاعة بعد
   *  (sale_id IS NULL) — قسائم شرائية فقط (المصنِّف الموحّد بالعنوان
   *  أولاً). هذه هي لافتات الإتمام في نقطة البيع: تشمل (١) قسائم
   *  «أكمل السلة» التي كانت تُفقد إلى الأبد بإغلاق التطبيق (كانت
   *  state في الذاكرة فقط)، و(٢) العمليات التي فشل فيها إنشاء
   *  فاتورة البضاعة بعد نجاح الصرف — بلاغ التاجر: القيمة دخلت
   *  ديون الحملات ولم تدخل مبيعات اليوم. المتصل يستبني ما ألغاه
   *  التاجر صراحة (مجموعة MMKV). */
  async incompleteCartRedemptions(): Promise<VoucherRedemptionRow[]> {
    try {
      const result = await getDb().execute(
        `SELECT * FROM voucher_redemptions
         WHERE state = 'ok' AND sale_id IS NULL AND cart_json IS NOT NULL
         ORDER BY redeemed_at ASC, local_id ASC`,
      );
      return (result.rows ?? [])
        .map(row => rowToRedemption(row as Record<string, unknown>))
        .filter(
          row =>
            row.cart_json != null &&
            row.cart_json.length > 2 &&
            classifyCampaignKind(row.campaign_kind, row.campaign_name) ===
              'voucher',
        );
    } catch {
      return [];
    }
  },

  /** Latest mirrored settlements across campaigns (for the screen).
   *  v22 (round-28 #4): ACTIVATED campaigns only (active +
   *  completed — a completed campaign's settlements still arrive
   *  and still count). */
  async recentSettlements(limit: number): Promise<CampaignSettlementRow[]> {
    try {
      const result = await getDb().execute(
        `SELECT cs.* FROM campaign_settlements cs
         WHERE EXISTS (
           SELECT 1 FROM campaign_debts cd
           WHERE cd.campaign_id = cs.campaign_id
             AND cd.store_state IN ('active','completed')
         )
         ORDER BY cs.created_at DESC LIMIT ?`,
        [limit],
      );
      return (result.rows ?? []).map(row =>
        rowToSettlement(row as Record<string, unknown>),
      );
    } catch {
      return [];
    }
  },
};
