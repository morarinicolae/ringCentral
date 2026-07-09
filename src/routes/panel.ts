import { Router } from 'express';

export const panelRouter = Router();

// A minimal, self-contained admin panel (single HTML page, vanilla JS).
// Served WITHOUT auth (it's just the UI shell); every data call it makes hits
// the /admin/* API with the admin token the user types in, which is stored in
// localStorage. Nothing sensitive is embedded in the page itself.
const HTML = /* html */ `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SMS Router — Admin</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background:#0f172a; color:#e2e8f0; }
  header { background:#1e293b; padding:14px 20px; display:flex; gap:12px; align-items:center;
           position:sticky; top:0; border-bottom:1px solid #334155; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; font-weight:650; }
  header .spacer { flex:1; }
  input, select, button { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid #334155;
           background:#0b1220; color:#e2e8f0; }
  button { background:#2563eb; border-color:#2563eb; cursor:pointer; font-weight:600; }
  button.ghost { background:transparent; }
  button:hover { filter:brightness(1.1); }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  section { background:#111a2e; border:1px solid #26324a; border-radius:12px; padding:16px; margin-bottom:20px; }
  section h2 { margin:0 0 12px; font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:9px 8px; border-bottom:1px solid #1e293b; vertical-align:middle; }
  th { color:#94a3b8; font-weight:600; font-size:12px; text-transform:uppercase; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.active { background:#052e1a; color:#4ade80; }
  .pill.opt_out, .pill.blocked, .pill.closed { background:#3b0d0d; color:#f87171; }
  .pill.open { background:#0b2540; color:#60a5fa; }
  .muted { color:#64748b; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .err { color:#f87171; }
  .ok { color:#4ade80; }
  code { background:#0b1220; padding:1px 5px; border-radius:5px; }
</style>
</head>
<body>
<header>
  <h1>📨 SMS Router — Admin</h1>
  <span class="spacer"></span>
  <input id="token" type="password" placeholder="Admin token (X-Admin-Token)" style="width:240px" />
  <button onclick="saveToken()">Salvează token</button>
  <button class="ghost" onclick="loadAll()">↻ Reîncarcă</button>
</header>
<main>
  <div id="status" class="muted" style="margin-bottom:14px">Introdu admin token-ul și apasă „Salvează token”.</div>

  <section>
    <h2>Conversații (toate)</h2>
    <table id="convTable"><thead>
      <tr><th>Client</th><th>Status</th><th>Vânzător</th><th>Ultimul mesaj</th><th>Reasignare</th></tr>
    </thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Vânzători</h2>
    <table id="sellerTable"><thead>
      <tr><th>Nume</th><th>Telegram ID</th><th>Prioritate</th><th>Activ</th><th></th></tr>
    </thead><tbody></tbody></table>
    <div class="row" style="margin-top:14px">
      <input id="nName" placeholder="Nume" style="width:160px" />
      <input id="nTg" placeholder="Telegram ID" style="width:140px" />
      <input id="nPrio" type="number" placeholder="Prioritate" value="100" style="width:110px" />
      <button onclick="createSeller()">+ Adaugă vânzător</button>
    </div>
  </section>
</main>

<script>
const $ = (s) => document.querySelector(s);
let SELLERS = [];

function token() { return localStorage.getItem('adminToken') || ''; }
function saveToken() {
  localStorage.setItem('adminToken', $('#token').value.trim());
  setStatus('Token salvat. Se încarcă…');
  loadAll();
}
function setStatus(msg, cls='muted') { const el=$('#status'); el.className=cls; el.textContent=msg; }

async function api(path, opts={}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type':'application/json', 'x-admin-token': token(), ...(opts.headers||{}) },
  });
  if (res.status === 401) throw new Error('Token invalid (401).');
  if (res.status === 503) throw new Error('Admin dezactivat pe server (ADMIN_API_TOKEN nesetat).');
  if (!res.ok) throw new Error('Eroare ' + res.status);
  return res.json();
}

function esc(s){ return (s??'').toString().replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function loadAll() {
  if (!token()) { setStatus('Lipsește token-ul.', 'err'); return; }
  try {
    const [conv, sel] = await Promise.all([ api('/admin/conversations'), api('/admin/sellers') ]);
    SELLERS = sel.sellers;
    renderSellers(sel.sellers);
    renderConvs(conv.conversations);
    setStatus('Încărcat: ' + conv.count + ' conversații, ' + sel.count + ' vânzători.', 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
}

function renderConvs(rows) {
  const opts = (sel) => SELLERS.map(s =>
    '<option value="'+s.id+'"'+(sel===s.id?' selected':'')+'>'+esc(s.name)+'</option>').join('');
  $('#convTable tbody').innerHTML = rows.map(c => {
    const sid = c.seller ? c.seller.id : '';
    return '<tr>'
      + '<td><code>'+esc(c.contact.phone)+'</code></td>'
      + '<td><span class="pill '+esc(c.contact.status)+'">'+esc(c.contact.status)+'</span></td>'
      + '<td>'+esc(c.seller?c.seller.name:'—')+'</td>'
      + '<td class="muted">'+esc((c.last_message||'').slice(0,60))+'</td>'
      + '<td class="row"><select id="rs_'+c.id+'">'+opts(sid)+'</select>'
      + '<button onclick="reassign(\\''+c.id+'\\')">Mută</button></td>'
      + '</tr>';
  }).join('') || '<tr><td colspan="5" class="muted">Nicio conversație încă.</td></tr>';
}

function renderSellers(rows) {
  $('#sellerTable tbody').innerHTML = rows.map(s =>
    '<tr>'
    + '<td>'+esc(s.name)+'</td>'
    + '<td><code>'+esc(s.telegramUserId||'—')+'</code></td>'
    + '<td>'+esc(s.priority)+'</td>'
    + '<td><span class="pill '+(s.isActive?'active':'blocked')+'">'+(s.isActive?'activ':'inactiv')+'</span></td>'
    + '<td><button class="ghost" onclick="toggle(\\''+s.id+'\\','+(!s.isActive)+')">'+(s.isActive?'Dezactivează':'Activează')+'</button></td>'
    + '</tr>').join('');
}

async function reassign(convId) {
  const newId = $('#rs_'+convId).value;
  try { await api('/admin/reassign-conversation', { method:'POST', body: JSON.stringify({ conversation_id: convId, new_seller_id: newId }) });
        setStatus('Conversație reasignată.', 'ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}
async function toggle(id, active) {
  try { await api('/admin/sellers/'+id, { method:'PATCH', body: JSON.stringify({ is_active: active }) }); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}
async function createSeller() {
  const name=$('#nName').value.trim(), tg=$('#nTg').value.trim(), prio=Number($('#nPrio').value)||100;
  if(!name){ setStatus('Numele e obligatoriu.','err'); return; }
  try { await api('/admin/sellers', { method:'POST', body: JSON.stringify({ name, telegram_user_id: tg||undefined, priority: prio }) });
        $('#nName').value=''; $('#nTg').value=''; setStatus('Vânzător adăugat.','ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}

// Boot
$('#token').value = token();
if (token()) loadAll();
</script>
</body>
</html>`;

panelRouter.get('/', (_req, res) => {
  res.type('html').send(HTML);
});
