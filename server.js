// Pallet tracking server. Plain Node (22.13+), no npm packages required.
//   node server.js            -> http://localhost:3000
// Env: PORT, DATA_DIR, ADMIN_PASSWORD (first run only)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, hashPassword, verifyPassword, ensureAdmin, applyAdminReset } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 14;
const MAX_QTY = 100000;

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) throw bad('Expected JSON');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw bad('Invalid JSON'); }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
function int(v, { min = 0, max = MAX_QTY, name = 'value' } = {}) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`);
  return n;
}
function isoOrNull(v, name) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) throw bad(`Invalid ${name}`);
  return d.toISOString();
}

// ---------- auth ----------
const failedLogins = new Map(); // key -> { count, until }

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.role, u.must_change_password, u.active, s.expires_at
                          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || !row.active || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role, mustChangePassword: !!row.must_change_password, token };
}

function cookie(req, value, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

// ---------- queries ----------
const BALANCE_SQL = `
  SELECT c.id, c.code, c.name, c.address, c.phone, c.email, c.notes, c.active,
         COALESCE(SUM(CASE WHEN m.voided_at IS NULL THEN m.delta END), 0) AS balance,
         COALESCE(SUM(CASE WHEN m.voided_at IS NULL AND m.type='delivered' THEN m.qty END), 0) AS total_delivered,
         COALESCE(SUM(CASE WHEN m.voided_at IS NULL AND m.type='collected' THEN m.qty END), 0) AS total_collected,
         MAX(CASE WHEN m.voided_at IS NULL THEN m.created_at END) AS last_activity
  FROM customers c LEFT JOIN movements m ON m.customer_id = c.id`;

const MOVEMENT_SQL = `
  SELECT m.id, m.customer_id, c.code AS customer_code, c.name AS customer_name, m.type, m.qty, m.delta,
         m.reference, m.note, m.user_id, u.name AS user_name, m.created_at,
         m.voided_at, m.void_reason, vu.name AS voided_by_name
  FROM movements m
  JOIN customers c ON c.id = m.customer_id
  JOIN users u ON u.id = m.user_id
  LEFT JOIN users vu ON vu.id = m.voided_by`;

function customerWithBalance(id) {
  return db.prepare(`${BALANCE_SQL} WHERE c.id = ? GROUP BY c.id`).get(id);
}
function recentMovements(customerId, limit = 10) {
  return db.prepare(`${MOVEMENT_SQL} WHERE m.customer_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(customerId, limit);
}

function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, opts, handler) => {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });
};

route('POST', '/api/login', { auth: 'none' }, async (req, res) => {
  const { username, password } = await readJson(req);
  const key = `${str(username).toLowerCase()}|${req.socket.remoteAddress}`;
  const f = failedLogins.get(key);
  if (f && f.count >= 5 && f.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(username));
  if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) {
    const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 5 * 60 * 1000 };
    failedLogins.set(key, next);
    throw new HttpError(401, 'Wrong username or password');
  }
  failedLogins.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  send(res, 200, { user: { id: user.id, username: user.username, name: user.name, role: user.role, mustChangePassword: !!user.must_change_password } },
    { 'Set-Cookie': cookie(req, token, SESSION_DAYS * 86400) });
});

route('POST', '/api/logout', { auth: 'none' }, async (req, res) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
});

route('GET', '/api/me', (req, res, { user }) => {
  const { token, ...u } = user;
  send(res, 200, { user: u });
});

route('POST', '/api/me/password', async (req, res, { user }) => {
  const { current, next } = await readJson(req);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(String(current || ''), row.password_hash)) throw bad('Current password is wrong');
  if (String(next || '').length < 6) throw bad('New password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(String(next)), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, user.token);
  send(res, 200, { ok: true });
});

// --- operator + admin ---
route('GET', '/api/lookup', (req, res, { query }) => {
  const code = str(query.get('code'));
  if (!code) throw bad('No code');
  // Exact match first; then ignore leading zeros, since barcodes often pad numbers (e.g. 0001034 for 1034).
  const c = db.prepare('SELECT id FROM customers WHERE code = ?').get(code)
    || (/^\d+$/.test(code) ? db.prepare(`SELECT id FROM customers WHERE ltrim(code, '0') = ltrim(?, '0')`).get(code) : null);
  if (!c) throw new HttpError(404, `No customer found for code "${code}"`);
  send(res, 200, { customer: customerWithBalance(c.id), recent: recentMovements(c.id, 5) });
});

