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
    done(0, 'Smoke test passed');
  } catch (err) { done(1, err.message); }
});
