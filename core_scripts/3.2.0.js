// AutoSuite CORE v3.2.0
(function(){
'use strict';

const CORE_VERSION = '3.3.2-optionD';

// --- Page window bridge (Tampermonkey sandbox-safe) ---
const UW = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;


/* ---------------- Base config ---------------- */
const DELAYS={modal:5000,openWait:5000,step:900,ajax:1200,swal:1200,retry:250,modalClose:3000,afterClose:5000,pageTurn:1100,tableRedrawPoll:150,tableRedrawTimeout:6000};
const KEYS={
  uiMin:'master_ui_minimized',
  mode:'master_mode',
  profiles:'master_profiles_v1'
};

const MODES={
  UPS:{label:'UPS',  accent:'#ffcb05', bg:'#221b17', border:'#5a4639', muted:'#3a2e28', primary:'#745e4d', iconText:'UPS'},
  DPD:{label:'DPD',  accent:'#dc2626', bg:'#1f0f12', border:'#5c1c20', muted:'#2b1418', primary:'#7f1d1d', iconText:'DPD'},
  GLS:{label:'GLS',  accent:'#f59e0b', bg:'#1b160e', border:'#5a4521', muted:'#2a2315', primary:'#7c5a16', iconText:'GLS'}
};

const state={
  logs:[],
  running:false,
  runToken:0,
  processedDates:new Set(),
  lastPickedDate:null,
  ready:false,
  currentDriverName:null,
  mode:'UPS',
  otPlan:null,
  // for pause-cleaner flow
  cleanedThisDriver:false
};

/* ---------------- Utils ---------------- */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const q=(m,s)=>m.querySelector(s);
const qa=(m,s)=>Array.from(m.querySelectorAll(s));
const pad2=n=>String(n).padStart(2,'0');
const toTimeStr=m=>`${pad2(Math.floor(m/60))}:${pad2(m%60)}`;
const timeStrToMins=t=>{const [h,m]=(t||'').split(':').map(Number);return(isNaN(h)||isNaN(m))?null:(h*60+m);};
const randInt=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const deDateStrToDate=s=>{const [d,m,y]=s.split('.').map(Number);return new Date(y,m-1,d);};
function GM_SetValueSafe(k,v){try{GM_setValue(k,v);}catch{}}
function GM_GetValueSafe(k,d){try{return GM_getValue(k,d);}catch{return d;}}
function log(m){const ts=new Date().toLocaleTimeString();state.logs.unshift(`[${ts}] ${m}`);if(state.logs.length>350)state.logs.length=350;const box=$('#mt_log');if(box)box.textContent=state.logs.join('\n');}
function logErr(e, where=''){const msg = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e);log(`❌ ERROR ${where ? '('+where+')' : ''}: ${msg}`);console.error('MASTER AutoSuite ERROR', where, e);}
const ABORT=Symbol('ABORT');
function requireToken(t){if(state.runToken!==t)throw ABORT;}
function setRunning(on){state.running=on;}
async function cancellableSleep(ms,token,step=100){const s=Date.now();while(Date.now()-s<ms){requireToken(token);await new Promise(r=>setTimeout(r,Math.min(step,ms)));}}
async function waitFor(cond,timeout,token,poll=150){const t0=Date.now();while(Date.now()-t0<timeout){requireToken(token);const v=cond();if(v)return v;await cancellableSleep(poll,token);}return null;}
function setVal(el,v){if(!el)return;el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}

/* ---------------- KM helpers ---------------- */
function parseKmInt(s){if(!s)return 0;const m=String(s).replace(/,/g,'.').match(/\d+(\.\d+)?/);if(!m)return 0;const n=Math.floor(parseFloat(m[0]));return isNaN(n)?0:n;}
function parseOtHours(v){const n=parseFloat(String(v||'').replace(',','.'));return (isNaN(n)||n<0)?0:n;}
function formatDashKmDot00(n){const i=parseKmInt(n);return `${i}.00`;}
function setDashKmDot00FromInt(k){const v=formatDashKmDot00(k);const d=$('#mt_km'); if(d)d.value=v;persistProfileLastKm(v);}

/* ---------------- Driver / Profiles ---------------- */
function normName(name){return (name||'').replace(/\s+/g,' ').trim().toLowerCase();}
function loadProfiles(){const raw=GM_GetValueSafe(KEYS.profiles,'');if(!raw) return {};try{return JSON.parse(raw)||{};}catch{return {};}}
function saveProfiles(obj){GM_SetValueSafe(KEYS.profiles, JSON.stringify(obj||{}));}
function getSelectedDriverName(){const txt = ($('#select2-staff_id-container')?.textContent || '').trim();if(txt) return txt;const sel = $('#staff_id');const opt = sel?.selectedOptions?.[0];return (opt?.textContent||'').trim();}
function selectDriverByName(name){const sel = $('#staff_id');if(!sel) return false;const target=(name||'').trim().toLowerCase();const opts=Array.from(sel.options||[]);const found=opts.find(o => (o.textContent||'').replace(/\s+/g,' ').trim().toLowerCase() === target);if(!found) return false;sel.value=found.value;sel.dispatchEvent(new Event('change',{bubbles:true}));try{ if(window.jQuery) window.jQuery(sel).trigger('change'); }catch{}return true;}
async function waitForDriverApplied(name, token){const want=normName(name);await waitFor(()=>{const cur=normName(getSelectedDriverName());return (cur && cur===want) ? true : null;}, 8000, token, 150);await cancellableSleep(500, token);}

/* ---------------- Signature pad on DASHBOARD ---------------- */
function setupDashSignaturePad(){
  const el=$('#mt_sig_pad');
  if(!el || !window.jQuery || typeof window.jQuery.fn.signature!=='function') return;
  const $pad=window.jQuery(el);
  try{
    if(!$pad.data('kbwSignature')){
      $pad.signature({background:'#ffffff', color:'#000000', thickness:2});
    }
    const refreshStatus=()=>{
      try{ $('#mt_sig_status').textContent = $pad.signature('isEmpty') ? 'Signatur: leer' : 'Signatur: OK'; }catch{}
    };
    refreshStatus();
    el.addEventListener('mouseup', refreshStatus);
    el.addEventListener('touchend', refreshStatus);
    $('#mt_sig_clear')?.addEventListener('click', ()=>{
      try{ $pad.signature('clear'); $('#mt_sig_status').textContent='Signatur: leer'; }catch{}
    });
  }catch(e){
    console.warn('setupDashSignaturePad failed', e);
  }
}
function sigPadHasInk(){
  try{
    const el=$('#mt_sig_pad');
    if(!el || !window.jQuery || typeof window.jQuery.fn.signature!=='function') return false;
    return !window.jQuery(el).signature('isEmpty');
  }catch{return false;}
}

/* ---------------- Profiles: per-driver, per-mode ---------------- */
function profileKey(driverName){return `${state.mode}::${normName(driverName)}`;}
function persistProfileLastKm(kmDot00){
  const driver = state.currentDriverName || getSelectedDriverName();
  const name=(driver||'').trim(); if(!name) return;
  const profiles=loadProfiles();
  const key=profileKey(name);
  if(!profiles[key]) profiles[key]={name,mode:state.mode,fahrzeug:'',lastKm:'',sig:null};
  profiles[key].lastKm = kmDot00;
  saveProfiles(profiles);
}
function saveCurrentSetupToProfile(){
  const driver = state.currentDriverName || getSelectedDriverName();
  const name=(driver||'').trim(); if(!name) return false;
  const fzg = ($('#mt_fzg')?.value||'').trim();
  const km  = formatDashKmDot00($('#mt_km')?.value||'');
  if(!fzg || !parseKmInt(km)) return false;
  if(!sigPadHasInk()) return false;
  const profiles=loadProfiles();
  const key=profileKey(name);
  const otMin=parseOtHours($('#mt_ot_min')?.value);
  const otMax=parseOtHours($('#mt_ot_max')?.value);
  let sigJson=null;
  try{ const pad=$('#mt_sig_pad'); if(pad && window.jQuery && typeof window.jQuery.fn.signature==='function'){ sigJson = window.jQuery(pad).signature('toJSON'); } }catch{}
  profiles[key]={name,mode:state.mode,fahrzeug:fzg,lastKm:km,sig:{json:sigJson},otMin,otMax};
  saveProfiles(profiles);
  return true;
}
function loadProfileToDashboard(name){
  const profiles=loadProfiles();
  const prof=profiles[profileKey(name)];
  if(!prof) return false;
  $('#mt_fzg').value = prof.fahrzeug || '';
  $('#mt_km').value  = formatDashKmDot00(prof.lastKm || '');
  if($('#mt_ot_min')) $('#mt_ot_min').value = (prof.otMin!=null? String(prof.otMin):'');
  if($('#mt_ot_max')) $('#mt_ot_max').value = (prof.otMax!=null? String(prof.otMax):'');
  try{
    const pad=$('#mt_sig_pad');
    if(pad && window.jQuery && typeof window.jQuery.fn.signature==='function'){
      const $pad=window.jQuery(pad);
      $pad.signature('clear');
      if(prof.sig?.json){
        $pad.signature('draw', prof.sig.json);
        $('#mt_sig_status').textContent = $pad.signature('isEmpty') ? 'Signatur: leer' : 'Signatur: OK';
      }else{
        $('#mt_sig_status').textContent='Signatur: leer';
      }
    }
  }catch(e){ console.warn('loadProfileToDashboard signature failed', e); }
  return true;
}

/* ---------------- Ready gate ---------------- */
function setReady(on){state.ready=!!on;const b=$('#mt_ready_btn');if(b)b.textContent=state.ready?'✅ ALLES BEREIT':'ALLES BEREIT';}
async function waitForReady(driverName, token){setReady(false);log(`⏸ Warten auf "ALLES BEREIT" für: ${driverName}`);await waitFor(()=> state.ready ? true : null, 24*60*60*1000, token, 200);log(`▶️ Start für: ${driverName}`);}

/* ---------------- Modal helpers ---------------- */
async function waitForModal(token){
  const r=await waitFor(()=>{const m=$('#working_time_modal');if(!m)return null;const shown=m.classList.contains('show') && getComputedStyle(m).display!=='none';return shown?m:null;}, DELAYS.modal+4000, token, 200);
  return r||$('#working_time_modal');
}
async function waitForModalClosed(token){
  const ok=await waitFor(()=>{const m=$('#working_time_modal');return(!m||!m.classList.contains('show')||getComputedStyle(m).display==='none')?true:null;}, DELAYS.modalClose+4000, token, 150);
  return !!ok;
}
function findConfirmYesButton(){
  let btn=$('.swal2-container .swal2-confirm.swal2-styled');
  if(btn)return btn;
  btn=$$('button,a').find(b=>/^\s*Ja\s*$/i.test(b.textContent||'')&&b.offsetParent!==null);
  if(btn)return btn;
  btn=$$('.modal.show .modal-footer .btn-primary, .bootbox .btn-primary, .modal.show .btn.btn-primary').find(b=>/\b(Ja|OK|Ok)\b/i.test(b.textContent||''));
  return btn||null;
}
async function waitForSwalConfirm(token){
  const dlg=await waitFor(()=>$('.swal2-container')||$('.bootbox')||$('.modal.show .modal-dialog'), 6000, token, 120);
  if(dlg)log('Bestätigungsdialog erkannt');
  return await waitFor(()=>findConfirmYesButton(), 6000, token, 150);
}

/* ---------------- Theme / UI ---------------- */
GM_addStyle(`
.mt-wrap{position:fixed;left:360px;bottom:24px;z-index:999999;display:flex;gap:12px;align-items:flex-start}
.mt-card{background:var(--mt-bg);color:#eee;border-radius:14px;box-shadow:0 10px 28px rgba(0,0,0,.35);padding:12px;font:12px/1.45 system-ui,Segoe UI,Roboto;min-width:340px;border:1px solid var(--mt-border)}
.mt-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px}
.mt-title{font-weight:900;letter-spacing:.5px;color:var(--mt-accent);display:flex;align-items:center;gap:8px}
.mt-minbtn{appearance:none;border:0;border-radius:8px;padding:6px 8px;background:var(--mt-muted);color:#fff;cursor:pointer;font-weight:800}
.mt-row{display:flex;gap:8px;margin:6px 0;flex-wrap:wrap}
.mt-btn{appearance:none;border:0;border-radius:10px;padding:8px 10px;cursor:pointer;font-weight:900}
.mt-btn.primary{background:var(--mt-primary);color:#fff}
.mt-btn.muted{background:var(--mt-muted);color:#fff}
.mt-btn.danger{background:#a33;color:#fff}
.mt-field{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.mt-field input, .mt-field textarea, .mt-field select{width:100%;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#fff}
.mt-log{white-space:pre-wrap;background:rgba(0,0,0,.35);border-radius:8px;padding:8px;height:170px;overflow:auto;margin-top:8px;min-width:360px;max-width:660px}
.mt-sign{margin-top:6px;color:rgba(255,255,255,.75);text-align:center}
.mt-hidden{display:none !important}
.mt-toggle{position:fixed;left:360px;bottom:24px;z-index:1000000;background:transparent;border:0;padding:0;cursor:pointer}
.mt-toggle svg{width:48px;height:48px}
.mt-sigbox{margin-top:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px}
.mt-sigrow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.mt-sigstatus{font-weight:900;color:var(--mt-accent)}
.mt-canvas{width:100%;height:120px;background:#fff;border-radius:8px;cursor:crosshair}
.mt-pill{padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);font-weight:900}
`);

function applyTheme(){
  const cfg = MODES[state.mode] || MODES.UPS;
  document.documentElement.style.setProperty('--mt-accent', cfg.accent);
  document.documentElement.style.setProperty('--mt-bg', cfg.bg);
  document.documentElement.style.setProperty('--mt-border', cfg.border);
  document.documentElement.style.setProperty('--mt-muted', cfg.muted);
  document.documentElement.style.setProperty('--mt-primary', cfg.primary);
  const title=$('#mt_title');
  if(title) title.textContent = `AutoSuite MASTER — ${cfg.label}`;
  const iconText=$('#mt_icon_text');
  if(iconText) iconText.textContent = cfg.iconText;
  const modeSel=$('#mt_mode');
  if(modeSel && modeSel.value!==state.mode) modeSel.value=state.mode;
}

function injectUI(){
  const existing = $('#mt_card');
  if(existing){
    const v = existing.getAttribute('data-core')||'';
    if(v === CORE_VERSION) return;
    // remove old UI from previous core versions
    const wrap = existing.closest('.mt-wrap');
    if(wrap) wrap.remove(); else existing.remove();
  }

  const wrap=document.createElement('div');
  wrap.className='mt-wrap';
  wrap.innerHTML=`
    <div class="mt-card" id="mt_card" data-core="${CORE_VERSION}">
      <div class="mt-header">
        <div class="mt-title">
          <span class="mt-pill" id="mt_badge">${state.mode}</span>
          <span id="mt_title">AutoSuite MASTER — ${state.mode}</span>
        </div>
        <button class="mt-minbtn" id="mt_minimize">Minimieren</button>
      </div>

      <div class="mt-field">
        <label>Modus</label>
        <select id="mt_mode">
          <option value="UPS">UPS</option>
          <option value="DPD">DPD</option>
          <option value="GLS">GLS</option>
        </select>
      </div>

      <div style="font-weight:900;margin:10px 0 6px;">Setup (Fahrzeug + Start-KM + Signatur)</div>
      <div class="mt-field"><label>Fahrzeug / Vozilo</label><input id="mt_fzg" type="text"></div>
      <div class="mt-field"><label>Start-KM / Početni KM</label><input id="mt_km" type="text" placeholder="z.B. 215000.00"></div>

      <div style="font-weight:900;margin:10px 0 6px;">Überstunden Ziel (Monat)</div>
      <div class="mt-row">
        <div class="mt-field" style="flex:1;min-width:140px"><label>Von (Std)</label><input id="mt_ot_min" type="number" step="0.5" min="0" placeholder="z.B. 5"></div>
        <div class="mt-field" style="flex:1;min-width:140px"><label>Bis (Std)</label><input id="mt_ot_max" type="number" step="0.5" min="0" placeholder="z.B. 8"></div>
      </div>

      <div class="mt-sigbox">
        <div class="mt-sigrow">
          <div class="mt-sigstatus" id="mt_sig_status">Signatur: leer</div>
          <button class="mt-btn danger" id="mt_sig_clear">Clear</button>
        </div>
        <div id="mt_sig_pad" class="mt-canvas"></div>
        <div style="margin-top:6px;opacity:.9;">➡️ Zeichne hier die Signatur für den aktuellen Fahrer.</div>
      </div>

      <div class="mt-row">
        <button class="mt-btn primary" id="mt_ready_btn">ALLES BEREIT</button>
        <button class="mt-btn muted"   id="mt_stop">Stop / Zaustavi</button>
      </div>

      <hr style="border:0;border-top:1px solid rgba(255,255,255,.12);margin:10px 0">

      <div style="font-weight:900;margin-bottom:6px;">Single Driver (aktueller Fahrer im Dropdown)</div>
      <div class="mt-row">
        <button class="mt-btn primary" id="mt_start_auto">Auto Start (1 Fahrer)</button>
      </div>

      <div style="font-weight:900;margin:10px 0 6px;">Nur 1 Tag bearbeiten (Modal muss offen sein)</div>
      <div class="mt-row">
        <button class="mt-btn primary" id="mt_one_day">Nur 1 Tag</button>
      </div>

      <div style="font-weight:900;margin:10px 0 6px;">Duplikate Pausen (SO/RP)</div>
      <div class="mt-row">
        <button class="mt-btn primary" id="mt_clean_one_open">Duplikate (1 Tag, Modal offen)</button>
        <button class="mt-btn primary" id="mt_clean_page">Duplikate (Fahrer, diese Seite)</button>
        <button class="mt-btn primary" id="mt_clean_driver">Duplikate (ganzer Fahrer)</button>
      </div>
<div style="font-weight:900;margin:10px 0 6px;">Multi Driver (Liste unten)</div>
      <div class="mt-field">
        <label>Fahrer-Liste (eine Zeile pro Fahrer)</label>
        <textarea id="mt_driver_list" rows="6" placeholder="z.B.&#10;Aleksandar Ichkov&#10;David Györi&#10;..."></textarea>
      </div>
      <div class="mt-row">
        <button class="mt-btn primary" id="mt_multi_start">Start Multi</button>
      </div>

      <div class="mt-log" id="mt_log"></div>
      <div class="mt-sign">Entwickelt von ICHKOV</div>
    </div>
  `;
  document.body.appendChild(wrap);
// Toggle icon
  const toggle=document.createElement('button');
  toggle.className='mt-toggle';
  toggle.id='mt_toggle_btn';
  toggle.innerHTML=`
    <svg viewBox="0 0 64 64" aria-label="AutoSuite">
      <rect x="2" y="2" width="60" height="60" rx="12" fill="var(--mt-bg)"></rect>
      <path fill="var(--mt-accent)" d="M32 10c6 4 12 6 20 6v16c0 14-11 22-20 24-9-2-20-10-20-24V16c8 0 14-2 20-6z"/>
      <text id="mt_icon_text" x="32" y="38" text-anchor="middle" font-size="16" font-family="Segoe UI, Arial" fill="var(--mt-bg)" font-weight="900">${state.mode}</text>
    </svg>
  `;
  document.body.appendChild(toggle);

  function applyMinimizedUI(min){
    const card=$('#mt_card'); const tbtn=$('#mt_toggle_btn');
    if(min){ card.classList.add('mt-hidden'); tbtn.classList.remove('mt-hidden'); }
    else { card.classList.remove('mt-hidden'); tbtn.classList.add('mt-hidden'); }
    GM_SetValueSafe(KEYS.uiMin, !!min);
  }

  $('#mt_minimize').addEventListener('click',()=>applyMinimizedUI(true));
  $('#mt_toggle_btn').addEventListener('click',()=>applyMinimizedUI(false));

  // IMPORTANT: default is NOT minimized
  applyMinimizedUI(!!GM_GetValueSafe(KEYS.uiMin,false));

  // Wire mode switch
  $('#mt_mode').addEventListener('change',()=>{
    state.mode = $('#mt_mode').value;
    $('#mt_badge').textContent = state.mode;
    GM_SetValueSafe(KEYS.mode, state.mode);
    applyTheme();
    // reset ready when mode changes
    setReady(false);
    log(`🔁 Modus gewechselt: ${state.mode}`);
  });

  setupDashSignaturePad();
  applyTheme();

  // Buttons
  wireButtons();
}

/* ---------------- Signature replay into modal ---------------- */
async function replaySignature(modal, driverName, token){
  const profiles = loadProfiles();
  const prof = profiles[profileKey(driverName)];
  const sigJson = prof?.sig?.json;

  if (!sigJson) {
    log(`❌ Keine Signatur gespeichert für: ${driverName}`);
    throw ABORT;
  }

  const wrap =
    modal.querySelector('#signature.kbw-signature') ||
    modal.querySelector('.kbw-signature') ||
    modal.querySelector('#signature');

  if (!wrap || !window.jQuery || typeof window.jQuery.fn.signature!=='function') {
    log('⚠️ Signaturfeld nicht gefunden');
    throw ABORT;
  }

  const $wrap = window.jQuery(wrap);
  const sigInst = $wrap.data('kbwSignature');

  if (!sigInst) {
    log('⚠️ kbwSignature Instanz nicht gefunden');
    throw ABORT;
  }

  await cancellableSleep(150, token);

  try {
    $wrap.signature('clear');
    await cancellableSleep(80, token);
    $wrap.signature('draw', sigJson);
    await cancellableSleep(120, token);
  } catch (e) {
    console.error('modal signature draw failed', e);
    log('❌ Signatur konnte nicht gesetzt werden');
    throw ABORT;
  }

  try { if (typeof sigInst._changed === 'function') sigInst._changed(); } catch {}
  try {
    wrap.dispatchEvent(new Event('change', { bubbles: true }));
    wrap.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {}

  await cancellableSleep(120, token);

  try {
    if ($wrap.signature('isEmpty')) {
      log('❌ Signatur blieb leer');
      throw ABORT;
    }
  } catch (e) {
    if (e === ABORT) throw e;
    log('❌ Signaturprüfung fehlgeschlagen');
    throw ABORT;
  }

  log('✅ Signatur gesetzt');
}

/* ---------------- Plan generators (mode-specific) ---------------- */
function genPlanUPS(dateStr){
  const d=deDateStrToDate(dateStr);
  const wd=d.getDay(); // Sun=0..Sat=6
  if (wd===0 || wd===6) return null;

  const START_MIN = timeStrToMins('06:40'), START_MAX = timeStrToMins('07:10');

  let END_MIN   = timeStrToMins('15:10');
  let END_MAX   = timeStrToMins('15:45');
  let DUR_MIN   = 510;  // 8:30
  let DUR_MAX   = 540;  // 9:00

  if (wd===2 || wd===3) {             // Tue/Wed
    DUR_MIN = 540;                    // 9:00
    DUR_MAX = 555;                    // 9:15
    END_MAX = timeStrToMins('16:15'); // cap at 16:15
  }

  const start = randInt(START_MIN, START_MAX);

  let wantMin = Math.max(END_MIN, start + DUR_MIN);
  let wantMax = Math.min(END_MAX, start + DUR_MAX);
  if (wantMin > wantMax) {
    wantMin = Math.max(END_MIN, start + DUR_MIN);
    wantMax = Math.max(wantMin, Math.min(END_MAX, start + DUR_MAX));
  }
  const end = randInt(wantMin, wantMax);

  const so1 = { start, end: start + randInt(15,20) };
  const so2 = { start: so1.end + randInt(5,10) };
  so2.end   = so2.start + randInt(115,130);

  const ruDur   = randInt(32,36);
  const rpStart = randInt(timeStrToMins('10:00'), timeStrToMins('12:00') - ruDur);
  const ru      = { start: rpStart, end: rpStart + ruDur };

  const so3 = { start: end - randInt(15,20), end };
  const lenk = { start: so2.end, end };

  const dur = end - start;
  if (dur < DUR_MIN || dur > DUR_MAX) {
    const adjMin = Math.max(END_MIN, start + DUR_MIN);
    const adjMax = Math.min(END_MAX, start + DUR_MAX);
    const adjEnd = Math.min(Math.max(end, adjMin), adjMax);
    so3.end = adjEnd;
    so3.start = adjEnd - randInt(15,20);
    lenk.end = adjEnd;
    return { start, end: adjEnd, so1, so2, ru, so3, lenk };
  }
  return { start, end, so1, so2, ru, so3, lenk };
}

function genPlanDPD(dateStr){
  const d  = deDateStrToDate(dateStr);
  const wd = d.getDay(); // 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri

  // Weekday start/end windows (original)
  let sMin, sMax, eMin, eMax;
  if (wd === 1) { // Monday
    sMin=timeStrToMins('05:55'); sMax=timeStrToMins('06:05');
    eMin=timeStrToMins('14:25'); eMax=timeStrToMins('14:35');
  } else if (wd === 2) { // Tuesday (end window not used; we enforce 8:45–9:00 after start)
    sMin=timeStrToMins('05:25'); sMax=timeStrToMins('05:40');
    eMin=timeStrToMins('14:55'); eMax=timeStrToMins('15:10'); // legacy, unused for end
  } else if (wd === 3) { // Wednesday (STRICT 8:00..8:30)
    sMin=timeStrToMins('05:25'); sMax=timeStrToMins('05:40');
    eMin=timeStrToMins('14:55'); eMax=timeStrToMins('15:10'); // legacy, unused for end
  } else { // Thu/Fri
    sMin=timeStrToMins('05:25'); sMax=timeStrToMins('05:40');
    eMin=timeStrToMins('13:55'); eMax=timeStrToMins('14:10');
  }

  const start = randInt(sMin, sMax);

  // Duration caps
  const MON_THU_FRI_MIN = 480, MON_THU_FRI_MAX = 510; // 8:00..8:30
  const WED_MIN = 480, WED_MAX = 510;                 // 8:00..8:30
  const TUE_MIN = 525, TUE_MAX = 540;                 // 8:45..9:00

  let end;
  if (wd === 1 || wd === 4 || wd === 5) {
    // Mon/Thu/Fri: inside weekday end window AND within 8:00..8:30
    const wantMin = start + MON_THU_FRI_MIN;
    const wantMax = start + MON_THU_FRI_MAX;
    const interMin = Math.max(eMin, wantMin);
    const interMax = Math.min(eMax, wantMax);
    end = (interMin <= interMax) ? randInt(interMin, interMax)
                                 : Math.max(wantMin, Math.min(wantMax, eMax)); // safety clamp
  } else if (wd === 2) {
    // Tuesday: ALWAYS 8:45..9:00 after start (ignore legacy late window)
    end = randInt(start + TUE_MIN, start + TUE_MAX);
  } else { // Wednesday
    // Wednesday: STRICT 8:00..8:30 after start (ignore legacy window)
    end = randInt(start + WED_MIN, start + WED_MAX);
  }

  // Pauses
  const so1 = { start, end: start + randInt(17,20) };
  const so2 = { start: so1.end + randInt(7,13) }; so2.end = so2.start + randInt(115,130); // 1:55–2:10

  // Ruhepause 31–37 min between 10:50–11:50
  const ruDur = randInt(31,37);
  const rpStart = randInt(timeStrToMins('10:50'), timeStrToMins('11:50') - ruDur);
  const ru = { start: rpStart, end: rpStart + ruDur };

  // Lenk: begins at end of 2nd SO, ends at Arbeitsende
  const lenk = { start: so2.end, end };

  // Last SO: 15–20 min before end → till end
  const so3 = { start: end - randInt(15,20), end };

  return { start, end, so1, so2, ru, so3, lenk };
}

function genPlanGLS(dateStr){
  const d=deDateStrToDate(dateStr);
  const wd=d.getDay(); // 1=Mon .. 5=Fri

  const START_MIN = timeStrToMins('05:00'), START_MAX = timeStrToMins('06:30');
  const END_MIN   = timeStrToMins('15:10'), END_MAX   = timeStrToMins('15:45');
  const DUR_MIN   = 510, DUR_MAX = 540; // 8:30–9:00

  const start = randInt(START_MIN, START_MAX);
  let wantMin = Math.max(END_MIN, start + DUR_MIN);
  let wantMax = Math.min(END_MAX, start + DUR_MAX);
  if (wantMin > wantMax) {
    wantMin = Math.max(END_MIN, start + DUR_MIN);
    wantMax = Math.max(wantMin, Math.min(END_MAX, start + DUR_MAX));
  }
  const end = randInt(wantMin, wantMax);

  const so1 = { start, end: start + randInt(15,20) };
  const so2 = { start: so1.end + randInt(5,10) };
  so2.end   = so2.start + randInt(115,130); // 1:55–2:10

  const ruDur   = randInt(32,36);
  const rpStart = randInt(timeStrToMins('09:00'), timeStrToMins('10:30') - ruDur);
  const ru      = { start: rpStart, end: rpStart + ruDur };

  const so3 = { start: end - randInt(15,20), end };

  const lenk = { start: so2.end, end };

  if (wd>=1 && wd<=5) {
    const dur = end - start;
    if (dur < DUR_MIN || dur > DUR_MAX) {
      const adjMin = Math.max(END_MIN, start + DUR_MIN);
      const adjMax = Math.min(END_MAX, start + DUR_MAX);
      const adjEnd = Math.min(Math.max(end, adjMin), adjMax);
      so3.end = adjEnd;
      so3.start = adjEnd - randInt(15,20);
      lenk.end = adjEnd;
      return { start, end: adjEnd, so1, so2, ru, so3, lenk };
    }
  }
  return { start, end, so1, so2, ru, so3, lenk };
}

function genPlanByMode(dateStr, extraMins=0){
  let plan;
  if(state.mode==='DPD') plan = genPlanDPD(dateStr);
  else if(state.mode==='GLS') plan = genPlanGLS(dateStr);
  else plan = genPlanUPS(dateStr);

  if(!plan) return null;
  extraMins = Math.max(0, Math.floor(extraMins||0));
  if(extraMins<=0) return plan;

  // Extend Arbeitsende to create Überstunden (ALL MODES incl. DPD).
  // NOTE: DPD has stricter base rules, but overtime is allowed when user sets monthly target
  // or uses the manual overtime buttons. We still apply a hard cap per mode to avoid crazy times.

  const capEnd = getHardEndCapByMode(dateStr, plan.start);
  if(capEnd==null) return plan;

  // extraMins here represent *paid overtime minutes* (working time beyond the daily norm).
  // If working time exceeds 9h, break should be 45min instead of 30min (Austrian rule of thumb).
  const breakExtra = (extraMins > 60) ? 15 : 0; // +15 min to go from 30->45
  const totalAdd = extraMins + breakExtra;

  const newEnd = Math.min(capEnd, plan.end + totalAdd);
  const delta = newEnd - plan.end;
  if(delta<=0) return plan;

  // If break increases, extend the Ruhepause block (RP) a bit so total break becomes 45.
  if(breakExtra>0 && plan.ru && typeof plan.ru.end==='number'){
    plan.ru.end = Math.min(plan.ru.end + breakExtra, newEnd - 10);
  }

  plan.end = newEnd;
  plan.so3.end = newEnd;
  plan.so3.start = Math.max(plan.so3.start, newEnd - randInt(15,20));
  plan.lenk.end = newEnd;
  return plan;
}

function getHardEndCapByMode(dateStr, startMins){
  const d = deDateStrToDate(dateStr);
  const wd = d.getDay();

  // GLS
  if(state.mode==='GLS') return timeStrToMins('18:00');

  // UPS
  if(state.mode==='UPS'){
    return timeStrToMins('18:30');
  }

  // DPD (allow overtime; wider headroom for Überstunden)
  if(state.mode==='DPD'){
    const abs = timeStrToMins('17:30'); // hard cap
    const maxFromStart = (startMins!=null) ? (startMins + 750) : abs; // +12h30 max span
    return Math.min(abs, maxFromStart);
  }

  return null;
}

function shuffle(arr){
  const a=arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j=randInt(0,i);
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function buildOvertimePlanForPage(dateList, otMinH, otMaxH){
  const plan=new Map();
  const minH=parseOtHours(otMinH), maxH=parseOtHours(otMaxH);
  if(maxH<=0 || maxH<minH) return plan;
  const targetMins = Math.round(randInt(Math.round(minH*60), Math.round(maxH*60)));
  if(targetMins<=0) return plan;

  // Eligible: Mon–Fri only
  const eligible = dateList.filter(ds=>{
    const d=deDateStrToDate(ds); const wd=d.getDay();
    return wd>=1 && wd<=5;
  });
  if(!eligible.length) return plan;

  let remaining = targetMins;
  const chunk = 15;             // 15-min steps
  const perDayMax = 120;        // don't overdo a single day

  const dates = shuffle(eligible);
  const give = (ds, mins)=>{
    const cur=plan.get(ds)||0;
    plan.set(ds, cur+mins);
  };

  // multi-pass distribution
  let safety=2000;
  while(remaining>0 && safety-- > 0){
    let progressed=false;
    for(const ds of dates){
      if(remaining<=0) break;
      const cur=plan.get(ds)||0;
      const room = perDayMax - cur;
      if(room<=0) continue;
      const maxGive = Math.min(room, remaining);
      const steps = Math.max(1, Math.floor(maxGive/chunk));
      const stepGive = Math.min(maxGive, chunk*randInt(1, steps));
      give(ds, stepGive);
      remaining -= stepGive;
      progressed=true;
    }
    if(!progressed) break;
  }

  if(remaining>0){
    log(`⚠️ Überstunden Ziel zu hoch für diese Seite: Rest ${remaining} min nicht platzierbar (pro Tag max ${perDayMax} min).`);
  } else {
    const total = Array.from(plan.values()).reduce((a,b)=>a+b,0);
    log(`🧮 Überstunden-Plan: Ziel ${Math.round(targetMins/60*10)/10}h (${targetMins} min), verteilt auf ${plan.size} Tage.`);
  }
  return plan;


/* ---------------- Manual overtime add (separate from monthly target) ---------------- */
function buildFixedOvertimePlan(dateList, totalMins){
  const plan=new Map();
  totalMins = Math.max(0, Math.floor(totalMins||0));
  if(totalMins<=0) return plan;

  // Eligible: Mon–Fri only
  const eligible = dateList.filter(ds=>{
    const d=deDateStrToDate(ds); const wd=d.getDay();
    return wd>=1 && wd<=5;
  });
  if(!eligible.length) return plan;

  let remaining = totalMins;
  const chunk = 15;             // 15-min steps
  const perDayMax = 120;         // keep manual add modest by default

  const dates = shuffle(eligible);
  const give = (ds, mins)=>{
    const cur=plan.get(ds)||0;
    plan.set(ds, cur+mins);
  };

  let safety=2000;
  while(remaining>0 && safety-- > 0){
    let progressed=false;
    for(const ds of dates){
      if(remaining<=0) break;
      const cur=plan.get(ds)||0;
      const room = perDayMax - cur;
      if(room<=0) continue;
      const maxGive = Math.min(room, remaining);
      const steps = Math.max(1, Math.floor(maxGive/chunk));
      const stepGive = Math.min(maxGive, chunk*randInt(1, steps));
      give(ds, stepGive);
      remaining -= stepGive;
      progressed=true;
    }
    if(!progressed) break;
  }

  if(remaining>0){
    log(`⚠️ Extra-Überstunden zu hoch: Rest ${remaining} min nicht platzierbar (pro Tag max ${perDayMax} min).`);
  } else {
    const total = Array.from(plan.values()).reduce((a,b)=>a+b,0);
    log(`🧮 Extra-Überstunden Plan: ${Math.round(total/60*10)/10}h (${total} min) verteilt auf ${plan.size} Tage.`);
  }
  return plan;
}

function getDateStrFromModal(modal){
  let dateStr=(q(modal,'#end_date')?.value||q(modal,'#start_date')?.value||'').trim();
  if(!/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)){
    const m=(modal.textContent||'').match(/\b\d{2}\.\d{2}\.\d{4}\b/);
    dateStr=m?m[0]:'';
  }
  return dateStr;
}

function getStartMinsFromModal(modal){
  const s=(q(modal,'#start')?.value||'').trim();
  return timeStrToMins(s);
}

function getEndMinsFromModal(modal){
  const e=(q(modal,'#end')?.value||'').trim();
  return timeStrToMins(e);
}

async function deletePauseRowByObj(rowObj, token){
  // rowObj format from readPauseRows(): {tr,start,end,rawType,kind,del}
  const btn=rowObj?.del; if(!btn) return false;
  try{btn.scrollIntoView({block:'center'});}catch{}
  await cancellableSleep(80, token);
  btn.click();
  await cancellableSleep(700, token);
  const t0=Date.now();
  while(Date.now()-t0<6000){
    const confirm=$(CLEAN_CFG.swalConfirmSel);
    if(confirm){ confirm.click(); await cancellableSleep(800, token); break; }
    await cancellableSleep(150, token);
  }
  await cancellableSleep(650, token);
  return true;
}

async function applyExtraOvertimeToOpenModal(modal, extraMins, token){
  extraMins = Math.max(0, Math.floor(extraMins||0));
  if(extraMins<=0){ log('⚠️ Extra-Überstunden: 0'); return; }

  const dateStr = getDateStrFromModal(modal);
  if(!dateStr){ log('Datum im Modal nicht gefunden'); throw ABORT; }

  const startM = getStartMinsFromModal(modal);
  const endM   = getEndMinsFromModal(modal);
  if(startM==null || endM==null){
    log('⚠️ Kann Start/Ende im Modal nicht lesen (bitte sicherstellen, dass Arbeitsbeginn/Arbeitsende gesetzt sind).');
    throw ABORT;
  }

  const cap = getHardEndCapByMode(dateStr, startM);
  const wanted = endM + extraMins;
  const newEnd = (cap!=null) ? Math.min(cap, wanted) : wanted;
  const delta  = newEnd - endM;
  if(delta<=0){ log('⚠️ Extra-Überstunden: keine Verlängerung möglich (Cap erreicht).'); return; }

  // Update Arbeitsende
  setVal(q(modal,'#end'), toTimeStr(newEnd));
  await cancellableSleep(DELAYS.step, token);

  // Update Lenkende (vehicle_end) + save vehicle update
  const pencil=q(modal,'#vehicle_dataList_body .fa-pencil, #vehicle_dataList_body .fa-pencil-alt, #vehicle_dataList_body .fas.fa-pencil-alt, #vehicle_dataList_body a.text-success');
  if(pencil){pencil.closest('a,button')?.click();await cancellableSleep(DELAYS.ajax,token);}
  const vEnd=q(modal,'#vehicle_end')||q(modal,'input[placeholder="Lenkende"]');
  if(vEnd){ setVal(vEnd,toTimeStr(newEnd)); await cancellableSleep(DELAYS.step,token); }
  q(modal,'#btn_vehicle_update')?.click();
  await cancellableSleep(DELAYS.ajax,token);

  // Update SO3: remove the last SO (latest end), then add a new SO3 ending at newEnd
  try{
    const rows=readPauseRows(modal);
    const soRows = rows.filter(r=>r.kind==='SO').map(r=>{
      const s=timeStrToMins(r.start), e=timeStrToMins(r.end);
      return {...r, s, e};
    }).filter(r=>r.s!=null && r.e!=null);

    if(soRows.length){
      const last = soRows.sort((a,b)=> (b.e-a.e))[0];
      await deletePauseRowByObj(last, token);
      await cancellableSleep(DELAYS.ajax, token);
    }

    const so3Start = Math.max(0, newEnd - randInt(15,20));
    await addPause(modal, 2, toTimeStr(so3Start), toTimeStr(newEnd), token);
  }catch(e){
    log('⚠️ SO3 konnte nicht sauber angepasst werden (Arbeitsende/Lenkende wurden aber gesetzt).');
  }

  log(`✅ Extra-Überstunden hinzugefügt: +${delta} min (${toTimeStr(endM)} → ${toTimeStr(newEnd)})`);
}

async function addOvertimeOneDayOpenModal(token){
  const modal=await waitForModal(token);
  if(!modal || !modal.classList.contains('show')){ log('Bitte zuerst einen Tag öffnen (Bearbeiten).'); throw ABORT; }
  const h=parseOtHours($('#mt_ot_add_hours')?.value);
  const extraMins=Math.round(h*60);
  await cancellableSleep(600, token);
  await applyExtraOvertimeToOpenModal(modal, extraMins, token);

  // Save
  await clickKorrekturBeenden(modal, token);
  const yes=await waitForSwalConfirm(token); if(yes) yes.click();
  await waitForModalClosed(token);
  await cancellableSleep(DELAYS.afterClose, token);
}

async function collectAllDatesAcrossPages(token){
  const all=[];
  let page=1;
  // Go to first page if possible
  const goFirst = ()=>{
    const a = $('a.page-link[data-dt-idx="1"]') || $$('.page-link').find(x=> (x.textContent||'').trim()==='1');
    if(a){ a.click(); return true; }
    return false;
  };
  goFirst();
  await cancellableSleep(DELAYS.pageTurn, token);

  while(true){
    requireToken(token);
    const table=findTimeTable(); if(!table) break;
    const tbody=table.tBodies[0]||table.querySelector('tbody'); if(!tbody) break;
    const rows=Array.from(tbody.querySelectorAll('tr')).filter(r=>r.querySelector('td'));
    const dates=Array.from(new Set(rows.map(r=>getRowDate(r)).filter(Boolean)));
    for(const d of dates) all.push(d);

    const next=findNextLink();
    if(!next) break;
    const firstRowBefore=$('#data_table tbody tr');
    const firstDateBefore=(firstRowBefore?.querySelector('td.sorting_1')?.textContent||'').trim();
    next.click();
    await cancellableSleep(DELAYS.pageTurn, token);
    await waitForTableRedraw(firstDateBefore, token);
    page++;
  }
  return Array.from(new Set(all));
}

async function addOvertimeWholeMonth(token){
  const h=parseOtHours($('#mt_ot_add_hours')?.value);
  const totalMins=Math.round(h*60);
  if(totalMins<=0){ alert('Bitte Std eingeben (z.B. 5).'); throw ABORT; }

  // Build distribution across ALL pages (whole month/driver)
  log('📅 Sammle alle Datumseinträge (ganzer Fahrer)…');
  const dates = await collectAllDatesAcrossPages(token);
  if(!dates.length){ log('Keine Daten gefunden.'); throw ABORT; }

  const dist = buildFixedOvertimePlan(dates, totalMins);

  // Back to first page
  const a = $('a.page-link[data-dt-idx="1"]') || $$('.page-link').find(x=> (x.textContent||'').trim()==='1');
  if(a){ a.click(); await cancellableSleep(DELAYS.pageTurn, token); }

  let page=1;
  while(true){
    requireToken(token);
    log(`⏱ Extra-Überstunden anwenden: Seite ${page}…`);
    const table=findTimeTable(); if(!table) break;
    const tbody=table.tBodies[0]||table.querySelector('tbody'); if(!tbody) break;
    const rows=Array.from(tbody.querySelectorAll('tr')).filter(r=>r.querySelector('td'));
    const processed=new Set();

    for(const tr of rows){
      requireToken(token);
      const dateStr=getRowDate(tr); if(!dateStr || processed.has(dateStr)) continue;
      const mins = dist.get(dateStr) || 0;
      if(mins<=0){ processed.add(dateStr); continue; }

      const btn=findEditButton(tr); if(!btn){ processed.add(dateStr); continue; }
      btn.click();
      const modal=await waitForModal(token); if(!modal){ processed.add(dateStr); continue; }
      await cancellableSleep(DELAYS.openWait, token);

      await applyExtraOvertimeToOpenModal(modal, mins, token);

      await clickKorrekturBeenden(modal, token);
      const yes=await waitForSwalConfirm(token); if(yes) yes.click();
      await waitForModalClosed(token);
      await cancellableSleep(DELAYS.afterClose, token);

      processed.add(dateStr);
    }

    const next=findNextLink();
    if(!next) break;
    const firstRowBefore=$('#data_table tbody tr');
    const firstDateBefore=(firstRowBefore?.querySelector('td.sorting_1')?.textContent||'').trim();
    next.click();
    await cancellableSleep(DELAYS.pageTurn, token);
    await waitForTableRedraw(firstDateBefore, token);
    page++;
  }

  log('✅ Extra-Überstunden (Monat) fertig.');
}
}


/* ---------------- Pause helpers (shared) ---------------- */
function normalizePauseType(t){const x=(t||'').toUpperCase();if(x.includes('RUHE')||x.includes('RP'))return 'RP';if(x.includes('SO'))return 'SO';return x.slice(0,3);}
function parsePauses(modal){const rows=qa(modal,'#pause_dataList_body tr');return rows.map(r=>{const tds=r.querySelectorAll('td');if(tds.length<3)return null;const from=tds[0].textContent.trim(),to=tds[1].textContent.trim(),type=normalizePauseType(tds[2].textContent.trim());const s=timeStrToMins(from),e=timeStrToMins(to);if(s==null||e==null)return null;return {type,s,e};}).filter(Boolean);}
function overlaps(a1,a2,b1,b2){const s=Math.max(a1,b1),e=Math.min(a2,b2);return e>s && ((Math.abs(a1-b1)<=3 && Math.abs(a2-b1)<=3) || (e-s)/Math.min(a2-a1,b2-b1)>=0.8);}
function pauseExists(existing,type,s,e){return existing.some(p=>p.type===type && overlaps(p.s,p.e,s,e));}
async function addPause(modal,t,ss,ee,token){setVal(q(modal,'#pause_start'),ss); await cancellableSleep(DELAYS.step,token);setVal(q(modal,'#pause_end'),ee); await cancellableSleep(DELAYS.step,token);
  const pt=q(modal,'#pause_type'); if(pt){pt.value=String(t);pt.dispatchEvent(new Event('change',{bubbles:true}));}
  await cancellableSleep(DELAYS.step,token);
  (q(modal,'#btn_pause_add')||qa(modal,'button,a').find(b=>/Pause hinzufügen|Add Pause/i.test(b.textContent||'')))?.click();
  await cancellableSleep(DELAYS.ajax,token);
}

/* ---------------- Vehicle / StartKM helpers ---------------- */
function selectVehicleByText(modal,txt){const s=q(modal,'#working_time_vehicle_id');if(!s||!txt)return false;const o=[...s.options].find(x=>x.text.trim()===txt.trim());if(!o)return false;s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return true;}
function getStartKmInput(modal){const exact=q(modal,'#start_km')||q(modal,'input[name="start_km"]'); if(exact) return exact;
  const candidates=qa(modal,'input[placeholder], input[id], input[name]');
  for(const el of candidates){const ph=(el.getAttribute('placeholder')||'').toLowerCase(), id=(el.id||'').toLowerCase(), nm=(el.name||'').toLowerCase();
    const looks=/start\s*km/.test(ph)||/^start_km$/.test(id)||/^start_km$/.test(nm);
    const isEnd=el.classList.contains('end_km')||/end[_\s-]*km/.test(ph)||/end[_-]?km/.test(id)||/end[_-]?km/.test(nm);
    const inTbl=!!el.closest('#vehicle_dataList_body');
    if(looks&&!isEnd&&!inTbl) return el;
  }
  return null;
}
function getDashStartKmInt(){return parseKmInt($('#mt_km')?.value||'');}
async function ensureStartKm(modal,valInt,token){const el=getStartKmInput(modal);if(!el){log('⚠️ Start-KM Feld nicht gefunden');return;}const v=String(parseKmInt(valInt));if((el.value||'').trim()!==v){setVal(el,v);await cancellableSleep(DELAYS.step,token);log(`Start-KM gesetzt: ${v}`);}}
async function keepStartKmStable(modal,valInt,token,tries=8){for(let i=0;i<tries;i++){await ensureStartKm(modal,valInt,token);await cancellableSleep(DELAYS.retry,token);}}
function readEndKmFromUIOrTable(modal,startKmInt){const endInput=q(modal,'.end_km')||q(modal,'#end_km');if(endInput&&endInput.value) return parseKmInt(endInput.value);
  const tb=q(modal,'#vehicle_dataList_body'); if(tb){const row=tb.querySelector('tr:last-child'); if(row){const nums=Array.from(row.querySelectorAll('td,th')).map(n=>parseKmInt(n.textContent)).filter(n=>n>0);
        const good=nums.filter(n=>n>=startKmInt); const chosen=good.length?Math.max(...good):(nums.length?Math.max(...nums):0); if(chosen){log(`End-KM erkannt (Tabelle): ${chosen}`);return chosen;}
  }}
  const fb=startKmInt+80; log(`⚠️ End-KM nicht gefunden — Fallback: ${fb}`); return fb;
}
function getSecondSoEndMins(pauses,plan){const sos=pauses.filter(p=>p.type==='SO').sort((a,b)=>a.s-b.s);return (sos.length>=2)?sos[1].e:plan.so2.end;}
function getFzgFromDash(){const name = state.currentDriverName || getSelectedDriverName(); const profiles=loadProfiles(); const prof=profiles[profileKey(name)]; return (prof?.fahrzeug || $('#mt_fzg')?.value || '').trim();}

/* ---------------- Completion (shared, uses plan by mode) ---------------- */
function getDayStatus(modal){
  const hasStart=!!(q(modal,'#start')?.value?.trim());
  const hasEnd  =!!(q(modal,'#end')?.value?.trim());
  const startKmEl=getStartKmInput(modal);
  const hasStartKm=!!(startKmEl&&startKmEl.value&&startKmEl.value.trim());
  const tb=q(modal,'#vehicle_dataList_body');
  const hasVehicleRow=!!(tb&&tb.querySelector('tr'));
  let hasLenkStart=false,hasLenkEnd=false,hasEndKm=false;
  if(hasVehicleRow){
    const vStart=q(modal,'#vehicle_start')||q(modal,'input[placeholder="Lenkbeginn"]');
    const vEnd=q(modal,'#vehicle_end')||q(modal,'input[placeholder="Lenkende"]');
    const endKm=q(modal,'.end_km')||q(modal,'#end_km');
    if(vStart&&vStart.value)hasLenkStart=true;
    if(vEnd&&vEnd.value)hasLenkEnd=true;
    if(endKm&&endKm.value)hasEndKm=true;
    if(!(hasLenkStart&&hasLenkEnd)){
      const last=tb.querySelector('tr:last-child');
      if(last){const times=(last.textContent||'').match(/\b\d{2}:\d{2}\b/g)||[]; if(times[0])hasLenkStart=true; if(times[1])hasLenkEnd=true;}
    }
    if(!hasEndKm){const last=tb.querySelector('tr:last-child'); if(last){const nums=Array.from(last.querySelectorAll('td')).map(td=>parseKmInt(td.textContent)).filter(n=>n>0); if(nums.length)hasEndKm=true;}}
  }
  const pauses=parsePauses(modal);
  const soCount=pauses.filter(p=>p.type==='SO').length;
  const rpCount=pauses.filter(p=>p.type==='RP').length;
  const isComplete=hasStart&&hasEnd&&hasVehicleRow&&hasLenkStart&&hasLenkEnd&&hasEndKm&&(soCount>=3)&&(rpCount>=1);
  return {hasStart,hasEnd,hasStartKm,hasVehicleRow,hasLenkStart,hasLenkEnd,hasEndKm,pauses,isComplete,startKmEl};
}

function findKorrekturBeendenBtn(modal){
  return q(modal,'button[type="submit"][title*="Korrektur Beenden" i]')
      || qa(modal,'button[type="submit"]').find(b=>/Korrektur\s*Beenden/i.test(b.textContent||''))
      || qa(modal,'button, a').find(b=>/Korrektur\s*Beenden/i.test(b.textContent||''));
}
async function clickKorrekturBeenden(modal,token){
  let btn=findKorrekturBeendenBtn(modal);
  if(!btn){ log('⚠️ Korrektur-Beenden Button nicht gefunden'); return false; }
  const form=btn.closest('form')||modal.querySelector('form');
  log('Korrektur Beenden: Submit init');
  try{
    if(form&&typeof form.requestSubmit==='function'){ form.requestSubmit(btn); }
    else {
      try{btn.focus();}catch{}
      btn.click();
      await cancellableSleep(350,token);
      if(!$('.swal2-container')&&!findConfirmYesButton()){ if(form&&typeof form.submit==='function') form.submit(); }
    }
  }catch(e){console.warn('Submit-Fallback Fehler:',e);}
  await cancellableSleep(600,token);
  return true;
}

async function completeDayIfNeeded(modal,dateStr,driver,token){
  requireToken(token);
  const extra=(state.otPlan && state.otPlan.get(dateStr)) || 0;
  const plan=genPlanByMode(dateStr, extra);
  if(!plan){ log(`Übersprungen (Wochenende): ${dateStr}`); return; }

  let status=getDayStatus(modal);
  const dashStartKmInt=getDashStartKmInt();

  if(status.isComplete){
    const endInt=readEndKmFromUIOrTable(modal,dashStartKmInt);
    setDashKmDot00FromInt(endInt);
    log(`Übersprungen (vollständig): ${dateStr} — End-KM übernommen: ${endInt}`);
  } else {
    if(!status.hasStart){ setVal(q(modal,'#start'), toTimeStr(plan.start)); await cancellableSleep(DELAYS.step,token); }

    if(!status.hasVehicleRow){
      const fzg=getFzgFromDash();
      if(fzg) selectVehicleByText(modal,fzg);
      await cancellableSleep(DELAYS.step,token);

      if(dashStartKmInt){ await ensureStartKm(modal,dashStartKmInt,token); await keepStartKmStable(modal,dashStartKmInt,token); }

      q(modal,'#btn_vehicle_add')?.click();
      await cancellableSleep(DELAYS.ajax,token);

      if(dashStartKmInt) await keepStartKmStable(modal,dashStartKmInt,token);
      status=getDayStatus(modal);
    }

    if(!status.hasLenkStart||!status.hasLenkEnd||!status.hasEndKm){
      const pencil=q(modal,'#vehicle_dataList_body .fa-pencil, #vehicle_dataList_body .fa-pencil-alt, #vehicle_dataList_body .fas.fa-pencil-alt, #vehicle_dataList_body a.text-success');
      if(pencil){pencil.closest('a,button')?.click();await cancellableSleep(DELAYS.ajax,token);}
      const endField=q(modal,'.end_km')||q(modal,'#end_km');
      if(endField&&!endField.value){ const endKmInt=dashStartKmInt+randInt(70,90); setVal(endField,String(endKmInt)); await cancellableSleep(DELAYS.step,token); }
      const vEnd=q(modal,'#vehicle_end')||q(modal,'input[placeholder="Lenkende"]');
      if(vEnd&&!vEnd.value){ setVal(vEnd,toTimeStr(plan.lenk.end)); await cancellableSleep(DELAYS.step,token); }
      q(modal,'#btn_vehicle_update')?.click();
      await cancellableSleep(DELAYS.ajax,token);
      if(dashStartKmInt) await keepStartKmStable(modal,dashStartKmInt,token);
      status=getDayStatus(modal);
    }

    // Pausen add-only per selected mode plan
    const need=[
      {type:'SO',val:2,s:plan.so1.start,e:plan.so1.end},
      {type:'SO',val:2,s:plan.so2.start,e:plan.so2.end},
      {type:'RP',val:0,s:plan.ru.start,e:plan.ru.end},
      {type:'SO',val:2,s:plan.so3.start,e:plan.so3.end}
    ];
    const existing=status.pauses.slice();
    for(const n of need){
      if(!pauseExists(existing,n.type,n.s,n.e)){
        await addPause(modal,n.val,toTimeStr(n.s),toTimeStr(n.e),token);
        existing.push({type:n.type,s:n.s,e:n.e});
      }
    }

    // Force Lenkbeginn = Ende 2. SO
    {
      const lenkBeginMins=getSecondSoEndMins(existing,plan);
      const desired=toTimeStr(lenkBeginMins);
      const pencil2=q(modal,'#vehicle_dataList_body .fa-pencil, #vehicle_dataList_body .fa-pencil-alt, #vehicle_dataList_body .fas.fa-pencil-alt, #vehicle_dataList_body a.text-success');
      if(pencil2){pencil2.closest('a,button')?.click();await cancellableSleep(DELAYS.ajax,token);}
      const vStart=q(modal,'#vehicle_start')||q(modal,'input[placeholder="Lenkbeginn"]');
      const vEnd=q(modal,'#vehicle_end')||q(modal,'input[placeholder="Lenkende"]');
      if(vStart&&vStart.value!==desired){ setVal(vStart,desired); await cancellableSleep(DELAYS.step,token); }
      if(vEnd&&!vEnd.value){ setVal(vEnd,toTimeStr(plan.lenk.end)); await cancellableSleep(DELAYS.step,token); }
      q(modal,'#btn_vehicle_update')?.click();
      await cancellableSleep(DELAYS.ajax,token);
      if(dashStartKmInt) await keepStartKmStable(modal,dashStartKmInt,token);
    }

    if(!status.hasEnd){ setVal(q(modal,'#end'), toTimeStr(plan.end)); await cancellableSleep(DELAYS.step,token); }

    await replaySignature(modal, driver, token);

    const endInt=readEndKmFromUIOrTable(modal,dashStartKmInt);
    setDashKmDot00FromInt(endInt);
    log(`End-KM vor Schließen: ${endInt}`);
  }

  const readyToClose=(q(modal,'#end')?.value && (q(modal,'#vehicle_dataList_body')?.querySelector('tr')));
  if(readyToClose){
    const clicked=await clickKorrekturBeenden(modal,token);
    if(clicked){
      const yesBtn=await waitForSwalConfirm(token);
      if(yesBtn){ yesBtn.click(); log('Ja geklickt'); await cancellableSleep(DELAYS.swal,token); }
      else log('⚠️ Kein Bestätigungsbutton gefunden');
    }
    await waitForModalClosed(token);
    await cancellableSleep(DELAYS.afterClose,token);
  }

  log(`Bearbeitet: ${dateStr} — MODE ${state.mode}.`);
}

/* ---------------- Table helpers ---------------- */
function findTimeTable(){
  let t=$('#data_table')||$('#datatable');
  if(t) return t;
  const tables=Array.from(document.querySelectorAll('table'));
  const ranked=tables.map(tbl=>{const s=(tbl.textContent||'').toLowerCase();let score=0;if(s.includes('datum'))score++;if(s.includes('aktionen'))score++;if(s.includes('arbeitsbeginn'))score++;return {tbl,score};}).sort((a,b)=>b.score-a.score);
  return ranked[0]?.tbl||null;
}
function getRowDate(tr){
  // Prefer explicit date column (2nd <td>) as provided in Transportlogy table HTML
  const tds = tr.querySelectorAll('td');
  const cand = (tds[1]?.textContent||'').trim();
  if(/\b\d{2}\.\d{2}\.\d{4}\b/.test(cand)) return cand.match(/\b\d{2}\.\d{2}\.\d{4}\b/)[0];

  // Fallbacks
  const cell=tr.querySelector('td.sorting_1');
  if(cell){const m=cell.textContent.trim().match(/\b\d{2}\.\d{2}\.\d{4}\b/); if(m) return m[0];}
  const m2=(tr.textContent||'').match(/\b\d{2}\.\d{2}\.\d{4}\b/);
  return m2?m2[0]:null;
}
function findEditButton(tr){
  return tr.querySelector('a[onclick*="updateElement"]')
      || tr.querySelector('a[title*="Bearbeiten" i], button[title*="Bearbeiten" i]')
      || tr.querySelector('a[href*="working_time"][data-target="#working_time_modal"]')
      || tr.querySelector('a[href*="working_time"], button[data-target="#working_time_modal"]')
      || tr.querySelector('a .fa-pencil, a .fa-pencil-alt, a .fas.fa-pencil-alt, a.text-success, button .fa-pencil, button .fa-pencil-alt')?.closest('a,button');
}

/* ---------------- Auto loop (ALL PAGES / WHOLE MONTH) ---------------- */
async function runAuto(token){
  state.processedDates.clear();
  state.lastPickedDate=null;

  const driver = state.currentDriverName || getSelectedDriverName() || '(Unbekannt)';
  log(`▶️ Auto gestartet (ganzer Monat / alle Seiten) — MODE ${state.mode} — Fahrer: ${driver}`);

  // Load driver profile (contains Fahrzeug/KM/Signature + Überstunden Ziel)
  const profiles=loadProfiles();
  const prof=profiles[profileKey(driver)]||{};

  // Helpers to collect dates across pagination (same visible month)
  const getPageDates = ()=>{
    const table=findTimeTable();
    const tbody=table?.tBodies?.[0] || table?.querySelector?.('tbody');
    const rows=tbody? Array.from(tbody.querySelectorAll('tr')).filter(r=>r.querySelector('td')) : [];
    return Array.from(new Set(rows.map(r=>getRowDate(r)).filter(Boolean)));
  };
  const monthKey = (ds)=>{
    const d=deDateStrToDate(ds);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  };
  const findFirstPageLink = ()=>{
    // DataTables uses dt-idx: "first" or "1"
    let a = $('a.page-link[aria-controls="data_table"][data-dt-idx="first"]');
    if(a){ const li=a.closest('li'); if(!li||!li.classList.contains('disabled')) return a; }
    a = $('a.page-link[aria-controls="data_table"][data-dt-idx="1"]');
    if(a){ return a; }
    // Fallback by text "1"
    const candidates = $$('#data_table_paginate a.page-link');
    for(const link of candidates){
      if((link.textContent||'').trim()==='1') return link;
    }
    return null;
  };

  // Collect ALL dates for the month by walking pages once (no modals).
  let allDates=[];
  let mk=null;
  try{
    const firstPageDates=getPageDates();
    mk = firstPageDates.length ? monthKey(firstPageDates[0]) : null;
    allDates.push(...firstPageDates);

    while(true){
      requireToken(token);
      const next=findNextLink();
      if(!next) break;

      const firstRow=$('#data_table tbody tr');
      const prevFirstDateText = firstRow ? (firstRow.textContent||'').trim().slice(0,20) : '';
      next.click();
      await cancellableSleep(DELAYS.pageTurn, token);
      await waitForTableRedraw(prevFirstDateText, token);

      const pageDates=getPageDates();
      if(!pageDates.length) break;
      if(mk && monthKey(pageDates[0])!==mk){
        // month changed -> stop
        break;
      }
      allDates.push(...pageDates);
    }

    allDates = Array.from(new Set(allDates));

    // Return to first page so we can process month from start
    const firstLink=findFirstPageLink();
    if(firstLink){
      const firstRow=$('#data_table tbody tr');
      const prevFirstDateText = firstRow ? (firstRow.textContent||'').trim().slice(0,20) : '';
      firstLink.click();
      await cancellableSleep(DELAYS.pageTurn, token);
      await waitForTableRedraw(prevFirstDateText, token);
    }
  }catch(e){
    // If collecting fails, fallback to current page only
    allDates = getPageDates();
  }

  // Build monthly overtime plan (paid overtime minutes per day) using the provided range.
  try{
    state.otPlan = buildOvertimePlanForPage(allDates, prof.otMin, prof.otMax);
  }catch(e){
    state.otPlan = new Map();
  }

  // Process all pages (the same way duplikate-all-pages does), applying otPlan per date.
  while(true){
    requireToken(token);
    const table=findTimeTable();
    if(!table){log('Tabelle nicht gefunden.');break;}
    const tbody=table.tBodies && table.tBodies[0] ? table.tBodies[0] : table.querySelector('tbody');
    if(!tbody){log('Kein tbody.');break;}
    const rows=Array.from(tbody.querySelectorAll('tr')).filter(r=>r.querySelector('td'));

    // process each unprocessed row on this page
    let didOne=false;
    for(const tr of rows){
      requireToken(token);
      const dateStr=getRowDate(tr);
      if(!dateStr) continue;
      if(mk && monthKey(dateStr)!==mk) continue; // safety: only current month
      if(state.processedDates.has(dateStr)) continue;

      const btn=findEditButton(tr);
      if(!btn){ state.processedDates.add(dateStr); continue; }

      didOne=true;
      state.lastPickedDate=dateStr;

      btn.click();
      const modal=await waitForModal(token);
      if(!modal){ log(`Modal nicht geöffnet: ${dateStr}`); state.processedDates.add(dateStr); continue; }
      await cancellableSleep(DELAYS.openWait,token);

      await completeDayIfNeeded(modal,dateStr,driver,token);

      await waitForModalClosed(token);
      await cancellableSleep(DELAYS.afterClose, token);

      state.processedDates.add(dateStr);
    }

    // page done
    if(!didOne) log('✅ Seite fertig.');

    const next=findNextLink();
    if(!next) break;

    const firstRow=$('#data_table tbody tr');
    const prevFirstDateText = firstRow ? (firstRow.textContent||'').trim().slice(0,20) : '';
    next.click();
    await cancellableSleep(DELAYS.pageTurn, token);
    await waitForTableRedraw(prevFirstDateText, token);
  }

  log('🏁 Monat fertig (alle Seiten).');
}

/* ---------------- Duplicate pause cleaner (SO/RP) ---------------- */
const CLEAN_CFG={
  pauseRowSel:'#pause_dataList_body > tr',
  deleteBtnSel:'a[title="Löschen"]',
  swalConfirmSel:'.swal2-confirm'
};
function readPauseRows(modal){
  const rows=$$(CLEAN_CFG.pauseRowSel, modal);
  return rows.map(tr=>{
    const tds=$$('td', tr);
    const start=(tds[0]?.textContent||'').trim();
    const end=(tds[1]?.textContent||'').trim();
    const type=(tds[2]?.textContent||'').trim();
    const del=$(CLEAN_CFG.deleteBtnSel, tds[3]||tr);
    let kind='OTHER';
    if(/^Sonstige\s*Arbeitszeit\s*\(SO\)$/i.test(type)) kind='SO';
    else if(/^Ruhepause\s*\(RP\)$/i.test(type)) kind='RP';
    return {tr,start,end,rawType:type,kind,del};
  });
}
function listDuplicates(rows){
  const map=new Map();
  for(const r of rows){
    if(r.kind!=='SO' && r.kind!=='RP') continue;
    const key=`${r.kind}|${r.start}|${r.end}`;
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  const dups=[];
  for(const [key, arr] of map){ if(arr.length>1) dups.push({key, keep:arr[0], extras:arr.slice(1)}); }
  return dups;
}
async function deletePauseRow(rowObj, token){
  const btn=rowObj?.del; if(!btn) return false;
  try{btn.scrollIntoView({block:'center'});}catch{}
  await cancellableSleep(80, token);
  btn.click();
  await cancellableSleep(700, token);
  const t0=Date.now();
  while(Date.now()-t0<6000){
    const confirm=$(CLEAN_CFG.swalConfirmSel);
    if(confirm){ confirm.click(); await cancellableSleep(800, token); break; }
    await cancellableSleep(150, token);
  }
  await cancellableSleep(650, token);
  return true;
}
async function removeAllDuplicates(modal, token){
  let safety=40;
  while(safety-- > 0){
    const rows=readPauseRows(modal);
    const dups=listDuplicates(rows);
    if(dups.length===0) return true;
    const target=dups[0].extras[0];
    log(`🧹 Entferne Duplikat: ${target.kind} ${target.start}–${target.end}`);
    const ok=await deletePauseRow(target, token);
    if(!ok) return false;
  }
  return false;
}
async function cleanOneOpenModal(token){
  const modal=await waitForModal(token);
  if(!modal || !modal.classList.contains('show')){ log('Bitte zuerst einen Tag öffnen (Bearbeiten).'); throw ABORT; }
  await cancellableSleep(1200, token);
  await removeAllDuplicates(modal, token);
  log('✅ Duplikate im offenen Tag entfernt (wenn vorhanden).');
}
async function cleanPageForCurrentDriver(token){
  // iterate rows on current page; open each date once; clean; save (Korrektur Beenden)
  const table=findTimeTable(); if(!table){log('Tabelle nicht gefunden.'); throw ABORT;}
  const tbody=table.tBodies[0]||table.querySelector('tbody'); if(!tbody) throw ABORT;
  const rows=Array.from(tbody.querySelectorAll('tr')).filter(r=>r.querySelector('td'));
  const processed=new Set();
  for(const tr of rows){
    requireToken(token);
    const dateStr=getRowDate(tr); if(!dateStr || processed.has(dateStr)) continue;
    const btn=findEditButton(tr); if(!btn){processed.add(dateStr);continue;}
    btn.click();
    const modal=await waitForModal(token); if(!modal){processed.add(dateStr);continue;}
    await cancellableSleep(2000, token);
    await removeAllDuplicates(modal, token);
    await clickKorrekturBeenden(modal, token);
    const yes=await waitForSwalConfirm(token); if(yes) yes.click();
    await waitForModalClosed(token);
    await cancellableSleep(DELAYS.afterClose, token);
    processed.add(dateStr);
  }
  log('✅ Duplikate (diese Seite) fertig.');
}
function findNextLink(){
  let link = $('#data_table_paginate li.next:not(.disabled) a.page-link');
  if(link) return link;
  link = $('a.page-link[aria-controls="data_table"][data-dt-idx="next"]');
  if(link){ const li=link.closest('li'); if(!li || !li.classList.contains('disabled')) return link; }
  const candidates = $$('.page-link');
  for(const a of candidates){
    const txt=(a.textContent||'').trim().toLowerCase();
    if(txt==='nächste'||txt==='naechste'||txt==='next'){ const li=a.closest('li'); if(!li||!li.classList.contains('disabled')) return a; }
  }
  return null;
}
async function waitForTableRedraw(prevFirstDateText, token){
  const t0=Date.now();
  while(Date.now()-t0 < DELAYS.tableRedrawTimeout){
    requireToken(token);
    const firstRow=$('#data_table tbody tr');
    if(firstRow){
      const firstDate=(firstRow.querySelector('td.sorting_1')?.textContent||'').trim();
      if(firstDate && firstDate !== prevFirstDateText) return true;
    }
    await cancellableSleep(DELAYS.tableRedrawPoll, token);
  }
  return false;
}
async function cleanAllPagesForCurrentDriver(token){
  let page=1;
  while(true){
    requireToken(token);
    log(`🧹 Duplikate: Seite ${page}…`);
    const firstRowBefore=$('#data_table tbody tr');
    const firstDateBefore=(firstRowBefore?.querySelector('td.sorting_1')?.textContent||'').trim();
    await cleanPageForCurrentDriver(token);
    const next=findNextLink();
    if(!next){ log('🏁 Duplikate: Keine weiteren Seiten.'); break; }
    next.click();
    await cancellableSleep(DELAYS.pageTurn, token);
    await waitForTableRedraw(firstDateBefore, token);
    page++;
  }
  log('✅ Duplikate: ganzer Fahrer fertig.');
}

/* ---------------- Single day / Multi drivers ---------------- */
async function runOneDay(token){
  const modal=await waitForModal(token);
  if(!modal || !modal.classList.contains('show')){ log('Bitte zuerst einen Tag öffnen (Bearbeiten).'); throw ABORT; }
  await cancellableSleep(DELAYS.openWait,token);
  let dateStr=(q(modal,'#end_date')?.value||q(modal,'#start_date')?.value||'').trim();
  if(!/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)){const m=(modal.textContent||'').match(/\b\d{2}\.\d{2}\.\d{4}\b/);dateStr=m?m[0]:'';}
  if(!dateStr){log('Datum im Modal nicht gefunden'); throw ABORT;}
  const driver = state.currentDriverName || getSelectedDriverName() || '(Nur 1 Tag)';
  await completeDayIfNeeded(modal,dateStr,driver,token);
}

function parseDriverList(){
  const raw=($('#mt_driver_list')?.value||'').trim();
  if(!raw) return [];
  return raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
}

async function runMultiDrivers(token){
  const list=parseDriverList();
  if(!list.length){alert('Bitte Fahrer-Liste einfügen (eine Zeile pro Fahrer).'); throw ABORT;}
  log(`Multi Start: ${list.length} Fahrer — MODE ${state.mode}`);

  for(const name of list){
    requireToken(token);
    if(!selectDriverByName(name)){ log(`❌ Fahrer nicht gefunden im Dropdown: ${name}`); continue; }
    await waitForDriverApplied(name, token);
    state.currentDriverName=name;
    state.cleanedThisDriver=false;

    loadProfileToDashboard(name);
    await waitForReady(name, token);

    if(!saveCurrentSetupToProfile()){ log(`❌ Setup nicht vollständig (FZG/KM/Signatur) für: ${name}`); throw ABORT; }

    await runAuto(token);

    // After hours finished: run cleaner over whole driver (optional button also exists)
    log(`🧹 Starte Duplikate-Cleaner (ganzer Fahrer): ${name}`);
    await cleanAllPagesForCurrentDriver(token);

    state.currentDriverName=null;
    setReady(false);
    log(`✅ Fahrer fertig: ${name}`);
  }
  log('✅ Multi fertig');
}

/* ---------------- Buttons wiring ---------------- */
function wireButtons(){
  $('#mt_stop').addEventListener('click',()=>{ state.runToken++; setRunning(false); setReady(false); log('Stop gedrückt: Abbruch läuft …'); });

  $('#mt_ready_btn').addEventListener('click',()=>{
    const drv = state.currentDriverName || getSelectedDriverName();
    if(!drv || /Alle Auswählen/i.test(drv)){ alert('Bitte zuerst einen Fahrer auswählen (nicht "Alle Auswählen").'); return; }
    const fzg=($('#mt_fzg')?.value||'').trim();
    const km=parseKmInt($('#mt_km')?.value||'');
    if(!fzg || !km){ alert('Bitte Fahrzeug + Start-KM eingeben.'); return; }
    if(!sigPadHasInk()){ alert('Bitte Signatur zeichnen.'); return; }
    state.currentDriverName = drv;
    if(!saveCurrentSetupToProfile()){ alert('Setup konnte nicht gespeichert werden (prüfe Fahrzeug/KM/Signatur).'); return; }
    setReady(true);
    log(`✅ ALLES BEREIT gesetzt: ${drv} (MODE ${state.mode})`);
  });

  $('#mt_start_auto').addEventListener('click', async ()=>{
    if(state.running) return;
    const token=++state.runToken; setRunning(true);
    try{
      const drv=getSelectedDriverName();
      if(!drv || /Alle Auswählen/i.test(drv)){ alert('Bitte einen Fahrer auswählen (nicht "Alle Auswählen").'); throw ABORT; }
      state.currentDriverName=drv;
      loadProfileToDashboard(drv);
      await waitForReady(drv, token);
      if(!saveCurrentSetupToProfile()){ log(`❌ Setup nicht vollständig (FZG/KM/Signatur) für: ${drv}`); throw ABORT; }
      await runAuto(token);
    }catch(e){ if(e===ABORT) log('Gestoppt'); else logErr(e,'Auto(1)'); }
    finally{ state.currentDriverName=null; setRunning(false); setReady(false); }
  });

  $('#mt_one_day').addEventListener('click', async ()=>{
    if(state.running) return;
    const token=++state.runToken; setRunning(true);
    try{
      const drv = state.currentDriverName || getSelectedDriverName();
      if(!drv || /Alle Auswählen/i.test(drv)){ alert('Bitte einen Fahrer auswählen (nicht "Alle Auswählen").'); throw ABORT; }
      state.currentDriverName=drv;
      loadProfileToDashboard(drv);
      await waitForReady(drv, token);
      if(!saveCurrentSetupToProfile()){ log(`❌ Setup nicht vollständig (FZG/KM/Signatur) für: ${drv}`); throw ABORT; }
      await runOneDay(token);
    }catch(e){ if(e===ABORT) log('Gestoppt'); else logErr(e,'OneDay'); }
    finally{ setRunning(false); setReady(false); }
  });

  $('#mt_multi_start').addEventListener('click', async ()=>{
    if(state.running) return;
    const token=++state.runToken; setRunning(true);
    try{ await runMultiDrivers(token); }
    catch(e){ if(e===ABORT) log('Gestoppt'); else logErr(e,'Multi'); }
    finally{ state.currentDriverName=null; setRunning(false); setReady(false); }
  });

  // Maintenance actions (Option D): Duplikate + Überstunden (separat) use same runner
  function bindMaintenance(btnSel, fn, errTag){
    const b = $(btnSel);
    if(!b) return;
    // remove legacy inline onclicks (older cores)
    try{ b.removeAttribute('onclick'); }catch{}
    b.addEventListener('click', async (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      if(state.running) return;
      const token = ++state.runToken;
      setRunning(true);
      try{ await fn(token); }
      catch(e){ if(e===ABORT) log('Gestoppt'); else logErr(e, errTag); }
      finally{ setRunning(false); }
    });
  }

  bindMaintenance('#mt_clean_one_open', cleanOneOpenModal, 'CleanOne');
  bindMaintenance('#mt_clean_page', cleanPageForCurrentDriver, 'CleanPage');
  bindMaintenance('#mt_clean_driver', cleanAllPagesForCurrentDriver, 'CleanDriver');
}

/* ---------------- Init ---------------- */
state.mode = GM_GetValueSafe(KEYS.mode, 'UPS');
if(!MODES[state.mode]) state.mode='UPS';


/* ---------------- Robust click capture for Manual OT buttons ----------------
   In loader/eval environments or when old UI versions injected inline onclick handlers,
   clicks may execute in a different scope and throw ReferenceError.
   This capture-phase delegator guarantees the click is handled by THIS core.
-------------------------------------------------------------------------- */
(function(){
  try{
    
// (Option D) No capture-click bridge needed; buttons are bound via maintenance runner.

  }catch(_){}
})();

injectUI();
applyTheme();
log('MASTER AutoSuite v3.2.0 geladen ✅');

})();