route('GET', '/api/customers/:id', (req, res, { params }) => {
  const customer = customerWithBalance(Number(params.id));
  if (!customer) throw new HttpError(404, 'Customer not found');
  send(res, 200, { customer, recent: recentMovements(customer.id, 5) });
});

route('GET', '/api/customers', (req, res, { query, user }) => {
  const q = str(query.get('q'));
  const like = `%${q}%`;
  const activeOnly = user.role !== 'admin' || query.get('all') !== '1';
  const rows = db.prepare(`${BALANCE_SQL}
    WHERE (? = '' OR c.name LIKE ? OR c.code LIKE ?) ${activeOnly ? 'AND c.active = 1' : ''}
    GROUP BY c.id ORDER BY balance DESC, c.name`).all(q, like, like);
  send(res, 200, { customers: rows });
});

route('POST', '/api/movements', async (req, res, { user }) => {
  const body = await readJson(req);
  const customer = db.prepare('SELECT id, active FROM customers WHERE id = ?').get(Number(body.customer_id));
  if (!customer) throw bad('Unknown customer');
  if (!customer.active) throw bad('This customer is inactive');
  const delivered = int(body.delivered, { name: 'Delivered' });
  const collected = int(body.collected, { name: 'Picked up' });
  const reference = str(body.reference, 100), note = str(body.note, 500);
  if (!delivered && !collected) throw bad('Enter pallets delivered or picked up');
  const ins = db.prepare(`INSERT INTO movements (customer_id, type, qty, delta, reference, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const ids = transaction(() => {
    const out = [];
    if (delivered) out.push(Number(ins.run(customer.id, 'delivered', delivered, delivered, reference, note, user.id).lastInsertRowid));
    if (collected) out.push(Number(ins.run(customer.id, 'collected', collected, -collected, reference, note, user.id).lastInsertRowid));
    return out;
  });
  send(res, 201, { ids, customer: customerWithBalance(customer.id), recent: recentMovements(customer.id, 5) });
});

route('GET', '/api/movements/mine', (req, res, { user }) => {
  const rows = db.prepare(`${MOVEMENT_SQL} WHERE m.user_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 30`).all(user.id);
  send(res, 200, { movements: rows });
});

route('POST', '/api/movements/:id/void', async (req, res, { user, params }) => {
  const { reason } = await readJson(req);
  const m = db.prepare('SELECT * FROM movements WHERE id = ?').get(Number(params.id));
  if (!m) throw new HttpError(404, 'Entry not found');
  if (m.voided_at) throw bad('Entry is already cancelled');
  if (user.role !== 'admin') throw new HttpError(403, 'Only an admin can cancel entries.');
  db.prepare(`UPDATE movements SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ? WHERE id = ?`)
    .run(user.id, str(reason, 200) || 'Cancelled by admin', m.id);
  send(res, 200, { ok: true, customer: customerWithBalance(m.customer_id) });
});

// --- admin: summary ---
route('GET', '/api/admin/summary', { auth: 'admin' }, (req, res, { query }) => {
  const since = isoOrNull(query.get('since'), 'since') || new Date(Date.now() - 864e5).toISOString();
  const totals = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN voided_at IS NULL THEN delta END),0) AS total_owed,
      COALESCE(SUM(CASE WHEN voided_at IS NULL AND type='delivered' AND created_at >= ? THEN qty END),0) AS delivered_today,
      COALESCE(SUM(CASE WHEN voided_at IS NULL AND type='collected' AND created_at >= ? THEN qty END),0) AS collected_today
    FROM movements`).get(since, since);
  const counts = db.prepare(`SELECT COUNT(*) AS customers, SUM(CASE WHEN bal > 0 THEN 1 ELSE 0 END) AS owing FROM
      (SELECT c.id, COALESCE(SUM(CASE WHEN m.voided_at IS NULL THEN m.delta END),0) AS bal
       FROM customers c LEFT JOIN movements m ON m.customer_id = c.id WHERE c.active = 1 GROUP BY c.id)`).get();
  const recent = db.prepare(`${MOVEMENT_SQL} ORDER BY m.created_at DESC, m.id DESC LIMIT 15`).all();
  send(res, 200, { ...totals, customers: counts.customers, owing: counts.owing || 0, recent });
});

