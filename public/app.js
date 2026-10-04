/* Pallet Tracker front end. Plain JS, no build step. */
'use strict';

// ---------- utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();
const view = $('#view');
let me = null, undoMinutes = 30;

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login' && url !== '/api/me/password') { me = null; showLogin(); throw new Error(data.error || 'Please log in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function dt(iso, withTime = true) {
  if (!iso) return '';
  const d = new Date(iso);
  return withTime ? d.toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}
// <input type=date> value (local day) -> ISO instant at local midnight
const dayStart = (v) => v ? new Date(v + 'T00:00:00').toISOString() : '';
const dayAfter = (v) => { if (!v) return ''; const d = new Date(v + 'T00:00:00'); d.setDate(d.getDate() + 1); return d.toISOString(); };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function balanceText(b) {
  if (b > 0) return `owes you ${fmt(b)} pallet${b === 1 ? '' : 's'}`;
  if (b < 0) return `you owe them ${fmt(-b)} pallet${b === -1 ? '' : 's'}`;
  return 'all square';
}
const balCls = (b) => b > 0 ? 'pos' : b < 0 ? 'neg' : '';
const balCell = (b) => `<td class="num bal ${balCls(b)}">${fmt(b)}</td>`;
const typePill = (m) => m.type === 'delivered' ? `<span class="pill delivered">Delivered</span>`
  : m.type === 'collected' ? `<span class="pill collected">Picked up</span>` : `<span class="pill">Adjustment</span>`;
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);

