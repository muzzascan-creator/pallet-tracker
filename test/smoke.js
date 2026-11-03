// Smoke test: syntax-check the front end, boot the server on a throwaway data dir, and load the app.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
for (const f of ['server.js', 'db.js', 'seed-demo.js', 'public/app.js']) execFileSync(process.execPath, ['--check', path.join(root, f)]);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pallet-test-'));
const port = 3900 + Math.floor(Math.random() * 100);
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: 'test-password' }, stdio: ['ignore', 'pipe', 'inherit'],
});
const done = (code, msg) => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); console[code ? 'error' : 'log'](msg); process.exit(code); };
setTimeout(() => done(1, 'Server did not start within 10s'), 10000).unref();
server.on('exit', (code) => done(1, `Server exited early (code ${code})`));
server.stdout.on('data', async (chunk) => {
  if (!String(chunk).includes('running on')) return;
  server.removeAllListeners('exit');
  try {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.text();
    if (res.status !== 200 || !body.includes('app.js')) throw new Error(`GET / returned ${res.status}`);
    await checkUniqueCid();
    done(0, 'Smoke test passed');
  } catch (err) { done(1, err.message); }
});

// CIDs must be unique across customers: adding, editing and importing all refuse a duplicate.
async function checkUniqueCid() {
  const base = `http://localhost:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const expect = (ok, what) => { if (!ok) throw new Error('CID check failed: ' + what); };

  const a = await call('POST', '/api/admin/customers', { code: 'A100', name: 'Alpha' });
  expect(a.status === 201, 'add first customer');
  const n = await call('POST', '/api/admin/customers', { code: '1034', name: 'Numeric' });
  expect(n.status === 201, 'add numeric customer');
  for (const code of ['A100', 'a100', ' A100 ', '01034']) {
    const r = await call('POST', '/api/admin/customers', { code, name: 'Dup' });
    expect(r.status === 400 && /already used/.test(r.body.error), `add with duplicate CID "${code}"`);
  }
  const b = await call('POST', '/api/admin/customers', { code: 'B200', name: 'Bravo' });
  const e = await call('PUT', '/api/admin/customers/' + b.body.customer.id, { code: 'a100', name: 'Bravo' });
  expect(e.status === 400 && /already used by Alpha/.test(e.body.error), 'edit to a duplicate CID');
  const self = await call('PUT', '/api/admin/customers/' + a.body.customer.id, { code: 'A100', name: 'Alpha renamed' });
  expect(self.status === 200, 'edit keeping its own CID');

  const imp = await call('POST', '/api/admin/customers/import', { rows: [
    { code: 'A100', name: 'Alpha updated' }, // existing CID: updates Alpha
    { cid: 'C300', name: 'Charlie' },        // "CID" column works too
    { code: 'D400', name: 'Delta one' }, { code: 'd400', name: 'Delta two' }, // duplicate inside the file
    { code: '001034', name: 'Clash' },       // same CID as 1034 once zeros are ignored
  ] });
  expect(imp.status === 200 && imp.body.created === 1 && imp.body.updated === 1, `import counts ${JSON.stringify(imp.body)}`);
  expect(imp.body.errors.length === 3 && imp.body.errors.every((x) => /CID/.test(x)), `import errors ${JSON.stringify(imp.body.errors)}`);
  const list = await call('GET', '/api/customers?all=1');
  const codes = list.body.customers.map((c) => c.code).sort();
  expect(JSON.stringify(codes) === JSON.stringify(['1034', 'A100', 'B200', 'C300']), 'customers after import ' + codes);
}