// --- admin: customers ---
function customerFields(b) {
  const f = { code: str(b.code, 100), name: str(b.name, 200), address: str(b.address, 300), phone: str(b.phone, 50), email: str(b.email, 200), notes: str(b.notes, 500) };
  if (!f.code) throw bad('Customer code (barcode) is required');
  if (!f.name) throw bad('Customer name is required');
  return f;
}

route('POST', '/api/admin/customers', { auth: 'admin' }, async (req, res, { user }) => {
  const b = await readJson(req);
  const f = customerFields(b);
  if (db.prepare('SELECT 1 FROM customers WHERE code = ?').get(f.code)) throw bad(`Code "${f.code}" is already used`);
  const opening = int(b.opening_balance, { min: -MAX_QTY, name: 'Opening balance' });
  const id = transaction(() => {
    const id = Number(db.prepare(`INSERT INTO customers (code, name, address, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(f.code, f.name, f.address, f.phone, f.email, f.notes).lastInsertRowid);
    if (opening) db.prepare(`INSERT INTO movements (customer_id, type, qty, delta, note, user_id) VALUES (?, 'adjust', ?, ?, 'Opening balance', ?)`).run(id, opening, opening, user.id);
    return id;
  });
  send(res, 201, { customer: customerWithBalance(id) });
});

route('PUT', '/api/admin/customers/:id', { auth: 'admin' }, async (req, res, { params }) => {
  const b = await readJson(req);
  const id = Number(params.id);
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw new HttpError(404, 'Customer not found');
  const f = customerFields(b);
  if (db.prepare('SELECT 1 FROM customers WHERE code = ? AND id <> ?').get(f.code, id)) throw bad(`Code "${f.code}" is already used`);
  db.prepare(`UPDATE customers SET code=?, name=?, address=?, phone=?, email=?, notes=?, active=? WHERE id=?`)
    .run(f.code, f.name, f.address, f.phone, f.email, f.notes, b.active === false ? 0 : 1, id);
  send(res, 200, { customer: customerWithBalance(id) });
});

// Import / update the master file. rows: [{code, name, address?, phone?, email?, notes?, opening_balance?}]
// Existing codes are updated; opening balance is only applied to newly created customers.
route('POST', '/api/admin/customers/import', { auth: 'admin' }, async (req, res, { user }) => {
  const { rows } = await readJson(req);
  if (!Array.isArray(rows) || !rows.length) throw bad('No rows to import');
  let created = 0, updated = 0; const errors = [];
  transaction(() => {
    rows.forEach((r, i) => {
      try {
        const f = customerFields(r);
        const existing = db.prepare('SELECT id FROM customers WHERE code = ?').get(f.code);
        if (existing) {
          db.prepare(`UPDATE customers SET name=?, address=COALESCE(NULLIF(?,''),address), phone=COALESCE(NULLIF(?,''),phone),
                      email=COALESCE(NULLIF(?,''),email), notes=COALESCE(NULLIF(?,''),notes) WHERE id=?`)
            .run(f.name, f.address, f.phone, f.email, f.notes, existing.id);
          updated++;
        } else {
          const opening = int(r.opening_balance, { min: -MAX_QTY, name: 'Opening balance' });
          const id = Number(db.prepare(`INSERT INTO customers (code, name, address, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(f.code, f.name, f.address, f.phone, f.email, f.notes).lastInsertRowid);
          if (opening) db.prepare(`INSERT INTO movements (customer_id, type, qty, delta, note, user_id) VALUES (?, 'adjust', ?, ?, 'Opening balance', ?)`).run(id, opening, opening, user.id);
          created++;
        }
      } catch (e) { errors.push(`Row ${i + 2}: ${e.message}`); }
    });
  });
  send(res, 200, { created, updated, errors: errors.slice(0, 50) });
});

// Admin balance correction (e.g. stocktake). qty is signed: + means customer owes more.
route('POST', '/api/admin/adjust', { auth: 'admin' }, async (req, res, { user }) => {
  const b = await readJson(req);
  const id = Number(b.customer_id);
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw bad('Unknown customer');
  const qty = int(b.qty, { min: -MAX_QTY, name: 'Adjustment' });
  if (!qty) throw bad('Adjustment cannot be zero');
  const note = str(b.note, 500);
  if (!note) throw bad('Give a reason for the adjustment');
  db.prepare(`INSERT INTO movements (customer_id, type, qty, delta, reference, note, user_id) VALUES (?, 'adjust', ?, ?, ?, ?, ?)`)
    .run(id, qty, qty, str(b.reference, 100), note, user.id);
  send(res, 201, { customer: customerWithBalance(id) });
});