function downloadCSV(filename, columns, rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [columns.map((c) => cell(c.label)).join(',')]
    .concat(rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const modal = $('#modal');
function openModal(html) { $('#modal-body').innerHTML = html; modal.showModal(); return $('#modal-body'); }
function closeModal() { modal.close(); }
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

function formData(form) {
  const o = {};
  for (const el of form.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return o;
}
function busy(btn, on) { if (btn) { btn.disabled = on; } }

// ---------- auth ----------
function showLogin(msg = '') {
  stopScanner();
  $('#topbar').hidden = true;
  view.className = '';
  view.innerHTML = `
    <div class="login card">
      <div class="logo"><img src="icon.svg" width="56" height="56" alt=""><h1>Pallet Tracker</h1></div>
      <form id="login-form">
        <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required></div>
        <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
        <div class="err">${esc(msg)}</div>
        <button class="btn primary big">Log in</button>
      </form>
    </div>`;
  $('#u').focus();
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter; busy(btn, true);
    try {
      const { user } = await api('POST', '/api/login', formData(e.target));
      me = user; await boot();
    } catch (err) { $('.err', e.target).textContent = err.message; busy(btn, false); }
  };
}

function showChangePassword(forced) {
  view.className = 'narrow';
  view.innerHTML = `
    <div class="card">
      <h1>Change your password</h1>
      ${forced ? '<p class="muted">Please choose your own password before continuing.</p>' : ''}
      <form id="pw-form">
        <div class="field"><label>Current password</label><input name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>New password (6+ characters)</label><input name="next" type="password" autocomplete="new-password" minlength="6" required></div>
        <div class="field"><label>Repeat new password</label><input name="again" type="password" autocomplete="new-password" required></div>
        <div class="err"></div>
        <button class="btn primary big">Save password</button>
      </form>
    </div>`;
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    if (f.next !== f.again) { $('.err', e.target).textContent = 'New passwords do not match'; return; }
    try {
      await api('POST', '/api/me/password', f);
      me.mustChangePassword = false; toast('Password changed');
      location.hash = home(); route();
    } catch (err) { $('.err', e.target).textContent = err.message; }
  };
}

$('#logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); me = null; location.hash = ''; showLogin(); };

// ---------- navigation ----------
const NAV = {
  admin: [['dashboard', 'Dashboard'], ['scan', 'Scan'], ['customers', 'Customers'], ['entries', 'Entries'], ['reports', 'Reports'], ['users', 'Users']],
  operator: [['scan', 'Scan'], ['mine', 'My entries']],
};
const home = () => me.role === 'admin' ? '#/dashboard' : '#/scan';

function renderNav(page) {
  $('#topbar').hidden = false;
  $('#who-name').innerHTML = `<a href="#/password" style="color:inherit">${esc(me.name)}</a> <span class="small" style="opacity:.75">(${me.role})</span>`;
  $('#nav').innerHTML = NAV[me.role].map(([k, label]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${label}</a>`).join('');
}

const PAGES = {
  scan: () => pageScan(), mine: () => pageMine(), password: () => showChangePassword(false),
  dashboard: () => pageDashboard(), customers: () => pageCustomers(), entries: () => pageEntries(),
  reports: () => pageReports(), users: () => pageUsers(), labels: () => pageLabels(),
};
const ADMIN_ONLY = new Set(['dashboard', 'customers', 'entries', 'reports', 'users', 'labels']);

function route() {
  if (!me) return showLogin();
  stopScanner();
  if (me.mustChangePassword) { renderNav(''); return showChangePassword(true); }
  let page = (location.hash.match(/^#\/(\w+)/) || [])[1];
  if (!PAGES[page] || (ADMIN_ONLY.has(page) && me.role !== 'admin')) { page = home().slice(2); history.replaceState(null, '', home()); }
  renderNav(page);
  view.className = page === 'scan' || page === 'mine' || page === 'password' ? 'narrow' : '';
  PAGES[page]();
}
window.addEventListener('hashchange', route);

async function boot() {
  try { const r = await api('GET', '/api/me'); me = r.user; undoMinutes = r.undoMinutes; }
  catch { me = null; }
  route();
}

// ---------- operator: scan & record ----------
let scanner = null;
async function stopScanner() {
  if (scanner) { const s = scanner; scanner = null; try { if (s.isScanning) await s.stop(); s.clear(); } catch {} }
}

function pageScan(customer) {
  view.innerHTML = `
    <div id="find" class="card">
      <h1>Find customer</h1>
      <div id="scan-box" hidden><div class="scan-area"><div id="reader"></div></div>
        <button id="scan-stop" class="btn" style="width:100%">Stop camera</button></div>
      <button id="scan-start" class="btn primary big">📷 Scan barcode</button>
      <div id="scan-msg" class="err"></div>
      <div class="or">or type a customer code or name</div>
      <form id="manual" class="row"><div><input id="q" placeholder="Code or name" autocomplete="off" autocapitalize="none"></div>
        <button class="btn grow-0">Search</button></form>
      <ul id="results" class="results"></ul>
    </div>
    <div id="cust"></div>`;
  $('#scan-start').onclick = startScanner;
  $('#scan-stop').onclick = () => { stopScanner(); $('#scan-box').hidden = true; $('#scan-start').hidden = false; };
  $('#manual').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#q').value.trim(); if (!q) return;
    $('#cust').innerHTML = '';
    try { return await lookupCode(q, true); } catch {}
    const { customers } = await api('GET', '/api/customers?q=' + encodeURIComponent(q));
    $('#results').innerHTML = customers.length ? customers.slice(0, 20).map((c) =>
      `<li data-id="${c.id}"><span><b>${esc(c.name)}</b><br><span class="small muted">${esc(c.code)}</span></span><span class="bal ${balCls(c.balance)}">${fmt(c.balance)}</span></li>`).join('')
      : '<li class="muted">No customers match</li>';
    $$('#results li[data-id]').forEach((li) => li.onclick = () => loadCustomer(li.dataset.id));
  };
  if (customer) showCustomer(customer.customer, customer.recent);
}

async function startScanner() {
  const msg = $('#scan-msg'); msg.textContent = '';
  if (!window.isSecureContext) { msg.textContent = 'The camera only works over https (or on localhost). Type the code instead.'; return; }
  if (!window.Html5Qrcode) { msg.textContent = 'Scanner did not load. Type the code instead.'; return; }
  $('#scan-box').hidden = false; $('#scan-start').hidden = true;
  scanner = new Html5Qrcode('reader', { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
  const box = (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h * 0.6, w * 0.5)) });
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 12, qrbox: box, aspectRatio: 1.333 }, async (text) => {
      if (!scanner) return;
      await stopScanner();
      $('#scan-box').hidden = true; $('#scan-start').hidden = false;
      if (navigator.vibrate) navigator.vibrate(80);
      try { await lookupCode(text.trim()); } catch (err) { msg.textContent = err.message; }
    });
  } catch (err) {
    await stopScanner();
    $('#scan-box').hidden = true; $('#scan-start').hidden = false;
    msg.textContent = /permission|notallowed/i.test(String(err)) ? 'Camera permission was refused. Allow camera access in your browser settings.' : 'Could not start the camera: ' + err;
  }
}

async function lookupCode(code, quiet) {
  try {
    const r = await api('GET', '/api/lookup?code=' + encodeURIComponent(code));
    showCustomer(r.customer, r.recent);
  } catch (err) { if (!quiet) $('#scan-msg').textContent = err.message; throw err; }
}
async function loadCustomer(id) { const r = await api('GET', '/api/customers/' + id); showCustomer(r.customer, r.recent); }

function showCustomer(c, recent, savedIds) {
  $('#results').innerHTML = ''; $('#scan-msg').textContent = '';
  const box = $('#cust');
  box.innerHTML = `
    <div class="card">
      <div class="cust-head"><div><div class="cust-name">${esc(c.name)}</div><div class="small muted">Code ${esc(c.code)}${c.address ? ' · ' + esc(c.address) : ''}</div></div>
        <button class="btn sm" id="clear-cust">✕</button></div>
      <div class="balance-box ${balCls(c.balance)}"><div class="n">${fmt(c.balance)}</div><div class="l">${c.balance === 0 ? 'All square, nothing owed' : c.balance > 0 ? 'pallets owed to you' : 'pallets you owe them'}</div></div>
      ${savedIds ? `
      <p style="text-align:center;font-weight:600">✓ Saved</p>
      <div class="row"><button class="btn" id="undo-save">Undo this save</button><button class="btn primary" id="next-cust">Next customer</button></div>` : c.active ? `
      <form id="move">
        <div class="steppers">
          ${stepper('delivered', 'Delivering', 'd')}
          ${stepper('collected', 'Picking up', 'c')}
        </div>
        <div class="after" id="after"></div>
        <div class="row">
          <div class="field"><label>Docket / reference</label><input name="reference" maxlength="100" autocomplete="off"></div>
        </div>
        <div class="field"><label>Note (optional)</label><input name="note" maxlength="500" autocomplete="off"></div>
        <div class="err"></div>
        <button class="btn primary big" id="save-move">Save</button>
      </form>` : '<p class="err">This customer is marked inactive. Ask an admin.</p>'}
    </div>
    <div class="card"><h3>Recent for this customer</h3>${entryList(recent, true)}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#clear-cust').onclick = () => { box.innerHTML = ''; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  bindUndo(box, () => loadCustomer(c.id));
  if (savedIds) {
    $('#next-cust').onclick = () => { box.innerHTML = ''; window.scrollTo({ top: 0, behavior: 'smooth' }); };
    $('#undo-save').onclick = async () => {
      try { for (const id of savedIds) await api('POST', `/api/movements/${id}/void`, {}); toast('Save undone'); loadCustomer(c.id); }
      catch (err) { alert(err.message); }
    };
  }
  const form = $('#move'); if (!form) return;
  const upd = () => {
    const d = +form.delivered.value || 0, k = +form.collected.value || 0;
    const after = c.balance + d - k;
    $('#after').textContent = d || k ? `After this: ${balanceText(after)}` : '';
  };
  $$('.stepper', form).forEach((s) => {
    const inp = $('input', s);
    $$('button', s).forEach((b) => b.onclick = () => { inp.value = Math.max(0, (+inp.value || 0) + +b.dataset.step); upd(); });
    inp.oninput = upd;
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(form); f.customer_id = c.id;
    if (!(+f.delivered) && !(+f.collected)) { $('.err', form).textContent = 'Enter how many pallets you are delivering or picking up'; return; }
    busy($('#save-move'), true);
    try {
      const r = await api('POST', '/api/movements', f);
      toast(`Saved. ${r.customer.name} ${balanceText(r.customer.balance)}.`, 4000);
      showCustomer(r.customer, r.recent, r.ids);
    } catch (err) { $('.err', form).textContent = err.message; busy($('#save-move'), false); }
  };
}

const stepper = (name, title, cls) => `
  <div class="stepper ${cls}"><div class="t">${title}</div>
    <div class="ctl"><button type="button" data-step="-1" aria-label="minus one">−</button>
      <input name="${name}" type="number" inputmode="numeric" min="0" max="100000" value="0" aria-label="${title}">
      <button type="button" data-step="1" aria-label="plus one">+</button></div></div>`;

function canUndo(m) {
  return !m.voided_at && m.type !== 'adjust' && (me.role === 'admin' || (m.user_id === me.id && Date.now() - Date.parse(m.created_at) < undoMinutes * 60000));
}
function entryList(rows, showUser) {
  if (!rows.length) return '<p class="muted">Nothing yet.</p>';
  return rows.map((m) => `
    <div class="entry ${m.voided_at ? 'voided' : ''}">
      <div>${typePill(m)} <b>${fmt(m.qty)}</b>${m.voided_at ? ' <span class="pill">cancelled</span>' : ''}
        <div class="small muted">${dt(m.created_at)}${showUser ? ' · ' + esc(m.user_name) : ' · ' + esc(m.customer_name)}${m.reference ? ' · ' + esc(m.reference) : ''}</div>
        ${m.note ? `<div class="small">${esc(m.note)}</div>` : ''}</div>
      ${canUndo(m) ? `<button class="btn sm danger" data-undo="${m.id}">Undo</button>` : ''}
    </div>`).join('');
}
function bindUndo(root, after) {
  $$('[data-undo]', root).forEach((b) => b.onclick = async () => {
    if (!confirm('Cancel this entry? The balance will be corrected.')) return;
    try { await api('POST', `/api/movements/${b.dataset.undo}/void`, {}); toast('Entry cancelled'); after(); }
    catch (err) { alert(err.message); }
  });
}

async function pageMine() {
  view.innerHTML = '<div class="card"><h1>My recent entries</h1><div id="mine">Loading…</div></div>';
  const { movements } = await api('GET', '/api/movements/mine');
  $('#mine').innerHTML = entryList(movements, false);
  bindUndo($('#mine'), pageMine);
}

// ---------- admin: dashboard ----------
async function pageDashboard() {
  view.innerHTML = '<p class="muted">Loading…</p>';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [s, { customers }] = await Promise.all([
    api('GET', '/api/admin/summary?since=' + encodeURIComponent(today.toISOString())),
    api('GET', '/api/customers'),
  ]);
  const top = customers.filter((c) => c.balance > 0).slice(0, 10);
  const max = Math.max(1, ...top.map((c) => c.balance));
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Dashboard</h1><span class="spacer"></span><a class="btn primary" href="#/scan">📷 Scan / record</a></div>
    <div class="tiles">
      <div class="tile"><div class="k">Pallets owed to you</div><div class="v">${fmt(s.total_owed)}</div><div class="s">across all customers</div></div>
      <div class="tile"><div class="k">Customers owing</div><div class="v">${fmt(s.owing)}</div><div class="s">of ${fmt(s.customers)} active</div></div>
      <div class="tile"><div class="k">Delivered today</div><div class="v">${fmt(s.delivered_today)}</div><div class="s">pallets out</div></div>
      <div class="tile"><div class="k">Picked up today</div><div class="v">${fmt(s.collected_today)}</div><div class="s">pallets back</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Who owes the most</h2>
        ${top.length ? `<div class="bars">${top.map((c) => `
          <div class="b" data-id="${c.id}" title="${esc(c.name)}: ${fmt(c.balance)} pallets owed">
            <span class="name">${esc(c.name)}</span><span class="track"><div class="fill" style="width:${(c.balance / max) * 100}%"></div></span><span class="num"><b>${fmt(c.balance)}</b></span></div>`).join('')}</div>
          <p class="small"><a href="#/customers">All customer balances →</a></p>` : '<p class="muted">Nobody owes you pallets right now.</p>'}
      </div>
      <div class="card"><h2>Latest entries</h2><div id="dash-recent"></div>
        <p class="small"><a href="#/entries">All entries →</a></p></div>
    </div>`;
  // show customer names on the dashboard list
  $('#dash-recent').innerHTML = s.recent.length ? s.recent.map((m) => `
    <div class="entry ${m.voided_at ? 'voided' : ''}"><div>${typePill(m)} <b>${fmt(m.qty)}</b> · ${esc(m.customer_name)}${m.voided_at ? ' <span class="pill">cancelled</span>' : ''}
      <div class="small muted">${dt(m.created_at)} · ${esc(m.user_name)}${m.reference ? ' · ' + esc(m.reference) : ''}</div></div></div>`).join('') : '<p class="muted">Nothing yet.</p>';
  $$('.bars .b').forEach((b) => b.onclick = () => customerModal(b.dataset.id));
}

// ---------- admin: customers ----------
async function pageCustomers() {
  view.innerHTML = `
    <div class="toolbar">
      <h1 style="margin:0">Customers</h1><span class="spacer"></span>
      <button class="btn primary" id="add-cust">+ Add customer</button>
      <button class="btn" id="import">Import master file</button>
      <a class="btn" href="#/labels">Print barcode labels</a>
      <button class="btn" id="exp">Export CSV</button>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:12px"><div><input id="cq" placeholder="Search name or code"></div>
        <button class="btn grow-0" id="cowe" aria-pressed="false">Outstanding</button>
        <label class="grow-0" style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="call" style="width:auto;min-height:0"> Show inactive</label></div>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Customer</th><th class="num">Owed to you</th><th class="num">Delivered</th><th class="num">Picked up</th><th>Last activity</th></tr></thead>
        <tbody id="ctable"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody><tfoot id="cfoot"></tfoot></table></div>
    </div>`;
  let rows = [], owingOnly = false;
  const load = async () => {
    const r = await api('GET', `/api/customers?q=${encodeURIComponent($('#cq').value.trim())}&all=${$('#call').checked ? 1 : 0}`);
    rows = owingOnly ? r.customers.filter((c) => c.balance !== 0) : r.customers;
    $('#ctable').innerHTML = rows.length ? rows.map((c) => `
      <tr class="click" data-id="${c.id}"><td>${esc(c.code)}</td><td>${esc(c.name)}${c.active ? '' : ' <span class="pill">inactive</span>'}</td>
        ${balCell(c.balance)}<td class="num">${fmt(c.total_delivered)}</td><td class="num">${fmt(c.total_collected)}</td><td class="small muted">${dt(c.last_activity, false)}</td></tr>`).join('')
      : `<tr><td colspan="6" class="muted">${owingOnly ? 'No outstanding balances right now.' : 'No customers yet. Add one or import your master file.'}</td></tr>`;
    $('#cfoot').innerHTML = rows.length ? `<tr><td></td><td>${rows.length} customers</td>${balCell(rows.reduce((a, c) => a + c.balance, 0))}<td></td><td></td><td></td></tr>` : '';
    $$('#ctable tr[data-id]').forEach((tr) => tr.onclick = () => customerModal(tr.dataset.id, load));
  };
  let t; $('#cq').oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
  $('#call').onchange = load;
  $('#cowe').onclick = () => {
    owingOnly = !owingOnly;
    $('#cowe').classList.toggle('primary', owingOnly);
    $('#cowe').setAttribute('aria-pressed', owingOnly);
    $('#cowe').textContent = owingOnly ? 'Show all customers' : 'Outstanding';
    load();
  };
  $('#add-cust').onclick = () => customerForm(null, load);
  $('#import').onclick = () => importDialog(load);
  $('#exp').onclick = () => downloadCSV('customer-balances.csv', [
    { label: 'Code', value: 'code' }, { label: 'Customer', value: 'name' }, { label: 'Owed to us', value: 'balance' },
    { label: 'Total delivered', value: 'total_delivered' }, { label: 'Total picked up', value: 'total_collected' },
    { label: 'Last activity', value: (r) => dt(r.last_activity, false) }, { label: 'Phone', value: 'phone' }, { label: 'Email', value: 'email' }, { label: 'Address', value: 'address' }], rows);
  load();
}

async function customerModal(id, onChange) {
  const { customer: c, recent } = await api('GET', '/api/customers/' + id);
  const body = openModal(`
    <div class="cust-head"><div><h2 style="margin:0">${esc(c.name)}</h2><div class="small muted">Code ${esc(c.code)}</div></div><button class="btn sm" data-close>✕</button></div>
    <div class="balance-box ${balCls(c.balance)}"><div class="n">${fmt(c.balance)}</div><div class="l">${c.balance === 0 ? 'All square' : c.balance > 0 ? 'pallets owed to you' : 'pallets you owe them'}</div></div>
    <div style="text-align:center;margin-bottom:12px"><svg id="bc"></svg></div>
    <div class="toolbar">
      <button class="btn" id="m-edit">Edit details</button>
      <button class="btn" id="m-adjust">Adjust balance</button>
      <button class="btn" id="m-stmt">Statement</button>
    </div>
    <h3>Recent entries</h3><div id="m-recent">${entryList(recent, true)}</div>`);
  try { JsBarcode('#bc', c.code, { format: 'CODE128', height: 50, displayValue: true, margin: 4 }); } catch {}
  $('[data-close]', body).onclick = closeModal;
  $('#m-edit').onclick = () => customerForm(c, onChange);
  $('#m-adjust').onclick = () => adjustForm(c, onChange);
  $('#m-stmt').onclick = () => { closeModal(); location.hash = '#/reports'; setTimeout(() => openStatement(c.id), 50); };
  bindUndo(body, () => { customerModal(id, onChange); onChange && onChange(); });
}

function customerForm(c, onChange) {
  const v = c || { code: '', name: '', address: '', phone: '', email: '', notes: '', active: 1 };
  const body = openModal(`
    <h2>${c ? 'Edit customer' : 'Add customer'}</h2>
    <form id="cf">
      <div class="row"><div class="field"><label>Code (what the barcode contains)</label><input name="code" value="${esc(v.code)}" required></div>
        <div class="field"><label>Name</label><input name="name" value="${esc(v.name)}" required></div></div>
      <div class="field"><label>Address</label><input name="address" value="${esc(v.address)}"></div>
      <div class="row"><div class="field"><label>Phone</label><input name="phone" value="${esc(v.phone)}"></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${esc(v.email)}"></div></div>
      <div class="field"><label>Notes</label><input name="notes" value="${esc(v.notes)}"></div>
      ${c ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${v.active ? 'checked' : ''} style="width:auto;min-height:0"> Active</label>`
          : `<div class="field"><label>Pallets they already owe you (opening balance)</label><input name="opening_balance" type="number" value="0"></div>`}
      <div class="err"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
  $('[data-close]', body).onclick = closeModal;
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try {
      if (c) await api('PUT', '/api/admin/customers/' + c.id, f); else await api('POST', '/api/admin/customers', f);
      closeModal(); toast('Customer saved'); onChange && onChange();
    } catch (err) { $('.err', e.target).textContent = err.message; }
  };
}

function adjustForm(c, onChange) {
  const body = openModal(`
    <h2>Adjust balance: ${esc(c.name)}</h2>
    <p class="muted">Currently ${balanceText(c.balance)}. Use this for stocktake corrections or write-offs. Enter a positive number if they owe more, negative if they owe less.</p>
    <form id="af">
      <div class="row"><div class="field"><label>Adjustment (+/−)</label><input name="qty" type="number" required></div>
        <div class="field"><label>Reference</label><input name="reference"></div></div>
      <div class="field"><label>Reason</label><input name="note" required placeholder="e.g. Stocktake 30 Sep, customer count confirmed"></div>
      <div class="after" id="af-after"></div>
      <div class="err"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save adjustment</button></div>
    </form>`);
  $('[data-close]', body).onclick = closeModal;
  const f = $('#af');
  f.qty.oninput = () => { $('#af-after').textContent = f.qty.value ? 'After this: ' + balanceText(c.balance + (+f.qty.value || 0)) : ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/admin/adjust', { ...formData(f), customer_id: c.id }); toast('Balance adjusted'); customerModal(c.id, onChange); onChange && onChange(); }
    catch (err) { $('.err', f).textContent = err.message; }
  };
}

// Master file import: CSV or Excel. Columns are matched by header name and can be changed before importing.
function importDialog(onDone) {
  const FIELDS = [
    ['code', 'Code / barcode *', /barcode|code|account|acc(ount)?\s*(no|number|#)?|cust(omer)?\s*(no|id|#|number)/i],
    ['name', 'Name *', /name|customer|company|business/i],
    ['address', 'Address', /address|street|location|suburb/i],
    ['phone', 'Phone', /phone|mobile|tel/i],
    ['email', 'Email', /e-?mail/i],
    ['notes', 'Notes', /note|comment/i],
    ['opening_balance', 'Opening balance (new customers only)', /balance|opening|owed|pallets/i],
  ];
  const body = openModal(`
    <h2>Import customer master file</h2>
    <p class="muted">Choose an Excel (.xlsx/.xls) or CSV file. The first row should be column headings. Existing codes are updated; new codes are added. Nothing is deleted.</p>
    <input type="file" id="imp-file" accept=".csv,.xlsx,.xls,.txt">
    <div id="imp-map"></div>
    <div class="err"></div>
    <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="imp-go" disabled>Import</button></div>`);
  $('[data-close]', body).onclick = closeModal;
  let table = [];
  $('#imp-file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    $('.err', body).textContent = '';
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }).filter((r) => r.some((v) => String(v).trim()));
    } catch (err) { $('.err', body).textContent = 'Could not read that file: ' + err.message; return; }
    if (table.length < 2) { $('.err', body).textContent = 'The file needs a heading row and at least one customer.'; return; }
    const headers = table[0].map((h) => String(h).trim());
    // Spreadsheets printed in pages often repeat the heading row; drop those copies.
    const isHeading = (r) => headers.every((h, i) => String(r[i] ?? '').trim().toLowerCase() === h.toLowerCase());
    const before = table.length;
    table = [table[0], ...table.slice(1).filter((r) => !isHeading(r))];
    const repeated = before - table.length;
    const used = new Set();
    const guess = (re) => { const i = headers.findIndex((h, i) => !used.has(i) && re.test(h)); if (i >= 0) used.add(i); return i; };
    const opts = (sel) => `<option value="-1">(none)</option>` + headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('');
    $('#imp-map').innerHTML = `
      <p><b>${table.length - 1}</b> customers found${repeated ? ` (${repeated} repeated heading row${repeated > 1 ? 's' : ''} ignored)` : ''}. Check which column is which:</p>
      <div class="row">${FIELDS.map(([k, label, re]) => `<div class="field"><label>${label}</label><select data-f="${k}">${opts(guess(re))}</select></div>`).join('')}</div>
      <div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${table.slice(1, 6).map((r) => `<tr>${headers.map((_, i) => `<td>${esc(r[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    $('#imp-go').disabled = false;
  };
  $('#imp-go').onclick = async () => {
    const map = Object.fromEntries($$('[data-f]', body).map((s) => [s.dataset.f, +s.value]));
    if (map.code < 0 || map.name < 0) { $('.err', body).textContent = 'Pick the code and name columns.'; return; }
    const rows = table.slice(1).map((r) => Object.fromEntries(Object.entries(map).filter(([, i]) => i >= 0).map(([k, i]) => [k, String(r[i] ?? '').trim()])));
    rows.forEach((r) => {
      if (r.phone && !/\d/.test(r.phone)) r.phone = ''; // placeholders like "." or "-"
      if (r.opening_balance) r.opening_balance = r.opening_balance.replace(/[, ]/g, '');
    });
    busy($('#imp-go'), true);
    try {
      const r = await api('POST', '/api/admin/customers/import', { rows });
      $('#imp-map').innerHTML = `<p><b>${r.created}</b> added, <b>${r.updated}</b> updated.</p>` +
        (r.errors.length ? `<p class="err">${r.errors.length} rows skipped:</p><ul class="small">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '');
      $('#imp-go').hidden = true; $('[data-close]', body).textContent = 'Close';
      onDone && onDone();
    } catch (err) { $('.err', body).textContent = err.message; busy($('#imp-go'), false); }
  };
}

async function pageLabels() {
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Barcode labels</h1><span class="spacer"></span>
      <input id="lq" placeholder="Filter by name or code" style="max-width:260px"><button class="btn primary" onclick="window.print()">Print</button></div>
    <p class="muted no-print">One Code 128 label per active customer. Print on label paper or plain paper and stick it where the driver can scan it (e.g. delivery docket book, customer dock).</p>
    <div class="labels" id="labels"></div>`;
  const { customers } = await api('GET', '/api/customers');
  const render = () => {
    const q = $('#lq').value.trim().toLowerCase();
    const list = customers.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    $('#labels').innerHTML = list.map((c, i) => `<div class="label"><div class="ln">${esc(c.name)}</div><svg id="lb${i}"></svg></div>`).join('') || '<p class="muted">No customers.</p>';
    list.forEach((c, i) => { try { JsBarcode('#lb' + i, c.code, { format: 'CODE128', height: 55, margin: 6, fontSize: 14 }); } catch {} });
  };
  $('#lq').oninput = render; render();
}

// ---------- admin: entries ----------
async function pageEntries() {
  const now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), 1);
  const [{ customers }, { users }] = await Promise.all([api('GET', '/api/customers?all=1'), api('GET', '/api/admin/users')]);
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Entries</h1><span class="spacer"></span><button class="btn" id="e-csv">Export CSV</button><button class="btn" onclick="window.print()">Print</button></div>
    <div class="card no-print"><form id="ef" class="row">
      <div><label>From</label><input type="date" name="from" value="${ymd(from)}"></div>
      <div><label>To</label><input type="date" name="to" value="${ymd(now)}"></div>
      <div><label>Customer</label><select name="customer_id"><option value="">All customers</option>${customers.sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div><label>Operator</label><select name="user_id"><option value="">Everyone</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>
      <div><label>Type</label><select name="type"><option value="">All</option><option value="delivered">Delivered</option><option value="collected">Picked up</option><option value="adjust">Adjustments</option></select></div>
      <label class="grow-0" style="display:flex;gap:6px;align-items:center;margin:0 0 12px"><input type="checkbox" name="voided" style="width:auto;min-height:0"> Include cancelled</label>
    </form></div>
    <div class="card"><div id="e-sum" class="small muted" style="margin-bottom:8px"></div><div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Customer</th><th>Type</th><th class="num">Pallets</th><th class="num">Balance effect</th><th>Reference</th><th>Note</th><th>By</th><th class="no-print"></th></tr></thead>
      <tbody id="etable"></tbody></table></div></div>`;
  let rows = [];
  const load = async () => {
    const f = formData($('#ef'));
    const qs = new URLSearchParams({ from: dayStart(f.from), to: dayAfter(f.to), customer_id: f.customer_id, user_id: f.user_id, type: f.type, voided: f.voided ? 1 : 0 });
    rows = (await api('GET', '/api/admin/movements?' + qs)).movements;
    const live = rows.filter((m) => !m.voided_at);
    const sum = (t) => live.filter((m) => m.type === t).reduce((a, m) => a + m.qty, 0);
    $('#e-sum').textContent = `${rows.length} entries · ${fmt(sum('delivered'))} delivered · ${fmt(sum('collected'))} picked up · net ${signed(live.reduce((a, m) => a + m.delta, 0))}`;
    $('#etable').innerHTML = rows.map((m) => `
      <tr class="${m.voided_at ? 'voided' : ''}"><td class="small">${dt(m.created_at)}</td><td>${esc(m.customer_name)}</td><td>${typePill(m)}</td>
        <td class="num">${fmt(Math.abs(m.qty))}</td><td class="num">${signed(m.delta)}</td><td>${esc(m.reference)}</td>
        <td class="small">${esc(m.note)}${m.voided_at ? `<br><span class="muted">Cancelled by ${esc(m.voided_by_name)}: ${esc(m.void_reason)}</span>` : ''}</td>
        <td class="small">${esc(m.user_name)}</td><td class="no-print">${m.voided_at ? '' : `<button class="btn sm danger" data-void="${m.id}">Cancel</button>`}</td></tr>`).join('')
      || '<tr><td colspan="9" class="muted">No entries for these filters.</td></tr>';
    $$('[data-void]').forEach((b) => b.onclick = async () => {
      const reason = prompt('Reason for cancelling this entry?'); if (reason === null) return;
      try { await api('POST', `/api/movements/${b.dataset.void}/void`, { reason }); toast('Entry cancelled'); load(); } catch (err) { alert(err.message); }
    });
  };
  $('#ef').onchange = load;
  $('#e-csv').onclick = () => downloadCSV('pallet-entries.csv', [
    { label: 'Date', value: (m) => new Date(m.created_at).toLocaleString() }, { label: 'Customer code', value: 'customer_code' }, { label: 'Customer', value: 'customer_name' },
    { label: 'Type', value: (m) => ({ delivered: 'Delivered', collected: 'Picked up', adjust: 'Adjustment' }[m.type]) }, { label: 'Pallets', value: (m) => Math.abs(m.qty) },
    { label: 'Balance effect', value: 'delta' }, { label: 'Reference', value: 'reference' }, { label: 'Note', value: 'note' }, { label: 'Entered by', value: 'user_name' },
    { label: 'Cancelled', value: (m) => m.voided_at ? `Yes: ${m.void_reason}` : '' }], rows);
  load();
}

// ---------- admin: reports ----------
async function pageReports() {
  pageReports.openStatement = null;
  const now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), 1);
  const { customers } = await api('GET', '/api/customers?all=1');
  customers.sort((a, b) => a.name.localeCompare(b.name));
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Reports</h1><span class="spacer"></span>
      <select id="rtype" style="max-width:280px"><option value="activity">Balances &amp; movements by customer</option><option value="statement">Customer statement</option><option value="operators">Operator activity</option></select></div>
    <div class="card no-print"><form id="rf" class="row">
      <div><label>From</label><input type="date" name="from" value="${ymd(from)}"></div>
      <div><label>To</label><input type="date" name="to" value="${ymd(now)}"></div>
      <div id="rcust" hidden><label>Customer</label><select name="customer_id"><option value="">Choose…</option>${customers.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.code)})</option>`).join('')}</select></div>
      <div class="grow-0" style="display:flex;gap:8px"><button type="button" class="btn" id="rcsv">Export CSV</button><button type="button" class="btn" onclick="window.print()">Print</button></div>
    </form></div>
    <div class="card" id="rout"></div>`;
  let csv = null;
  const run = async () => {
    const f = formData($('#rf')), type = $('#rtype').value;
    $('#rcust').hidden = type !== 'statement';
    const period = `${f.from ? dt(dayStart(f.from), false) : 'start'} to ${f.to ? dt(dayStart(f.to), false) : 'today'}`;
    const qs = new URLSearchParams({ from: dayStart(f.from), to: dayAfter(f.to) });
    const out = $('#rout');
    if (type === 'activity') {
      const { rows } = await api('GET', '/api/admin/reports/activity?' + qs);
      const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
      out.innerHTML = `<h2>Pallet balances by customer</h2><p class="muted">${period}. Positive = pallets the customer owes you.</p>
        <div class="table-wrap"><table><thead><tr><th>Code</th><th>Customer</th><th class="num">Opening</th><th class="num">Delivered</th><th class="num">Picked up</th><th class="num">Adjustments</th><th class="num">Closing balance</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${fmt(r.opening)}</td><td class="num">${fmt(r.delivered)}</td><td class="num">${fmt(r.collected)}</td><td class="num">${r.adjusted ? signed(r.adjusted) : ''}</td>${balCell(r.closing)}</tr>`).join('') || '<tr><td colspan="7" class="muted">No activity.</td></tr>'}</tbody>
        <tfoot><tr><td></td><td>Total</td><td class="num">${fmt(tot('opening'))}</td><td class="num">${fmt(tot('delivered'))}</td><td class="num">${fmt(tot('collected'))}</td><td class="num">${signed(tot('adjusted'))}</td>${balCell(tot('closing'))}</tr></tfoot></table></div>`;
      csv = () => downloadCSV(`pallet-balances_${f.from}_${f.to}.csv`, [{ label: 'Code', value: 'code' }, { label: 'Customer', value: 'name' }, { label: 'Opening', value: 'opening' },
        { label: 'Delivered', value: 'delivered' }, { label: 'Picked up', value: 'collected' }, { label: 'Adjustments', value: 'adjusted' }, { label: 'Closing balance', value: 'closing' }], rows);
    } else if (type === 'statement') {
      if (!f.customer_id) { out.innerHTML = '<p class="muted">Choose a customer to see their statement.</p>'; csv = null; return; }
      const s = await api('GET', `/api/admin/reports/statement?customer_id=${f.customer_id}&` + qs);
      const c = s.customer;
      out.innerHTML = `<h2>Pallet statement: ${esc(c.name)}</h2><p class="muted">Code ${esc(c.code)}${c.address ? ' · ' + esc(c.address) : ''}<br>${period}</p>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Details</th><th>Reference</th><th class="num">Delivered</th><th class="num">Picked up</th><th class="num">Balance</th></tr></thead>
        <tbody><tr><td></td><td><b>Opening balance</b></td><td></td><td></td><td></td>${balCell(s.opening)}</tr>
        ${s.lines.map((l) => `<tr><td class="small">${dt(l.created_at)}</td><td>${l.type === 'adjust' ? 'Adjustment: ' + esc(l.note) : esc(l.note)}</td><td>${esc(l.reference)}</td>
          <td class="num">${l.type === 'delivered' ? fmt(l.qty) : l.type === 'adjust' && l.delta > 0 ? signed(l.delta) : ''}</td>
          <td class="num">${l.type === 'collected' ? fmt(l.qty) : l.type === 'adjust' && l.delta < 0 ? fmt(-l.delta) : ''}</td>${balCell(l.running)}</tr>`).join('')}</tbody>
        <tfoot><tr><td></td><td>Closing balance</td><td></td><td></td><td></td>${balCell(s.closing)}</tr></tfoot></table></div>
        <p>${esc(c.name)} ${balanceText(s.closing)} as at ${f.to ? dt(dayStart(f.to), false) : 'today'}.</p>`;
      csv = () => downloadCSV(`statement_${c.code}_${f.from}_${f.to}.csv`, [{ label: 'Date', value: (l) => l.created_at ? new Date(l.created_at).toLocaleString() : '' },
        { label: 'Type', value: (l) => l.type || '' }, { label: 'Reference', value: 'reference' }, { label: 'Note', value: 'note' }, { label: 'Change', value: 'delta' }, { label: 'Balance', value: 'running' }],
        [{ note: 'Opening balance', running: s.opening }, ...s.lines, { note: 'Closing balance', running: s.closing }]);
    } else {
      const { movements } = await api('GET', '/api/admin/movements?' + qs);
      const by = {};
      for (const m of movements.filter((m) => m.type !== 'adjust')) {
        const r = by[m.user_name] ||= { name: m.user_name, entries: 0, delivered: 0, collected: 0, customers: new Set() };
        r.entries++; r.customers.add(m.customer_id);
        if (m.type === 'delivered') r.delivered += m.qty; if (m.type === 'collected') r.collected += m.qty;
      }
      const rows = Object.values(by).map((r) => ({ ...r, customers: r.customers.size })).sort((a, b) => b.entries - a.entries);
      out.innerHTML = `<h2>Operator activity</h2><p class="muted">${period}</p>
        <div class="table-wrap"><table><thead><tr><th>Operator</th><th class="num">Entries</th><th class="num">Customers visited</th><th class="num">Delivered</th><th class="num">Picked up</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmt(r.entries)}</td><td class="num">${fmt(r.customers)}</td><td class="num">${fmt(r.delivered)}</td><td class="num">${fmt(r.collected)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No activity.</td></tr>'}</tbody></table></div>`;
      csv = () => downloadCSV(`operator-activity_${f.from}_${f.to}.csv`, [{ label: 'Operator', value: 'name' }, { label: 'Entries', value: 'entries' },
        { label: 'Customers visited', value: 'customers' }, { label: 'Delivered', value: 'delivered' }, { label: 'Picked up', value: 'collected' }], rows);
    }
  };
  $('#rf').onchange = run; $('#rtype').onchange = run;
  $('#rcsv').onclick = () => csv ? csv() : toast('Nothing to export');
  pageReports.openStatement = (id) => { $('#rtype').value = 'statement'; $('#rf').customer_id.value = id; $('#rf').from.value = ''; run(); };
  run();
}
function openStatement(id) { const go = () => pageReports.openStatement ? pageReports.openStatement(id) : setTimeout(go, 50); go(); }

// ---------- admin: users ----------
async function pageUsers() {
  const { users } = await api('GET', '/api/admin/users');
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Users</h1><span class="spacer"></span><button class="btn primary" id="add-user">+ Add user</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last entry</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${u.role === 'admin' ? 'Administrator' : 'Operator'}</td>
        <td>${u.active ? 'Active' : '<span class="pill">Disabled</span>'}</td><td class="small muted">${dt(u.last_entry)}</td>
        <td><button class="btn sm" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">Operators can scan, record deliveries and pick-ups, and undo their own entries for ${undoMinutes} minutes. Administrators see everything.</p></div>`;
  $('#add-user').onclick = () => userForm(null);
  $$('[data-edit]').forEach((b) => b.onclick = () => userForm(users.find((u) => u.id === +b.dataset.edit)));
}

function userForm(u) {
  const body = openModal(`
    <h2>${u ? 'Edit ' + esc(u.name) : 'Add user'}</h2>
    <form id="uf">
      <div class="row"><div class="field"><label>Full name</label><input name="name" value="${esc(u?.name || '')}" required></div>
        <div class="field"><label>Username</label><input name="username" value="${esc(u?.username || '')}" ${u ? 'disabled' : 'required'} autocapitalize="none"></div></div>
      <div class="row"><div class="field"><label>Role</label><select name="role"><option value="operator">Operator</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Administrator</option></select></div>
        <div class="field"><label>${u ? 'Reset password (leave blank to keep)' : 'Temporary password'}</label><input name="password" type="text" autocomplete="off" ${u ? '' : 'required minlength="6"'}></div></div>
      ${u ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} style="width:auto;min-height:0"> Can log in</label>` : ''}
      <p class="small muted">They will be asked to choose their own password the first time they log in.</p>
      <div class="err"></div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
  $('[data-close]', body).onclick = closeModal;
  $('#uf').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try {
      if (u) await api('PUT', '/api/admin/users/' + u.id, f); else await api('POST', '/api/admin/users', f);
      closeModal(); toast('User saved'); pageUsers();
    } catch (err) { $('.err', e.target).textContent = err.message; }
  };
}

boot();
