// AutoSuite CORE v3.3.1 (Fix: table/date/edit detection + Overtime NET + RP 9h rule)
(function () {
  "use strict";

  /* ---------------- Base config ---------------- */
  const DELAYS = {
    modal: 7000,
    openWait: 1200,
    step: 800,
    ajax: 1200,
    retry: 250,
    modalClose: 5000,
    afterClose: 900,
  };

  const KEYS = {
    uiMin: "master_ui_minimized",
    mode: "master_mode",
    profiles: "master_profiles_v1",
  };

  const MODES = {
    UPS: { label: "UPS", accent: "#ffcb05", bg: "#221b17", border: "#5a4639", primary: "#745e4d", iconText: "UPS" },
    DPD: { label: "DPD", accent: "#e4002b", bg: "#1a0b0d", border: "#5a1f2b", primary: "#7a1f30", iconText: "DPD" },
    GLS: { label: "GLS", accent: "#0072ce", bg: "#07131d", border: "#1d3a55", primary: "#1a4e78", iconText: "GLS" },
  };

  const state = {
    logs: [],
    running: false,
    runToken: 0,
    processedDates: new Set(),
    lastPickedDate: null,
    ready: false,
    currentDriverName: null,
    mode: "UPS",
    monthPlans: null,
    monthTargetNet: null,
    monthBaseNet: null,
    monthOvertimeTarget: null,
  };

  /* ---------------- Utils ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ABORT = Symbol("ABORT");

  function log(msg) {
    state.logs.push({ t: Date.now(), msg });
    renderLog();
  }
  function logErr(e, ctx) {
    console.error(ctx, e);
    log(`❌ ${ctx}: ${e?.message || e}`);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async function cancellableSleep(ms, token) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      requireToken(token);
      await sleep(60);
    }
  }
  function requireToken(token) {
    if (!state.running || token !== state.runToken) throw ABORT;
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  function randInt(a, b) {
    return Math.floor(Math.random() * (b - a + 1)) + a;
  }
  function normName(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function timeStrToMins(t) {
    const m = String(t || "").match(/(\d{1,2}):(\d{2})/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function toTimeStr(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(mins / 60),
      m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  function deDateStrToDate(dateStr) {
    const m = String(dateStr || "").match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!m) return new Date(NaN);
    return new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), 12, 0, 0);
  }

  /* ---------------- GM safe access ---------------- */
  function GM_GetValueSafe(k, d) {
    try {
      return GM_getValue(k, d);
    } catch {
      return d;
    }
  }
  function GM_SetValueSafe(k, v) {
    try {
      GM_setValue(k, v);
    } catch {}
  }

  /* ---------------- Persistent profiles ---------------- */
  function loadProfiles() {
    try {
      const raw = GM_GetValueSafe(KEYS.profiles, "{}");
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  function saveProfiles(obj) {
    try {
      GM_SetValueSafe(KEYS.profiles, JSON.stringify(obj || {}));
    } catch {}
  }

  /* ---------------- UI helpers ---------------- */
  function setRunning(on) {
    state.running = !!on;
    const b = $("#mt_stop");
    if (b) b.disabled = !on ? true : false;
    const s = $("#mt_start_auto");
    if (s) s.disabled = on;
    const m = $("#mt_multi_start");
    if (m) m.disabled = on;
  }
  function setReady(on) {
    state.ready = !!on;
    const st = $("#mt_sig_status");
    if (st) st.textContent = state.ready ? "Bereit: OK" : "Bereit: nein";
  }
  function renderLog() {
    const box = $("#mt_log");
    if (!box) return;
    const last = state.logs.slice(-14).map((x) => x.msg).join("\n");
    box.textContent = last;
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- Signature pad (dashboard) ---------------- */
  const dashSig = { strokes: [], cur: [], hasInk: false };

  function sigPadHasInk() {
    return !!dashSig.hasInk;
  }
  function normCanvasPoint(e, canvas) {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }
  function initSigPad() {
    const canvas = $("#mt_sig_canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111";
    let down = false;

    canvas.addEventListener("pointerdown", (e) => {
      down = true;
      dashSig.cur = [normCanvasPoint(e, canvas)];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!down) return;
      dashSig.cur.push(normCanvasPoint(e, canvas));
      const st = dashSig.cur;
      if (st.length >= 2) {
        ctx.beginPath();
        const a = st[st.length - 2],
          b = st[st.length - 1];
        ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
        ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
        ctx.stroke();
      }
    });
    canvas.addEventListener("pointerup", () => {
      if (!down) return;
      down = false;
      if (dashSig.cur.length >= 2) {
        dashSig.strokes.push(dashSig.cur.slice());
        dashSig.hasInk = true;
        $("#mt_sig_status").textContent = "Signatur: OK";
      }
      dashSig.cur = [];
    });

    $("#mt_sig_clear")?.addEventListener("click", () => {
      dashSig.strokes = [];
      dashSig.cur = [];
      dashSig.hasInk = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      $("#mt_sig_status").textContent = "Signatur: leer";
    });
  }

  /* ---------------- Driver dropdown helpers ---------------- */
  function getDriverSelect() {
    return $("#driverSelect") || $('select[name="driver"]') || $("select#driver") || $("select.form-control") || $("select");
  }
  function getSelectedDriverName() {
    const sel = getDriverSelect();
    if (!sel) return "";
    const opt = sel.options[sel.selectedIndex];
    return (opt?.textContent || opt?.innerText || "").trim();
  }
  function selectDriverByName(name) {
    const sel = getDriverSelect();
    if (!sel) return false;
    const target = normName(name);
    for (let i = 0; i < sel.options.length; i++) {
      const txt = (sel.options[i].textContent || "").trim();
      if (normName(txt) === target) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }
  async function waitForDriverApplied(name, token) {
    const target = normName(name);
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      requireToken(token);
      const cur = normName(getSelectedDriverName());
      if (cur === target) return true;
      await cancellableSleep(250, token);
    }
    return false;
  }

  /* ---------------- Profiles: per-driver, per-mode ---------------- */
  function profileKey(driverName) {
    return `${state.mode}::${normName(driverName)}`;
  }
  function parseKmInt(kmDot00) {
    const s = String(kmDot00 || "").trim();
    const m = s.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  function formatDashKmDot00(v) {
    const n = parseKmInt(v);
    if (!n) return "";
    return `${n}.00`;
  }
  function setDashKmDot00FromInt(n) {
    const input = $("#mt_km");
    if (input) input.value = `${n}.00`;
    persistProfileLastKm(`${n}.00`);
  }
  function getDashStartKmInt() {
    return parseKmInt(formatDashKmDot00($("#mt_km")?.value || ""));
  }
  function persistProfileLastKm(kmDot00) {
    const driver = state.currentDriverName || getSelectedDriverName();
    const name = (driver || "").trim();
    if (!name) return;
    const profiles = loadProfiles();
    const key = profileKey(name);
    if (!profiles[key]) profiles[key] = { name, mode: state.mode, fahrzeug: "", lastKm: "", otMin: 7, otMax: 9, sig: null };
    profiles[key].lastKm = kmDot00;
    saveProfiles(profiles);
  }
  function getOtRangeFromDash() {
    const minH = parseFloat(($("#mt_ot_min")?.value || "").replace(",", "."));
    const maxH = parseFloat(($("#mt_ot_max")?.value || "").replace(",", "."));
    const min = isFinite(minH) ? Math.max(0, minH) : 7;
    const max = isFinite(maxH) ? Math.max(min, maxH) : 9;
    return { min, max };
  }
  function saveCurrentSetupToProfile() {
    const driver = state.currentDriverName || getSelectedDriverName();
    const name = (driver || "").trim();
    if (!name) return false;
    const fzg = ($("#mt_fzg")?.value || "").trim();
    const km = formatDashKmDot00($("#mt_km")?.value || "");
    if (!fzg || !parseKmInt(km)) return false;
    if (!sigPadHasInk()) return false;

    const profiles = loadProfiles();
    const key = profileKey(name);
    const ot = getOtRangeFromDash();
    profiles[key] = { name, mode: state.mode, fahrzeug: fzg, lastKm: km, otMin: ot.min, otMax: ot.max, sig: { strokes: dashSig.strokes } };
    saveProfiles(profiles);
    return true;
  }
  function loadProfileToDashboard(name) {
    const profiles = loadProfiles();
    const prof = profiles[profileKey(name)];
    if (!prof) return false;
    $("#mt_fzg").value = prof.fahrzeug || "";
    $("#mt_km").value = formatDashKmDot00(prof.lastKm || "");

    if ($("#mt_ot_min")) $("#mt_ot_min").value = String(prof.otMin ?? 7);
    if ($("#mt_ot_max")) $("#mt_ot_max").value = String(prof.otMax ?? 9);

    if (prof.sig?.strokes?.length) {
      dashSig.strokes = JSON.parse(JSON.stringify(prof.sig.strokes));
      dashSig.cur = [];
      dashSig.hasInk = true;
      const c = $("#mt_sig_canvas");
      if (c) {
        const ctx = c.getContext("2d");
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.strokeStyle = "#111";
        for (const stroke of dashSig.strokes) {
          if (!stroke || stroke.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(stroke[0].x * c.width, stroke[0].y * c.height);
          for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x * c.width, stroke[i].y * c.height);
          ctx.stroke();
        }
        $("#mt_sig_status").textContent = "Signatur: OK";
      }
    }
    return true;
  }
  function isDashboardReady() {
    const fzg = ($("#mt_fzg")?.value || "").trim();
    const km = parseKmInt(formatDashKmDot00($("#mt_km")?.value || ""));
    return !!(fzg && km && sigPadHasInk());
  }
  async function waitForReady(driverName, token) {
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      requireToken(token);
      if (isDashboardReady()) {
        setReady(true);
        return true;
      }
      if (driverName) loadProfileToDashboard(driverName);
      await cancellableSleep(200, token);
    }
    setReady(isDashboardReady());
    return state.ready;
  }

  /* ---------------- Injected UI ---------------- */
  function injectUI() {
    if ($("#mt_card")) return;

    const css = `
      :root{ --mt-accent:${MODES[state.mode].accent}; --mt-bg:${MODES[state.mode].bg}; --mt-border:${MODES[state.mode].border}; --mt-primary:${MODES[state.mode].primary}; }
      .mt-card{ position:fixed; top:14px; right:14px; width:370px; max-height:92vh; overflow:auto; z-index:999999; background:var(--mt-bg); color:#fff; border:1px solid var(--mt-border); border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.35); font-family:Segoe UI,Arial; }
      .mt-inner{ padding:12px; }
      .mt-title{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .mt-badge{ padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12); font-size:12px; }
      .mt-btn{ flex:1; padding:10px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.06); color:#fff; cursor:pointer; font-weight:700; }
      .mt-btn:hover{ background:rgba(255,255,255,.10); }
      .mt-btn.primary{ background:var(--mt-primary); }
      .mt-btn.danger{ background:#b00020; }
      .mt-row{ display:flex; gap:10px; align-items:center; }
      .mt-field{ display:flex; flex-direction:column; gap:4px; margin:6px 0; }
      .mt-field label{ font-size:12px; opacity:.88; }
      .mt-field input,.mt-field textarea,.mt-field select{ width:100%; padding:9px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.05); color:#fff; outline:none; }
      .mt-sigbox{ border:1px dashed rgba(255,255,255,.18); border-radius:12px; padding:10px; margin:8px 0; background:rgba(255,255,255,.04); }
      .mt-sigrow{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
      .mt-sigstatus{ font-size:12px; opacity:.9; }
      .mt-canvas{ width:100%; height:110px; background:#fff; border-radius:10px; touch-action:none; }
      .mt-log{ white-space:pre-wrap; font-family:Consolas, monospace; font-size:12px; background:rgba(0,0,0,.2); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:10px; margin-top:10px; min-height:90px; }
      .mt-hidden{ display:none !important; }
      .mt-toggle{ position:fixed; top:14px; right:14px; z-index:999999; border:none; background:transparent; cursor:pointer; padding:0; }
      .mt-toggle svg{ width:54px; height:54px; filter: drop-shadow(0 8px 18px rgba(0,0,0,.35)); }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "mt-card";
    wrap.id = "mt_card";
    wrap.innerHTML = `
      <div class="mt-inner">
        <div class="mt-title">
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="font-weight:900;font-size:16px;">AutoSuite</div>
            <div class="mt-badge" id="mt_mode_badge">${MODES[state.mode].label}</div>
          </div>
          <button class="mt-btn" id="mt_minimize" style="flex:0 0 auto;width:44px;">_</button>
        </div>

        <div class="mt-field" style="margin-top:8px;">
          <label>MODE</label>
          <select id="mt_mode">
            <option value="UPS">UPS</option>
            <option value="DPD">DPD</option>
            <option value="GLS">GLS</option>
          </select>
        </div>

        <div style="font-weight:900;margin:10px 0 6px;">Setup</div>
        <div class="mt-field"><label>Fahrzeug</label><input id="mt_fzg" type="text"></div>
        <div class="mt-field"><label>Start-KM</label><input id="mt_km" type="text" placeholder="z.B. 215000.00"></div>

        <div class="mt-row" style="gap:8px;margin-top:6px;">
          <div class="mt-field" style="flex:1;">
            <label>Überstunden Ziel (Monat) MIN (h netto)</label>
            <input id="mt_ot_min" type="number" min="0" step="0.5" value="7">
          </div>
          <div class="mt-field" style="flex:1;">
            <label>Überstunden Ziel (Monat) MAX (h netto)</label>
            <input id="mt_ot_max" type="number" min="0" step="0.5" value="9">
          </div>
        </div>

        <div class="mt-sigbox">
          <div class="mt-sigrow">
            <div class="mt-sigstatus" id="mt_sig_status">Signatur: leer</div>
            <button class="mt-btn danger" id="mt_sig_clear" style="flex:0 0 auto;width:90px;">Clear</button>
          </div>
          <canvas id="mt_sig_canvas" class="mt-canvas" width="800" height="240"></canvas>
          <div style="margin-top:6px;opacity:.9;">➡️ Zeichne Signatur für den Fahrer.</div>
        </div>

        <div class="mt-row">
          <button class="mt-btn primary" id="mt_ready_btn">ALLES BEREIT</button>
          <button class="mt-btn danger" id="mt_stop">Stop</button>
        </div>

        <hr style="border:0;border-top:1px solid rgba(255,255,255,.12);margin:10px 0">

        <div style="font-weight:900;margin-bottom:6px;">Single Driver</div>
        <div class="mt-row">
          <button class="mt-btn primary" id="mt_start_auto">Auto Start (1 Fahrer)</button>
        </div>

        <div style="font-weight:900;margin:10px 0 6px;">Multi Driver</div>
        <div class="mt-field">
          <label>Fahrer-Liste (eine Zeile pro Fahrer)</label>
          <textarea id="mt_driver_list" rows="6" placeholder="Name 1&#10;Name 2&#10;..."></textarea>
        </div>
        <div class="mt-row">
          <button class="mt-btn primary" id="mt_multi_start">Start Multi</button>
        </div>

        <div class="mt-log" id="mt_log"></div>
        <div style="font-size:11px;opacity:.75;text-align:center;margin-top:8px;">Entwickelt von ICHKOV</div>
      </div>
    `;
    document.body.appendChild(wrap);

    // Toggle icon
    const toggle = document.createElement("button");
    toggle.className = "mt-toggle";
    toggle.id = "mt_toggle_btn";
    toggle.innerHTML = `
      <svg viewBox="0 0 64 64" aria-label="AutoSuite">
        <rect x="2" y="2" width="60" height="60" rx="12" fill="var(--mt-bg)"></rect>
        <path fill="var(--mt-accent)" d="M32 10c6 4 12 6 20 6v16c0 14-11 22-20 24-9-2-20-10-20-24V16c8 0 14-2 20-6z"/>
        <text id="mt_icon_text" x="32" y="38" text-anchor="middle" font-size="16" font-family="Segoe UI, Arial" fill="var(--mt-bg)" font-weight="900">${state.mode}</text>
      </svg>
    `;
    document.body.appendChild(toggle);

    function applyMinimizedUI(min) {
      const card = $("#mt_card"),
        tbtn = $("#mt_toggle_btn");
      if (min) {
        card.classList.add("mt-hidden");
        tbtn.classList.remove("mt-hidden");
      } else {
        card.classList.remove("mt-hidden");
        tbtn.classList.add("mt-hidden");
      }
      GM_SetValueSafe(KEYS.uiMin, !!min);
    }

    $("#mt_minimize").addEventListener("click", () => applyMinimizedUI(true));
    $("#mt_toggle_btn").addEventListener("click", () => applyMinimizedUI(false));

    const modeSel = $("#mt_mode");
    modeSel.value = state.mode;
    modeSel.addEventListener("change", () => {
      const v = modeSel.value;
      if (!MODES[v]) return;
      state.mode = v;
      GM_SetValueSafe(KEYS.mode, v);
      document.documentElement.style.setProperty("--mt-accent", MODES[v].accent);
      document.documentElement.style.setProperty("--mt-bg", MODES[v].bg);
      document.documentElement.style.setProperty("--mt-border", MODES[v].border);
      document.documentElement.style.setProperty("--mt-primary", MODES[v].primary);
      $("#mt_mode_badge").textContent = MODES[v].label;
      $("#mt_icon_text").textContent = MODES[v].iconText;
      const drv = state.currentDriverName || getSelectedDriverName();
      if (drv) loadProfileToDashboard(drv);
      log(`MODE geändert: ${v}`);
    });

    initSigPad();
    wireButtons();

    const isMin = !!GM_GetValueSafe(KEYS.uiMin, false);
    applyMinimizedUI(isMin);
  }

  /* ---------------- DOM detection (FIXED) ---------------- */

  const DATE_RE = /\b\d{2}\.\d{2}\.\d{4}\b/;

  function getRowDate(tr) {
    const txt = (tr?.innerText || "").replace(/\s+/g, " ");
    const m = txt.match(DATE_RE);
    return m ? m[0] : "";
  }

  function scoreTableByDates(tbl) {
    const trs = Array.from(tbl.querySelectorAll("tbody tr, tr")).slice(0, 120);
    let hits = 0;
    for (const tr of trs) if (DATE_RE.test(tr.innerText || "")) hits++;
    return hits;
  }

  function findTimeTable() {
    // Pick the table with most date-like rows
    const tables = Array.from(document.querySelectorAll("table"));
    if (!tables.length) return null;

    let best = null,
      bestScore = 0;
    for (const t of tables) {
      const s = scoreTableByDates(t);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }

    if (!best || bestScore === 0) return null;
    return best;
  }

  function findEditButton(tr) {
    // Try strong signals first
    const candidates = Array.from(tr.querySelectorAll("a,button"));

    function hasPencil(el) {
      return !!el.querySelector?.("i.fa-pencil, i.fa-pencil-alt, i.fas.fa-pencil-alt, i.fa-edit, svg, span.icon");
    }

    for (const el of candidates) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      const title = (el.getAttribute("title") || "").toLowerCase();
      const href = (el.getAttribute("href") || "").toLowerCase();
      const dt = (el.getAttribute("data-target") || "").toLowerCase();
      const toggle = (el.getAttribute("data-toggle") || "").toLowerCase();
      const onclick = (el.getAttribute("onclick") || "").toLowerCase();

      const looksLikeOpen =
        toggle.includes("modal") ||
        dt.includes("modal") ||
        href.includes("edit") ||
        href.includes("bearbeit") ||
        href.includes("detail") ||
        onclick.includes("edit") ||
        onclick.includes("detail") ||
        title.includes("bearbeit") ||
        title.includes("edit") ||
        t.includes("bearbeit") ||
        t.includes("details") ||
        hasPencil(el);

      if (looksLikeOpen) return el;
    }

    // Fallback: any button inside row
    return candidates[0] || null;
  }

  async function waitForModal(token) {
    const t0 = Date.now();
    while (Date.now() - t0 < DELAYS.modal) {
      requireToken(token);
      const m =
        $(".modal.show") ||
        $(".modal.in") ||
        document.querySelector(".modal[style*='display: block']") ||
        document.querySelector(".modal-dialog")?.closest(".modal");
      if (m) return m;
      await cancellableSleep(120, token);
    }
    return null;
  }

  async function waitForModalClosed(token) {
    const t0 = Date.now();
    while (Date.now() - t0 < DELAYS.modalClose) {
      requireToken(token);
      const m = $(".modal.show") || $(".modal.in") || document.querySelector(".modal[style*='display: block']");
      if (!m) return true;
      await cancellableSleep(120, token);
    }
    return false;
  }

  function q(modal, sel) {
    return modal.querySelector(sel);
  }
  function setVal(el, val) {
    if (!el) return;
    el.focus();
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ---------------- Overtime + RP 9h rule ---------------- */
  function calcNetMinsFromPlan(plan) {
    const ruDur = plan?.ru?.end != null && plan?.ru?.start != null ? plan.ru.end - plan.ru.start : 0;
    return plan.end - plan.start - ruDur;
  }

  // RULE: if (end-start) >= 540 => RP 45–50
  function pickRuDurByRule(durMins, baseMin, baseMax) {
    if (durMins >= 540) return randInt(45, 50);
    return randInt(baseMin, baseMax);
  }

  /* ---------------- Plan generators ---------------- */
  function genPlanUPS(dateStr) {
    const d = deDateStrToDate(dateStr);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) return null;

    const START_MIN = timeStrToMins("06:40"),
      START_MAX = timeStrToMins("07:10");

    let END_MIN = timeStrToMins("15:10"),
      END_MAX = timeStrToMins("15:45"),
      DUR_MIN = 510,
      DUR_MAX = 540;

    if (wd === 2 || wd === 3) {
      DUR_MIN = 540;
      DUR_MAX = 555;
      END_MAX = timeStrToMins("16:15");
    }

    const start = randInt(START_MIN, START_MAX);

    let wantMin = Math.max(END_MIN, start + DUR_MIN);
    let wantMax = Math.min(END_MAX, start + DUR_MAX);
    if (wantMin > wantMax) {
      wantMin = Math.max(END_MIN, start + DUR_MIN);
      wantMax = Math.max(wantMin, Math.min(END_MAX, start + DUR_MAX));
    }
    let end = randInt(wantMin, wantMax);
    end = Math.min(Math.max(end, Math.max(END_MIN, start + DUR_MIN)), Math.min(END_MAX, start + DUR_MAX));

    const so1 = { start, end: start + randInt(15, 20) };
    const so2 = { start: so1.end + randInt(5, 10) };
    so2.end = so2.start + randInt(115, 130);

    const dur = end - start;
    const ruDur = pickRuDurByRule(dur, 32, 36);
    const rpWinStart = timeStrToMins("10:00"),
      rpWinEnd = timeStrToMins("12:00");
    const rpStart = randInt(rpWinStart, Math.max(rpWinStart, rpWinEnd - ruDur));
    const ru = { start: rpStart, end: rpStart + ruDur };

    const so3 = { start: end - randInt(15, 20), end };
    const lenk = { start: so2.end, end };

    return { start, end, so1, so2, ru, so3, lenk };
  }

  function genPlanDPD(dateStr) {
    const d = deDateStrToDate(dateStr);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) return null;

    let sMin, sMax, eMin, eMax;
    if (wd === 1) {
      sMin = timeStrToMins("05:55");
      sMax = timeStrToMins("06:05");
      eMin = timeStrToMins("14:25");
      eMax = timeStrToMins("14:35");
    } else if (wd === 2) {
      sMin = timeStrToMins("05:25");
      sMax = timeStrToMins("05:40");
      eMin = timeStrToMins("14:55");
      eMax = timeStrToMins("15:10");
    } else if (wd === 3) {
      sMin = timeStrToMins("05:25");
      sMax = timeStrToMins("05:40");
      eMin = timeStrToMins("14:55");
      eMax = timeStrToMins("15:10");
    } else {
      sMin = timeStrToMins("05:25");
      sMax = timeStrToMins("05:40");
      eMin = timeStrToMins("13:55");
      eMax = timeStrToMins("14:10");
    }

    const start = randInt(sMin, sMax);

    const MON_THU_FRI_MIN = 480,
      MON_THU_FRI_MAX = 510;
    const WED_MIN = 480,
      WED_MAX = 510;
    const TUE_MIN = 525,
      TUE_MAX = 540;

    let end;
    if (wd === 1 || wd === 4 || wd === 5) {
      const wantMin = start + MON_THU_FRI_MIN;
      const wantMax = start + MON_THU_FRI_MAX;
      const interMin = Math.max(eMin, wantMin);
      const interMax = Math.min(eMax, wantMax);
      end = interMin <= interMax ? randInt(interMin, interMax) : Math.max(wantMin, Math.min(wantMax, eMax));
    } else if (wd === 2) {
      end = randInt(start + TUE_MIN, start + TUE_MAX);
    } else {
      end = randInt(start + WED_MIN, start + WED_MAX);
    }

    const so1 = { start, end: start + randInt(17, 20) };
    const so2 = { start: so1.end + randInt(7, 13) };
    so2.end = so2.start + randInt(115, 130);

    const dur = end - start;
    const ruDur = pickRuDurByRule(dur, 31, 37);
    const rpWinStart = timeStrToMins("10:50"),
      rpWinEnd = timeStrToMins("11:50");
    const rpStart = randInt(rpWinStart, Math.max(rpWinStart, rpWinEnd - ruDur));
    const ru = { start: rpStart, end: rpStart + ruDur };

    const lenk = { start: so2.end, end };
    const so3 = { start: end - randInt(15, 20), end };

    return { start, end, so1, so2, ru, so3, lenk };
  }

  function genPlanGLS(dateStr) {
    const d = deDateStrToDate(dateStr);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) return null;

    const START_MIN = timeStrToMins("05:00"),
      START_MAX = timeStrToMins("06:30");
    const END_MIN = timeStrToMins("15:10"),
      END_MAX = timeStrToMins("15:45");
    const DUR_MIN = 510,
      DUR_MAX = 540;

    const start = randInt(START_MIN, START_MAX);

    let wantMin = Math.max(END_MIN, start + DUR_MIN);
    let wantMax = Math.min(END_MAX, start + DUR_MAX);
    if (wantMin > wantMax) {
      wantMin = Math.max(END_MIN, start + DUR_MIN);
      wantMax = Math.max(wantMin, Math.min(END_MAX, start + DUR_MAX));
    }
    let end = randInt(wantMin, wantMax);
    end = Math.min(Math.max(end, Math.max(END_MIN, start + DUR_MIN)), Math.min(END_MAX, start + DUR_MAX));

    const so1 = { start, end: start + randInt(15, 20) };
    const so2 = { start: so1.end + randInt(5, 10) };
    so2.end = so2.start + randInt(115, 130);

    const dur = end - start;
    const ruDur = pickRuDurByRule(dur, 32, 36);
    const rpWinStart = timeStrToMins("09:00"),
      rpWinEnd = timeStrToMins("10:30");
    const rpStart = randInt(rpWinStart, Math.max(rpWinStart, rpWinEnd - ruDur));
    const ru = { start: rpStart, end: rpStart + ruDur };

    const so3 = { start: end - randInt(15, 20), end };
    const lenk = { start: so2.end, end };

    return { start, end, so1, so2, ru, so3, lenk };
  }

  function genPlanByMode(dateStr) {
    if (state.mode === "DPD") return genPlanDPD(dateStr);
    if (state.mode === "GLS") return genPlanGLS(dateStr);
    return genPlanUPS(dateStr);
  }

  /* ---------------- Month overtime planner (NET + weekday based) ---------------- */
  function initMonthPlansFromTable(table) {
    const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter((r) => DATE_RE.test(r.innerText || ""));
    const dates = [];
    for (const tr of rows) {
      const dateStr = getRowDate(tr);
      if (!dateStr) continue;
      const d = deDateStrToDate(dateStr);
      const wd = d.getDay();
      if (wd === 0 || wd === 6) continue;
      dates.push(dateStr);
    }
    if (!dates.length) return null;

    const weekdayCount = dates.length;
    const baseNet = weekdayCount * 8 * 60;

    const ot = getOtRangeFromDash();
    const overtimeTarget = randInt(Math.round(ot.min * 60), Math.round(ot.max * 60));
    const targetNet = baseNet + overtimeTarget;

    const plans = {};
    let currentNet = 0;
    for (const dateStr of dates) {
      const p = genPlanByMode(dateStr);
      if (!p) continue;
      plans[dateStr] = p;
      currentNet += calcNetMinsFromPlan(p);
    }

    // Very simple correction loop: adjust by tiny end shifts within each mode's limits
    let delta = targetNet - currentNet;

    // Mode caps helper
    function getEndConstraints(dateStr, startMins) {
      const d = deDateStrToDate(dateStr);
      const wd = d.getDay();

      if (state.mode === "UPS") {
        let END_MIN = timeStrToMins("15:10"),
          END_MAX = timeStrToMins("15:45"),
          DUR_MIN = 510,
          DUR_MAX = 540;
        if (wd === 2 || wd === 3) {
          DUR_MIN = 540;
          DUR_MAX = 555;
          END_MAX = timeStrToMins("16:15");
        }
        return { minEnd: Math.max(END_MIN, startMins + DUR_MIN), maxEnd: Math.min(END_MAX, startMins + DUR_MAX) };
      }

      if (state.mode === "GLS") {
        return { minEnd: Math.max(timeStrToMins("15:10"), startMins + 510), maxEnd: Math.min(timeStrToMins("15:45"), startMins + 540) };
      }

      // DPD caps
      if (wd === 1) return { minEnd: Math.max(timeStrToMins("14:25"), startMins + 480), maxEnd: Math.min(timeStrToMins("14:35"), startMins + 510) };
      if (wd === 2) return { minEnd: startMins + 525, maxEnd: startMins + 540 };
      if (wd === 3) return { minEnd: startMins + 480, maxEnd: startMins + 510 };
      if (wd === 4 || wd === 5) return { minEnd: Math.max(timeStrToMins("13:55"), startMins + 480), maxEnd: Math.min(timeStrToMins("14:10"), startMins + 510) };
      return { minEnd: startMins, maxEnd: startMins };
    }

    function rebuildAfterEnd(plan) {
      const dur = plan.end - plan.start;

      // Re-pick RP by rule (>=9h => 45–50)
      if (state.mode === "UPS") {
        const ruDur = pickRuDurByRule(dur, 32, 36);
        const rpWinStart = timeStrToMins("10:00"),
          rpWinEnd = timeStrToMins("12:00");
        const rpStart = randInt(rpWinStart, Math.max(rpWinStart, rpWinEnd - ruDur));
        plan.ru = { start: rpStart, end: rpStart + ruDur };
      } else if (state.mode === "GLS") {
        const ruDur = pickRuDurByRule(dur, 32, 36);
        const rpWinStart = timeStrToMins("09:00"),
          rpWinEnd = timeStrToMins("10:30");
        const rpStart = randInt(rpWinStart, Math.max(rpWinStart, rpWinEnd - ruDur));
        plan.ru = { start: rpStart, end: rpStart + ruDur };
      } else {
        const ruDur = pickRuDurByRule(dur, 31, 37);
        const rpWinStart = timeStrToMins("10:50"),
          rpWinEnd = timeStrToMins("11:50");
        const rpStart = randInt(rpWinStart, Math.max(rpWinStart, rpWinEnd - ruDur));
        plan.ru = { start: rpStart, end: rpStart + ruDur };
      }

      plan.so3 = { start: plan.end - randInt(15, 20), end: plan.end };
      plan.lenk.end = plan.end;
    }

    const shuffled = dates.slice().sort(() => Math.random() - 0.5);
    for (let pass = 0; pass < 6 && Math.abs(delta) > 8; pass++) {
      for (const dateStr of shuffled) {
        if (Math.abs(delta) <= 8) break;
        const plan = plans[dateStr];
        if (!plan) continue;

        const caps = getEndConstraints(dateStr, plan.start);
        const step = Math.min(20, Math.max(5, Math.abs(delta)));
        const dir = delta > 0 ? +1 : -1;
        let desiredEnd = plan.end + dir * step;
        desiredEnd = Math.min(Math.max(desiredEnd, caps.minEnd), caps.maxEnd);
        if (desiredEnd === plan.end) continue;

        const oldNet = calcNetMinsFromPlan(plan);
        plan.end = desiredEnd;
        rebuildAfterEnd(plan);
        const newNet = calcNetMinsFromPlan(plan);
        delta -= newNet - oldNet;
      }
    }

    const finalNet = Object.values(plans).reduce((a, p) => a + calcNetMinsFromPlan(p), 0);
    return { plans, baseNet, overtimeTarget, targetNet, finalNet };
  }

  /* ---------------- Modal field logic (kept same as before) ---------------- */
  function getDayStatus(modal) {
    const start = q(modal, "#start") || q(modal, 'input[name="start"]');
    const hasStart = !!(start && start.value && start.value.trim().length >= 4);

    const vehRow = q(modal, "#vehicle_dataList_body tr") || q(modal, "tbody#vehicle_dataList_body tr");
    const hasVehicleRow = !!vehRow;

    const endKm = q(modal, ".end_km") || q(modal, "#end_km") || q(modal, 'input[name="end_km"]');
    const hasEndKm = !!(endKm && endKm.value && endKm.value.trim().length > 0);

    const lenkEnd = q(modal, "#vehicle_end") || q(modal, 'input[placeholder*="Lenk"]') || q(modal, 'input[name="vehicle_end"]');
    const lenkStart = q(modal, "#vehicle_start") || q(modal, 'input[name="vehicle_start"]');
    const hasLenkStart = !!(lenkStart && lenkStart.value && lenkStart.value.trim().length >= 4);
    const hasLenkEnd = !!(lenkEnd && lenkEnd.value && lenkEnd.value.trim().length >= 4);

    const pauses = [];
    const pauseRows = $$("#pause_dataList_body > tr", modal);
    for (const tr of pauseRows) {
      const tds = $$("td", tr);
      const s = (tds[0]?.textContent || "").trim();
      const e = (tds[1]?.textContent || "").trim();
      const type = (tds[2]?.textContent || "").trim();
      if (!s || !e) continue;
      const kind = /Ruhepause/i.test(type) ? "RP" : /Sonstige/i.test(type) ? "SO" : "OTHER";
      pauses.push({ type: kind, s: timeStrToMins(s), e: timeStrToMins(e) });
    }

    const isComplete = hasStart && hasVehicleRow && hasLenkStart && hasLenkEnd && hasEndKm && pauses.length >= 3;
    return { hasStart, hasVehicleRow, hasLenkStart, hasLenkEnd, hasEndKm, pauses, isComplete };
  }

  function pauseExists(existing, type, s, e) {
    return existing.some((p) => p.type === type && Math.abs(p.s - s) <= 1 && Math.abs(p.e - e) <= 1);
  }

  async function addPause(modal, pauseTypeVal, startStr, endStr, token) {
    const typeSel = q(modal, "#pause_type") || q(modal, 'select[name="pause_type"]');
    const ps = q(modal, "#pause_start") || q(modal, 'input[name="pause_start"]');
    const pe = q(modal, "#pause_end") || q(modal, 'input[name="pause_end"]');
    if (typeSel) {
      typeSel.value = String(pauseTypeVal);
      typeSel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await cancellableSleep(120, token);
    setVal(ps, startStr);
    await cancellableSleep(120, token);
    setVal(pe, endStr);
    await cancellableSleep(160, token);
    (q(modal, "#btn_pause_add") || q(modal, 'button[id*="pause_add"]') || q(modal, 'button[type="submit"]'))?.click();
    await cancellableSleep(DELAYS.ajax, token);
  }

  function getSecondSoEndMins(existing, plan) {
    if (plan?.so2?.end != null) return plan.so2.end;
    const sos = existing.filter((p) => p.type === "SO").sort((a, b) => a.s - b.s);
    return sos.length >= 2 ? sos[1].e : plan.end;
  }

  function readEndKmFromUIOrFallback(modal, dashStartKmInt) {
    const endField = q(modal, ".end_km") || q(modal, "#end_km") || q(modal, 'input[name="end_km"]');
    const v = endField?.value || "";
    const n = parseInt(String(v).replace(/\D/g, ""), 10);
    if (n) return n;
    return dashStartKmInt ? dashStartKmInt + randInt(70, 90) : randInt(10000, 90000);
  }

  function selectVehicleByText(modal, text) {
    const sel = q(modal, "#vehicle_id") || q(modal, 'select[name="vehicle_id"]');
    if (!sel) return false;
    const t = normName(text);
    for (let i = 0; i < sel.options.length; i++) {
      const o = sel.options[i];
      const label = (o.textContent || "").trim();
      if (normName(label).includes(t)) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  async function ensureStartKm(modal, kmInt, token) {
    const startField = q(modal, ".start_km") || q(modal, "#start_km") || q(modal, 'input[name="start_km"]');
    if (startField && (!startField.value || !startField.value.trim())) {
      setVal(startField, String(kmInt));
      await cancellableSleep(DELAYS.step, token);
    }
  }

  async function completeDayIfNeeded(modal, dateStr, driver, token) {
    requireToken(token);
    const plan = state.monthPlans && state.monthPlans[dateStr] ? state.monthPlans[dateStr] : genPlanByMode(dateStr);
    if (!plan) {
      log(`Übersprungen (Wochenende): ${dateStr}`);
      return;
    }

    let status = getDayStatus(modal);
    const dashStartKmInt = getDashStartKmInt();

    if (status.isComplete) {
      const endInt = readEndKmFromUIOrFallback(modal, dashStartKmInt);
      setDashKmDot00FromInt(endInt);
      log(`Übersprungen (vollständig): ${dateStr} — End-KM: ${endInt}`);
    } else {
      const startInput = q(modal, "#start") || q(modal, 'input[name="start"]');
      if (!status.hasStart) {
        setVal(startInput, toTimeStr(plan.start));
        await cancellableSleep(DELAYS.step, token);
      }

      if (!status.hasVehicleRow) {
        const fzg = ($("#mt_fzg")?.value || "").trim();
        if (fzg) selectVehicleByText(modal, fzg);
        await cancellableSleep(DELAYS.step, token);

        if (dashStartKmInt) await ensureStartKm(modal, dashStartKmInt, token);

        (q(modal, "#btn_vehicle_add") || q(modal, 'button[id*="vehicle_add"]'))?.click();
        await cancellableSleep(DELAYS.ajax, token);
        status = getDayStatus(modal);
      }

      // Vehicle edit/update
      const pencil = q(modal, "#vehicle_dataList_body .fa-pencil, #vehicle_dataList_body .fa-pencil-alt, #vehicle_dataList_body a.text-success");
      if (pencil) {
        pencil.closest("a,button")?.click();
        await cancellableSleep(DELAYS.ajax, token);
      }

      const endField = q(modal, ".end_km") || q(modal, "#end_km") || q(modal, 'input[name="end_km"]');
      if (endField && !endField.value) {
        setVal(endField, String(dashStartKmInt + randInt(70, 90)));
        await cancellableSleep(DELAYS.step, token);
      }

      const vEnd = q(modal, "#vehicle_end") || q(modal, 'input[name="vehicle_end"]');
      if (vEnd) {
        setVal(vEnd, toTimeStr(plan.lenk.end));
        await cancellableSleep(DELAYS.step, token);
      }

      (q(modal, "#btn_vehicle_update") || q(modal, 'button[id*="vehicle_update"]'))?.click();
      await cancellableSleep(DELAYS.ajax, token);

      // Pausen (SO/SO/RP/SO)
      const need = [
        { type: "SO", val: 2, s: plan.so1.start, e: plan.so1.end },
        { type: "SO", val: 2, s: plan.so2.start, e: plan.so2.end },
        { type: "RP", val: 0, s: plan.ru.start, e: plan.ru.end },
        { type: "SO", val: 2, s: plan.so3.start, e: plan.so3.end },
      ];

      const existing = getDayStatus(modal).pauses.slice();
      for (const n of need) {
        if (!pauseExists(existing, n.type, n.s, n.e)) {
          await addPause(modal, n.val, toTimeStr(n.s), toTimeStr(n.e), token);
          existing.push({ type: n.type, s: n.s, e: n.e });
        }
      }

      // Lenkbeginn = Ende 2. SO
      const lenkBeginMins = getSecondSoEndMins(existing, plan);
      const desired = toTimeStr(lenkBeginMins);
      const pencil2 = q(modal, "#vehicle_dataList_body .fa-pencil, #vehicle_dataList_body .fa-pencil-alt, #vehicle_dataList_body a.text-success");
      if (pencil2) {
        pencil2.closest("a,button")?.click();
        await cancellableSleep(DELAYS.ajax, token);
      }
      const vStart = q(modal, "#vehicle_start") || q(modal, 'input[name="vehicle_start"]');
      if (vStart) {
        setVal(vStart, desired);
        await cancellableSleep(DELAYS.step, token);
      }
      (q(modal, "#btn_vehicle_update") || q(modal, 'button[id*="vehicle_update"]'))?.click();
      await cancellableSleep(DELAYS.ajax, token);

      const endInt = readEndKmFromUIOrFallback(modal, dashStartKmInt);
      setDashKmDot00FromInt(endInt);

      const rpLen = plan.ru.end - plan.ru.start;
      log(`✅ ${driver}: ${dateStr} — ${toTimeStr(plan.start)}→${toTimeStr(plan.end)} | RP ${rpLen}min (9h-Regel OK)`);
    }

    // close modal
    (q(modal, 'button[data-dismiss="modal"]') || q(modal, ".modal-footer .btn-secondary") || q(modal, ".close") || q(modal, "button.close"))?.click();
  }

  /* ---------------- Auto runner ---------------- */
  function debugWhyNoDates() {
    const tables = Array.from(document.querySelectorAll("table"));
    log(`DEBUG: tables found = ${tables.length}`);
    tables.slice(0, 6).forEach((t, idx) => {
      const s = scoreTableByDates(t);
      const sample = (t.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
      log(`DEBUG table#${idx + 1}: dateRows=${s} sample="${sample}"`);
    });
  }

  async function runAuto(token) {
    state.processedDates.clear();
    state.lastPickedDate = null;
    log(`▶️ Auto gestartet (nur aktuelle Seite) — MODE ${state.mode}`);

    state.monthPlans = null;
    state.monthTargetNet = null;
    state.monthBaseNet = null;
    state.monthOvertimeTarget = null;

    const table = findTimeTable();
    if (!table) {
      log("❌ Keine passende Tabelle gefunden (keine Datumszeilen).");
      debugWhyNoDates();
      alert("AutoSuite: Ich finde die Monats-Tabelle nicht. Schau im Log: DEBUG table... und schick mir 2 Zeilen.");
      return;
    }

    // init month plans once
    const built = initMonthPlansFromTable(table);
    if (built && built.plans) {
      state.monthPlans = built.plans;
      state.monthBaseNet = built.baseNet;
      state.monthOvertimeTarget = built.overtimeTarget;
      state.monthTargetNet = built.targetNet;
      log(`📊 Overtime-Plan: Basis ${Math.round(built.baseNet / 60)}h + Ziel-OT ${Math.round(built.overtimeTarget / 60)}h ⇒ Ziel NET ${Math.round(built.targetNet / 60)}h (final ~${Math.round(built.finalNet / 60)}h)`);
    } else {
      log("ℹ️ Overtime-Plan konnte nicht erstellt werden (keine Datumszeilen gefunden).");
    }

    while (true) {
      requireToken(token);

      const tbody = table.tBodies && table.tBodies[0] ? table.tBodies[0] : table.querySelector("tbody") || table;
      const rows = Array.from(tbody.querySelectorAll("tr")).filter((r) => DATE_RE.test(r.innerText || ""));

      let picked = null,
        pickedDate = null;

      for (const tr of rows) {
        const dateStr = getRowDate(tr);
        if (!dateStr) continue;
        if (state.processedDates.has(dateStr) || state.lastPickedDate === dateStr) continue;

        const btn = findEditButton(tr);
        if (!btn) continue;
        picked = tr;
        pickedDate = dateStr;
        break;
      }

      if (!picked) {
        log("🏁 Diese Seite fertig.");
        break;
      }

      state.lastPickedDate = pickedDate;

      const driver = state.currentDriverName || getSelectedDriverName() || "(Unbekannt)";
      const btn = findEditButton(picked);
      btn.click();

      const modal = await waitForModal(token);
      if (!modal) {
        log(`❌ Modal nicht geöffnet: ${pickedDate}`);
        state.processedDates.add(pickedDate);
        state.lastPickedDate = null;
        continue;
      }

      await cancellableSleep(DELAYS.openWait, token);
      await completeDayIfNeeded(modal, pickedDate, driver, token);
      await waitForModalClosed(token);
      await cancellableSleep(DELAYS.afterClose, token);

      state.processedDates.add(pickedDate);
      state.lastPickedDate = null;
    }
  }

  /* ---------------- Multi driver ---------------- */
  function parseDriverList() {
    const raw = ($("#mt_driver_list")?.value || "").trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async function runMultiDrivers(token) {
    const list = parseDriverList();
    if (!list.length) {
      alert("Bitte Fahrer-Liste einfügen (eine Zeile pro Fahrer).");
      throw ABORT;
    }
    log(`Multi Start: ${list.length} Fahrer — MODE ${state.mode}`);

    for (const name of list) {
      requireToken(token);
      if (!selectDriverByName(name)) {
        log(`❌ Fahrer nicht gefunden im Dropdown: ${name}`);
        continue;
      }
      await waitForDriverApplied(name, token);
      state.currentDriverName = name;

      loadProfileToDashboard(name);
      await waitForReady(name, token);

      if (!saveCurrentSetupToProfile()) {
        log(`❌ Setup nicht vollständig (FZG/KM/Signatur) für: ${name}`);
        throw ABORT;
      }

      await runAuto(token);

      state.currentDriverName = null;
      setReady(false);
      log(`✅ Fahrer fertig: ${name}`);
    }
    log("✅ Multi fertig");
  }

  /* ---------------- Buttons wiring ---------------- */
  function wireButtons() {
    $("#mt_stop").addEventListener("click", () => {
      state.runToken++;
      setRunning(false);
      setReady(false);
      log("Stop gedrückt: Abbruch läuft …");
    });

    $("#mt_ready_btn").addEventListener("click", () => {
      const drv = state.currentDriverName || getSelectedDriverName();
      if (!drv || /alle/i.test(drv)) {
        alert('Bitte einen Fahrer auswählen (nicht "Alle").');
        return;
      }
      loadProfileToDashboard(drv);
      if (isDashboardReady()) {
        setReady(true);
        log(`✅ Bereit: ${drv}`);
        saveCurrentSetupToProfile();
      } else {
        alert("Bitte Fahrzeug + Start-KM + Signatur ausfüllen.");
        setReady(false);
      }
    });

    $("#mt_start_auto").addEventListener("click", async () => {
      if (state.running) return;
      const token = ++state.runToken;
      setRunning(true);
      state.running = true;
      try {
        const drv = getSelectedDriverName();
        if (!drv || /alle/i.test(drv)) {
          alert('Bitte einen Fahrer auswählen (nicht "Alle").');
          throw ABORT;
        }
        state.currentDriverName = drv;
        loadProfileToDashboard(drv);
        await waitForReady(drv, token);
        if (!saveCurrentSetupToProfile()) {
          log(`❌ Setup nicht vollständig (FZG/KM/Signatur) für: ${drv}`);
          throw ABORT;
        }
        await runAuto(token);
      } catch (e) {
        if (e === ABORT) log("Gestoppt");
        else logErr(e, "Auto(1)");
      } finally {
        state.currentDriverName = null;
        setRunning(false);
        setReady(false);
      }
    });

    $("#mt_multi_start").addEventListener("click", async () => {
      if (state.running) return;
      const token = ++state.runToken;
      setRunning(true);
      state.running = true;
      try {
        await runMultiDrivers(token);
      } catch (e) {
        if (e === ABORT) log("Gestoppt");
        else logErr(e, "Multi");
      } finally {
        state.currentDriverName = null;
        setRunning(false);
        setReady(false);
      }
    });
  }

  /* ---------------- Boot ---------------- */
  (function boot() {
    const saved = GM_GetValueSafe(KEYS.mode, "UPS");
    if (MODES[saved]) state.mode = saved;
    injectUI();
    log(`✅ AutoSuite geladen — MODE ${state.mode}`);
  })();
})();
