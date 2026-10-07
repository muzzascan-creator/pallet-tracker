// Database layer: SQLite via Node's built-in node:sqlite (Node 22.13+), no installs needed.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// On Render, a disk mounted at /var/data is used automatically when present.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'pallets.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operator')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Customer master file. "code" is what the barcode contains.
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Pallet ledger. delta is the effect on what the customer owes us:
--   delivered (we leave pallets with them)   delta = +qty
--   collected (we pick pallets up from them) delta = -qty
--   adjust    (opening balance / correction)  delta = signed qty
-- Rows are never deleted; mistakes are voided so the history stays auditable.
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL CHECK (type IN ('delivered','collected','adjust')),
  qty INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_mov_customer ON movements(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mov_created ON movements(created_at);

-- Pallet control sheet (reconciliation) saved by an admin for a period. Counts are kept as JSON.
CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY,
  period_from TEXT NOT NULL,          -- YYYY-MM-DD (first day of the period)
  period_to TEXT NOT NULL,            -- YYYY-MM-DD (last day of the period)
  data TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

// Migrations for databases created before a column existed
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('customers').includes('tx')) db.exec('ALTER TABLE customers ADD COLUMN tx INTEGER NOT NULL DEFAULT 0'); // "TX Customer" tick box

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

// First run: create an admin account so someone can log in.
function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;
  const password = process.env.ADMIN_PASSWORD || 'admin';
  db.prepare(`INSERT INTO users (username, name, role, password_hash, must_change_password)
              VALUES ('admin', 'Administrator', 'admin', ?, 1)`).run(hashPassword(password));
  return password;
}

// Forgotten admin password: set ADMIN_RESET_PASSWORD on the host and restart. The 'admin' login
// gets that password (applied once per value), then the variable should be removed again.
function applyAdminReset() {
  const pw = process.env.ADMIN_RESET_PASSWORD;
  if (!pw) return false;
  if (pw.length < 6) { console.warn('ADMIN_RESET_PASSWORD must be at least 6 characters; ignored.'); return false; }
  const marker = path.join(DATA_DIR, '.admin-reset');
  const tag = crypto.createHash('sha256').update(pw).digest('hex');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === tag) return false;
  const r = db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, active = 1 WHERE username = 'admin'`).run(hashPassword(pw));
  db.prepare(`DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'admin')`).run();
  fs.writeFileSync(marker, tag);
  return r.changes > 0;
}

module.exports = { db, DATA_DIR, hashPassword, verifyPassword, ensureAdmin, applyAdminReset };