// --- admin: users ---
route('GET', '/api/admin/users', { auth: 'admin' }, (req, res) => {
  const users = db.prepare(`SELECT u.id, u.username, u.name, u.role, u.active, u.created_at,
      (SELECT MAX(created_at) FROM movements WHERE user_id = u.id) AS last_entry
    FROM users u ORDER BY u.active DESC, u.role, u.name`).all();
  send(res, 200, { users });
});

route('POST', '/api/admin/users', { auth: 'admin' }, async (req, res) => {
  const b = await readJson(req);
  const username = str(b.username, 50), name = str(b.name, 100), role = b.role === 'admin' ? 'admin' : 'operator';
  if (!/^[A-Za-z0-9._-]{2,50}$/.test(username)) throw bad('Username: 2-50 letters, numbers, dot, dash or underscore');
  if (!name) throw bad('Name is required');
  if (String(b.password || '').length < 6) throw bad('Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That username is taken');
  const id = db.prepare(`INSERT INTO users (username, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1)`)
    .run(username, name, role, hashPassword(String(b.password))).lastInsertRowid;
  send(res, 201, { id: Number(id) });
});

route('PUT', '/api/admin/users/:id', { auth: 'admin' }, async (req, res, { user, params }) => {
  const b = await readJson(req);
  const id = Number(params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'User not found');
  const name = str(b.name, 100) || target.name;
  const role = b.role === 'admin' || b.role === 'operator' ? b.role : target.role;
  const active = b.active === undefined ? target.active : (b.active ? 1 : 0);
  if (id === user.id && (role !== 'admin' || !active)) throw bad('You cannot remove your own admin access');
  db.prepare('UPDATE users SET name=?, role=?, active=? WHERE id=?').run(name, role, active, id);
  if (b.password) {
    if (String(b.password).length < 6) throw bad('Password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(hashPassword(String(b.password)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  send(res, 200, { ok: true });
});

// --- admin: reports ---
route('GET', '/api/admin/movements', { auth: 'admin' }, (req, res, { query }) => {
  const from = isoOrNull(query.get('from'), 'from'), to = isoOrNull(query.get('to'), 'to');
  const where = [], args = [];
  if (from) { where.push('m.created_at >= ?'); args.push(from); }
  if (to) { where.push('m.created_at < ?'); args.push(to); }
  if (query.get('customer_id')) { where.push('m.customer_id = ?'); args.push(Number(query.get('customer_id'))); }
  if (query.get('user_id')) { where.push('m.user_id = ?'); args.push(Number(query.get('user_id'))); }
  if (query.get('type')) { where.push('m.type = ?'); args.push(str(query.get('type'))); }
  if (query.get('voided') !== '1') where.push('m.voided_at IS NULL');
  const rows = db.prepare(`${MOVEMENT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.created_at DESC, m.id DESC LIMIT 5000`).all(...args);
  send(res, 200, { movements: rows });
});

// Per-customer opening / delivered / picked up / adjustments / closing for a period.
route('GET', '/api/admin/reports/activity', { auth: 'admin' }, (req, res, { query }) => {
  const from = isoOrNull(query.get('from'), 'from') || '0000', to = isoOrNull(query.get('to'), 'to') || '9999';
  const rows = db.prepare(`
    SELECT c.id, c.code, c.name, c.active,
      COALESCE(SUM(CASE WHEN m.created_at < ? THEN m.delta END),0) AS opening,
      COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.type='delivered' THEN m.qty END),0) AS delivered,
      COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.type='collected' THEN m.qty END),0) AS collected,
      COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.type='adjust' THEN m.delta END),0) AS adjusted,
      COALESCE(SUM(CASE WHEN m.created_at < ? THEN m.delta END),0) AS closing
    FROM customers c LEFT JOIN movements m ON m.customer_id = c.id AND m.voided_at IS NULL
    GROUP BY c.id
    HAVING opening <> 0 OR delivered <> 0 OR collected <> 0 OR adjusted <> 0 OR closing <> 0
    ORDER BY closing DESC, c.name`).all(from, from, to, from, to, from, to, to);
  send(res, 200, { rows });
});

route('GET', '/api/admin/reports/statement', { auth: 'admin' }, (req, res, { query }) => {
  const id = Number(query.get('customer_id'));
  const customer = customerWithBalance(id);
  if (!customer) throw bad('Choose a customer');
  const from = isoOrNull(query.get('from'), 'from') || '0000', to = isoOrNull(query.get('to'), 'to') || '9999';
  const opening = db.prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM movements WHERE customer_id=? AND voided_at IS NULL AND created_at < ?`).get(id, from).n;
  const lines = db.prepare(`${MOVEMENT_SQL} WHERE m.customer_id = ? AND m.voided_at IS NULL AND m.created_at >= ? AND m.created_at < ?
    ORDER BY m.created_at, m.id`).all(id, from, to);
  let running = opening;
  for (const l of lines) l.running = (running += l.delta);
  send(res, 200, { customer, opening, closing: running, lines });
});

// ---------- pallet reconciliation (control sheet) ----------
const RECON_FIELDS = ['opening_owed', 'floor_open', 'rooms_open', 'farm_received', 'direct_suppliers',
  'dehire_chep', 'dehire_harris', 'floor_close', 'rooms_close', 'closing_owed', 'chep_start', 'perf_start'];
const ymdOk = (v, name) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw bad(`Choose the ${name} date`); return v; };
const reconRow = (r) => r && ({ id: r.id, from: r.period_from, to: r.period_to, ...JSON.parse(r.data),
  created_by_name: r.created_by_name, created_at: r.created_at, updated_at: r.updated_at });
const RECON_SQL = `SELECT r.*, u.name AS created_by_name FROM reconciliations r JOIN users u ON u.id = r.created_by`;

// Net pallets customers owe us at a moment (positive = owed to us), from the ledger
route('GET', '/api/admin/recon/owed', { auth: 'admin' }, (req, res, { query }) => {
  const at = isoOrNull(query.get('at'), 'date') || new Date().toISOString();
  const n = db.prepare('SELECT COALESCE(SUM(delta),0) AS n FROM movements WHERE voided_at IS NULL AND created_at < ?').get(at).n;
  send(res, 200, { owed: n });
});

route('GET', '/api/admin/recons', { auth: 'admin' }, (req, res) => {
  send(res, 200, { recons: db.prepare(`${RECON_SQL} ORDER BY r.period_to DESC, r.id DESC`).all().map(reconRow) });
});

route('POST', '/api/admin/recons', { auth: 'admin' }, async (req, res, { user }) => {
  const b = await readJson(req);
  const from = ymdOk(b.from, 'From'), to = ymdOk(b.to, 'To');
  if (to < from) throw bad('The To date is before the From date');
  const data = {};
  for (const k of RECON_FIELDS) {
    const v = b[k];
    data[k] = v === '' || v == null ? null : int(v, { min: -MAX_QTY, name: k.replace(/_/g, ' ') });
  }
  data.note = str(b.note, 500);
  let id = Number(b.id) || null;
  const sameDay = db.prepare('SELECT id FROM reconciliations WHERE period_from = ? AND id <> ?').get(from, id || 0);
  if (sameDay) throw bad('A sheet for this day is already saved');
  if (id) {
    const r = db.prepare('UPDATE reconciliations SET period_from=?, period_to=?, data=?, updated_at=? WHERE id=?')
      .run(from, to, JSON.stringify(data), new Date().toISOString(), id);
    if (!r.changes) throw bad('That sheet no longer exists');
  } else {
    id = Number(db.prepare('INSERT INTO reconciliations (period_from, period_to, data, created_by) VALUES (?, ?, ?, ?)')
      .run(from, to, JSON.stringify(data), user.id).lastInsertRowid);
  }
  send(res, 200, { recon: reconRow(db.prepare(`${RECON_SQL} WHERE r.id = ?`).get(id)) });
});

route('DELETE', '/api/admin/recons/:id', { auth: 'admin' }, (req, res, { params }) => {
  db.prepare('DELETE FROM reconciliations WHERE id = ?').run(Number(params.id));
  send(res, 200, { ok: true });
});

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (pathname === '/' || !path.extname(file)) file = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const user = r.auth === 'none' ? null : currentUser(req);
      if (r.auth !== 'none' && !user) throw new HttpError(401, 'Please log in');
      if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
      return await r.handler(req, res, { user, params, query: url.searchParams });
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error' });
  }
});

const firstPassword = ensureAdmin();
if (applyAdminReset()) console.log('Admin password reset from ADMIN_RESET_PASSWORD. Remove that setting now.');
server.listen(PORT, () => {
  console.log(`Pallet tracker running on http://localhost:${PORT}`);
  if (firstPassword) console.log(`First run: created login "admin" with password "${firstPassword}" (you will be asked to change it).`);
});
