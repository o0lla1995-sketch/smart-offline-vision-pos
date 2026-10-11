/**
 * op-sqlite shim for Jest — runs the REAL app SQL (DDL + migrations +
 * repositories + services) against Node's built-in node:sqlite engine.
 *
 * Interface parity with @op-engineering/op-sqlite v8 (as used by the app):
 *   open({name})                     → DB wrapper
 *   db.execute(sql, params?)         → { rows: Record<string,unknown>[], insertId, rowsAffected }
 *   db.transaction(async tx => ...)  → BEGIN/COMMIT/ROLLBACK discipline
 *
 * The DB path is taken from globalThis.__SELA_DB_PATH (set by tests):
 * ':memory:' (default) for fresh isolated runs, or a temp FILE path for
 * upgrade-path tests that must pre-create an OLD schema shape.
 */
'use strict';

const {DatabaseSync} = require('node:sqlite');

const READER_RE = /^\s*(select|pragma|with|explain)\b/i;

class Shim {
  constructor(raw) {
    this.__raw = raw;
  }

  execute(sql, params) {
    const raw = this.__raw;
    const args = (params ?? []).map(p => (p === undefined ? null : p));
    const stmt = raw.prepare(sql);
    if (READER_RE.test(sql)) {
      const rows = stmt.all(...args);
      return {
        rows,
        insertId: undefined,
        rowsAffected: 0,
      };
    }
    const info = stmt.run(...args);
    return {
      rows: [],
      insertId:
        info.lastInsertRowid == null ? undefined : Number(info.lastInsertRowid),
      rowsAffected: Number(info.changes ?? 0),
    };
  }

  async transaction(fn) {
    const raw = this.__raw;
    raw.exec('BEGIN IMMEDIATE');
    try {
      const tx = {
        execute: (sql, params) => this.execute(sql, params),
      };
      const out = await fn(tx);
      raw.exec('COMMIT');
      return out;
    } catch (error) {
      try {
        raw.exec('ROLLBACK');
      } catch {
        // Connection-level failure — surface the original error.
      }
      throw error;
    }
  }

  close() {
    try {
      this.__raw.close();
    } catch {
      // Already closed.
    }
  }
}

function open(options) {
  const path =
    (options && options.path) ||
    globalThis.__SELA_DB_PATH ||
    ':memory:';
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON;');
  return new Shim(raw);
}

module.exports = {
  open,
  __Shim: Shim,
};
