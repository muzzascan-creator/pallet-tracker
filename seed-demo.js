// Loads sample customers, operators and a few weeks of movements so the app can be tried out.
// Only use on an empty/test database:  npm run demo-data
const fs = require('node:fs');
const path = require('node:path');
const { db, hashPassword, ensureAdmin } = require('./db');

ensureAdmin();
if (db.prepare('SELECT COUNT(*) AS n FROM customers').get().n > 0) {
  console.log('Customers already exist; demo data not loaded.');
  process.exit(0);
}
const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
const ops = [['dave', 'Dave Driver'], ['sam', 'Sam Smith']].map(([u, n]) =>
  Number(db.prepare(`INSERT OR IGNORE INTO users (username, name, role, password_hash) VALUES (?, ?, 'operator', ?)`)
    .run(u, n, hashPassword('pallets1')).lastInsertRowid) || db.prepare('SELECT id FROM users WHERE username=?').get(u).id);

const lines = fs.readFileSync(path.join(__dirname, 'sample-master-file.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
const ins = db.prepare(`INSERT INTO movements (customer_id, type, qty, delta, reference, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const start = Date.now() - 35 * 864e5;
let docket = 5000;
db.exec('BEGIN');
for (const line of lines) {
  const [code, name, address, phone, email, opening] = line.split(',');
  const id = Number(db.prepare('INSERT INTO customers (code, name, address, phone, email) VALUES (?, ?, ?, ?, ?)').run(code, name, address, phone, email).lastInsertRowid);
  if (+opening) ins.run(id, 'adjust', +opening, +opening, '', 'Opening balance', admin, new Date(start).toISOString());
  for (let day = 1; day <= 34; day += 2 + Math.floor(Math.random() * 4)) {
    const when = new Date(start + day * 864e5 + (7 + Math.random() * 9) * 36e5).toISOString();
    const by = ops[Math.floor(Math.random() * ops.length)];
    const d = Math.floor(Math.random() * 12), c = Math.floor(Math.random() * 10);
    if (d) ins.run(id, 'delivered', d, d, 'D' + ++docket, '', by, when);
    if (c) ins.run(id, 'collected', c, -c, 'D' + docket, '', by, when);
  }
}
db.exec('COMMIT');
console.log(`Loaded ${lines.length} demo customers. Operators: dave / sam (password "pallets1").`);
