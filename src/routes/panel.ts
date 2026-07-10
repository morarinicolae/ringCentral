import { Router } from 'express';

export const panelRouter = Router();

// Minimal, self-contained admin panel (single HTML page, vanilla JS). Served
// WITHOUT auth (just the UI shell); every data call carries the admin token the
// user types (stored in localStorage) and hits the token-protected /admin/* API.
const HTML = /* html */ `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SMS/Call Router — Admin</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0f172a; color:#e2e8f0; }
  header { background:#1e293b; padding:14px 20px; display:flex; gap:12px; align-items:center; position:sticky; top:0; border-bottom:1px solid #334155; flex-wrap:wrap; z-index:5; }
  header h1 { font-size:16px; margin:0; font-weight:650; }
  .spacer { flex:1; }
  input, select, button { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid #334155; background:#0b1220; color:#e2e8f0; }
  button { background:#2563eb; border-color:#2563eb; cursor:pointer; font-weight:600; }
  button.ghost { background:transparent; }
  button:hover { filter:brightness(1.1); }
  main { padding:20px; max-width:1150px; margin:0 auto; }
  section { background:#111a2e; border:1px solid #26324a; border-radius:12px; padding:16px; margin-bottom:20px; }
  section h2 { margin:0 0 12px; font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:9px 8px; border-bottom:1px solid #1e293b; vertical-align:middle; }
  th { color:#94a3b8; font-weight:600; font-size:12px; text-transform:uppercase; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.active, .pill.answered { background:#052e1a; color:#4ade80; }
  .pill.opt_out, .pill.blocked, .pill.closed, .pill.missed, .pill.inactive { background:#3b0d0d; color:#f87171; }
  .pill.open, .pill.voicemail { background:#0b2540; color:#60a5fa; }
  .muted { color:#64748b; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .err { color:#f87171; } .ok { color:#4ade80; }
  code { background:#0b1220; padding:1px 5px; border-radius:5px; }
</style>
</head>
<body>
<header>
  <h1>📨 SMS/Call Router — Admin</h1>
  <span class="spacer"></span>
  <input id="token" type="password" placeholder="Admin token" style="width:220px" />
  <button onclick="saveToken()">Salvează</button>
  <button class="ghost" onclick="loadAll()">↻ Reîncarcă</button>
</header>
<main>
  <div id="status" class="muted" style="margin-bottom:14px">Introdu admin token-ul și apasă „Salvează”.</div>

  <section>
    <h2>Linii (număr + cont RingCentral + echipă)</h2>
    <table id="lineTable"><thead>
      <tr><th>Nume</th><th>Număr</th><th>Cont RC</th><th>Activ</th><th>Selleri</th></tr>
    </thead><tbody></tbody></table>
    <div class="row" style="margin-top:12px">
      <input id="lName" placeholder="Nume linie" style="width:150px" />
      <input id="lPhone" placeholder="+1XXXXXXXXXX" style="width:150px" />
      <button onclick="createLine()">+ Adaugă linie</button>
    </div>
    <div class="muted" style="margin-top:14px; font-size:13px">
      <b>Cont RingCentral per număr</b> (fiecare linie își are contul ei — lasă gol ca să folosească contul global din <code>.env</code>):
    </div>
    <div class="row" style="margin-top:8px">
      <select id="rcLine"></select>
      <input id="rcClientId" placeholder="Client ID" style="width:150px" />
      <input id="rcSecret" type="password" placeholder="Client Secret" style="width:150px" />
      <input id="rcJwt" type="password" placeholder="JWT" style="width:150px" />
      <input id="rcServer" placeholder="Server URL (opțional)" style="width:170px" />
      <label class="muted" style="display:flex;gap:5px;align-items:center"><input id="rcA2p" type="checkbox" style="width:auto" /> A2P</label>
      <button onclick="setLineRc()">Salvează cont RC</button>
    </div>
  </section>

  <section>
    <h2>Vânzători</h2>
    <table id="sellerTable"><thead>
      <tr><th>Nume</th><th>Numere &amp; topic-uri</th><th>Telegram ID (grup/chat)</th><th>Activ</th><th></th></tr>
    </thead><tbody></tbody></table>
    <div class="row" style="margin-top:12px">
      <input id="nName" placeholder="Nume" style="width:130px" />
      <input id="nTg" placeholder="Telegram ID / grup (-100…)" style="width:190px" />
      <select id="nLine"></select>
      <input id="nTopic" placeholder="Topic ID (opțional)" style="width:150px" />
      <button onclick="createSeller()">+ Adaugă vânzător</button>
    </div>
    <div class="muted" style="margin-top:14px; font-size:13px">
      <b>Un vânzător pe mai multe numere</b> (fiecare număr → topicul lui în grupul vânzătorului):
    </div>
    <div class="row" style="margin-top:8px">
      <select id="mSeller"></select>
      <select id="mLine"></select>
      <input id="mTopic" placeholder="Topic ID" style="width:130px" />
      <button onclick="addSellerLine()">Pune pe număr / setează topic</button>
    </div>
  </section>

  <section>
    <h2>Conversații (toate)</h2>
    <table id="convTable"><thead>
      <tr><th>Client</th><th>Linie</th><th>Status</th><th>Vânzător</th><th>Ultimul mesaj</th><th>Reasignare</th></tr>
    </thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Apeluri (toate)</h2>
    <table id="callTable"><thead>
      <tr><th>Client</th><th>Linie</th><th>Vânzător</th><th>Rezultat</th><th>Durată</th><th>Când</th></tr>
    </thead><tbody></tbody></table>
  </section>
</main>

<script>
const $ = (s) => document.querySelector(s);
let SELLERS = [], LINES = [];
function token() { return localStorage.getItem('adminToken') || ''; }
function saveToken() { localStorage.setItem('adminToken', $('#token').value.trim()); setStatus('Se încarcă…'); loadAll(); }
function setStatus(m, c='muted') { const e=$('#status'); e.className=c; e.textContent=m; }
function esc(s){ return (s??'').toString().replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function api(path, opts={}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type':'application/json', 'x-admin-token': token(), ...(opts.headers||{}) } });
  if (res.status === 401) throw new Error('Token invalid (401).');
  if (res.status === 503) throw new Error('Admin dezactivat (ADMIN_API_TOKEN nesetat).');
  if (!res.ok) throw new Error('Eroare ' + res.status);
  return res.json();
}

async function loadAll() {
  if (!token()) { setStatus('Lipsește token-ul.', 'err'); return; }
  try {
    const [lines, sel, conv, calls] = await Promise.all([
      api('/admin/lines'), api('/admin/sellers'), api('/admin/conversations'), api('/admin/calls'),
    ]);
    LINES = lines.lines; SELLERS = sel.sellers;
    renderLines(lines.lines); renderSellers(sel.sellers); renderConvs(conv.conversations); renderCalls(calls.calls);
    setStatus(\`\${lines.count} linii · \${sel.count} vânzători · \${conv.count} conversații · \${calls.count} apeluri\`, 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
}

function renderLines(rows) {
  const rc = (l) => l.rc_configured
    ? '<span class="pill active">cont propriu'+(l.rc_use_a2p?' · A2P':'')+'</span>'
    : '<span class="muted">global (.env)</span>';
  $('#lineTable tbody').innerHTML = rows.map(l =>
    '<tr><td>'+esc(l.name)+'</td><td><code>'+esc(l.phone)+'</code></td>'
    + '<td>'+rc(l)+'</td>'
    + '<td><span class="pill '+(l.is_active?'active':'inactive')+'">'+(l.is_active?'activ':'inactiv')+'</span></td>'
    + '<td class="muted">'+ (l.sellers.map(s=>esc(s.name)).join(', ')||'—') +'</td></tr>').join('')
    || '<tr><td colspan="5" class="muted">Nicio linie. Adaugă una mai jos.</td></tr>';
  // line dropdowns (seller-create + RC form)
  $('#nLine').innerHTML = '<option value="">(fără linie)</option>' + rows.map(l=>'<option value="'+l.id+'">'+esc(l.name)+'</option>').join('');
  $('#rcLine').innerHTML = rows.map(l=>'<option value="'+l.id+'">'+esc(l.name)+' ('+esc(l.phone)+')</option>').join('');
}
function renderSellers(rows) {
  const numbers = (s) => {
    const list = (s.lines && s.lines.length) ? s.lines : (s.line ? [{line_name:s.line.name, telegram_topic_id:null}] : []);
    if (!list.length) return '<span class="muted">—</span>';
    return list.map(m => esc(m.line_name) + (m.telegram_topic_id ? ' → topic <code>'+esc(m.telegram_topic_id)+'</code>' : ' <span class="muted">(fără topic)</span>')).join('<br>');
  };
  $('#sellerTable tbody').innerHTML = rows.map(s =>
    '<tr><td>'+esc(s.name)+'</td><td>'+numbers(s)+'</td>'
    + '<td class="row"><input id="tg_'+s.id+'" value="'+esc(s.telegramUserId||'')+'" placeholder="ID / grup -100…" style="width:160px" />'
    + '<button class="ghost" onclick="saveTg(\\''+s.id+'\\')">💾</button></td>'
    + '<td><span class="pill '+(s.isActive?'active':'inactive')+'">'+(s.isActive?'activ':'inactiv')+'</span></td>'
    + '<td><button class="ghost" onclick="toggle(\\''+s.id+'\\','+(!s.isActive)+')">'+(s.isActive?'Dezactivează':'Activează')+'</button></td></tr>').join('')
    || '<tr><td colspan="5" class="muted">Niciun vânzător.</td></tr>';
  // membership form dropdowns
  $('#mSeller').innerHTML = rows.map(s=>'<option value="'+s.id+'">'+esc(s.name)+'</option>').join('');
  $('#mLine').innerHTML = LINES.map(l=>'<option value="'+l.id+'">'+esc(l.name)+'</option>').join('');
}
function renderConvs(rows) {
  const opts=(sel)=>SELLERS.map(s=>'<option value="'+s.id+'"'+(sel===s.id?' selected':'')+'>'+esc(s.name)+'</option>').join('');
  $('#convTable tbody').innerHTML = rows.map(c =>
    '<tr><td><code>'+esc(c.contact.phone)+'</code></td>'
    + '<td class="muted">'+esc(c.line?c.line.name:'—')+'</td>'
    + '<td><span class="pill '+esc(c.contact.status)+'">'+esc(c.contact.status)+'</span></td>'
    + '<td>'+esc(c.seller?c.seller.name:'—')+'</td>'
    + '<td class="muted">'+esc((c.last_message||'').slice(0,45))+'</td>'
    + '<td class="row"><select id="rs_'+c.id+'">'+opts(c.seller?c.seller.id:'')+'</select>'
    + '<button onclick="reassign(\\''+c.id+'\\')">Mută</button></td></tr>').join('')
    || '<tr><td colspan="6" class="muted">Nicio conversație.</td></tr>';
}
function renderCalls(rows) {
  $('#callTable tbody').innerHTML = rows.map(c =>
    '<tr><td><code>'+esc(c.client)+'</code></td>'
    + '<td class="muted">'+esc(c.line?c.line.name:'—')+'</td>'
    + '<td>'+esc(c.seller?c.seller.name:'—')+'</td>'
    + '<td><span class="pill '+esc(c.result)+'">'+esc(c.result)+'</span></td>'
    + '<td class="muted">'+(c.duration_sec!=null?c.duration_sec+'s':'—')+'</td>'
    + '<td class="muted">'+esc((c.started_at||'').replace('T',' ').slice(0,16))+'</td></tr>').join('')
    || '<tr><td colspan="6" class="muted">Niciun apel.</td></tr>';
}

async function createLine() {
  const name=$('#lName').value.trim(), phone=$('#lPhone').value.trim();
  if(!name||!phone){ setStatus('Nume + număr obligatorii.','err'); return; }
  try { await api('/admin/lines',{method:'POST',body:JSON.stringify({name,phone_e164:phone})}); $('#lName').value='';$('#lPhone').value=''; setStatus('Linie adăugată.','ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}
async function setLineRc() {
  const id=$('#rcLine').value;
  if(!id){ setStatus('Alege o linie.','err'); return; }
  const body={
    rc_client_id:$('#rcClientId').value.trim()||null,
    rc_client_secret:$('#rcSecret').value.trim()||null,
    rc_jwt:$('#rcJwt').value.trim()||null,
    rc_server_url:$('#rcServer').value.trim()||null,
    rc_use_a2p:$('#rcA2p').checked,
  };
  try { await api('/admin/lines/'+id,{method:'PATCH',body:JSON.stringify(body)});
    $('#rcClientId').value='';$('#rcSecret').value='';$('#rcJwt').value='';$('#rcServer').value='';$('#rcA2p').checked=false;
    setStatus('Cont RC salvat pentru linie.','ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}
async function createSeller() {
  const name=$('#nName').value.trim(), tg=$('#nTg').value.trim(), line_id=$('#nLine').value||undefined, telegram_topic_id=$('#nTopic').value.trim()||undefined;
  if(!name){ setStatus('Numele e obligatoriu.','err'); return; }
  try { await api('/admin/sellers',{method:'POST',body:JSON.stringify({name,telegram_user_id:tg||undefined,line_id,telegram_topic_id})}); $('#nName').value='';$('#nTg').value='';$('#nTopic').value=''; setStatus('Vânzător adăugat.','ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}
async function addSellerLine() {
  const seller_id=$('#mSeller').value, line_id=$('#mLine').value, telegram_topic_id=$('#mTopic').value.trim()||null;
  if(!seller_id||!line_id){ setStatus('Alege vânzător + linie.','err'); return; }
  try { await api('/admin/seller-lines',{method:'POST',body:JSON.stringify({seller_id,line_id,telegram_topic_id})}); $('#mTopic').value=''; setStatus('Setat.','ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}
async function toggle(id, active) { try { await api('/admin/sellers/'+id,{method:'PATCH',body:JSON.stringify({is_active:active})}); loadAll(); } catch(e){ setStatus(e.message,'err'); } }
async function saveTg(id) {
  const v=$('#tg_'+id).value.trim();
  try { await api('/admin/sellers/'+id,{method:'PATCH',body:JSON.stringify({telegram_user_id:v||null})}); setStatus('Telegram ID salvat.','ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}
async function reassign(convId) {
  const newId=$('#rs_'+convId).value;
  try { await api('/admin/reassign-conversation',{method:'POST',body:JSON.stringify({conversation_id:convId,new_seller_id:newId})}); setStatus('Reasignat.','ok'); loadAll(); }
  catch(e){ setStatus(e.message,'err'); }
}

$('#token').value = token();
if (token()) loadAll();
</script>
</body>
</html>`;

panelRouter.get('/', (_req, res) => {
  res.type('html').send(HTML);
});
