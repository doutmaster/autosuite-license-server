// AutoSuite CORE v3.3.5 (FIX: Flatpickr Arbeitsbeginn/Arbeitsende write) + keeps ALL original flows/forms
(function () {
  "use strict";

  /* ---------------- Base config ---------------- */
  const DELAYS = {
    modal: 7000,
    openWait: 1200,
    step: 700,
    ajax: 1200,
    retry: 250,
    modalClose: 6000,
    afterClose: 900,
  };

  const KEYS = { uiMin: "master_ui_minimized", mode: "master_mode", profiles: "master_profiles_v1" };

  const MODES = {
    UPS: { label: "UPS", accent: "#ffcb05", bg: "#221b17", border: "#5a4639", muted: "#3a2e28", primary: "#745e4d", iconText: "UPS" },
    DPD: { label: "DPD", accent: "#e4002b", bg: "#1a0b0d", border: "#5a1f2b", muted: "#341319", primary: "#7a1f30", iconText: "DPD" },
    GLS: { label: "GLS", accent: "#0072ce", bg: "#07131d", border: "#1d3a55", muted: "#0f2334", primary: "#1a4e78", iconText: "GLS" },
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
      await sleep(50);
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

  const DATE_RE = /\b\d{2}\.\d{2}\.\d{4}\b/;

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
      return JSON.parse(GM_GetValueSafe(KEYS.profiles, "{}") || "{}");
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

  /* ---------------- Signature replay into MODAL (kbw-signature) ---------------- */
  function findModalSignatureCanvas(modal) {
    return modal.querySelector("#signature_canvas") || modal.querySelector("#signature canvas") || modal.querySelector("canvas#signature_canvas");
  }
  function dispatchPointerLike(canvas, type, clientX, clientY) {
    const opts = { bubbles: true, cancelable: true, clientX, clientY };
    try {
      if (typeof PointerEvent !== "undefined") {
        canvas.dispatchEvent(new PointerEvent(type, { ...opts, pointerId: 1, pointerType: "pen", buttons: 1 }));
      } else {
        const map = { pointerdown: "mousedown", pointermove: "mousemove", pointerup: "mouseup" };
        canvas.dispatchEvent(new MouseEvent(map[type] || type, opts));
      }
    } catch {
      const map = { pointerdown: "mousedown", pointermove: "mousemove", pointerup: "mouseup" };
      canvas.dispatchEvent(new MouseEvent(map[type] || type, opts));
    }
  }
  async function replaySignatureIntoModal(modal, token) {
    requireToken(token);
    if (!sigPadHasInk() || !dashSig.strokes.length) return false;

    const sigCanvas = findModalSignatureCanvas(modal);
    if (!sigCanvas) {
      log("ℹ️ Signatur-Canvas im Modal nicht gefunden (#signature_canvas).");
      return false;
    }

    try {
      const ctx = sigCanvas.getContext("2d");
      ctx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
    } catch {}

    try {
      sigCanvas.scrollIntoView({ block: "center" });
      sigCanvas.focus?.();
      sigCanvas.click();
    } catch {}

    await cancellableSleep(150, token);

    const rect = sigCanvas.getBoundingClientRect();

    for (const stroke of dashSig.strokes) {
      requireToken(token);
      if (!stroke || stroke.length < 2) continue;

      const p0 = stroke[0];
      const x0 = rect.left + p0.x * rect.width;
      const y0 = rect.top + p0.y * rect.height;

      dispatchPointerLike(sigCanvas, "pointerdown", x0, y0);
      await cancellableSleep(16, token);

      for (let i = 1; i < stroke.length; i++) {
        const p = stroke[i];
        const x = rect.left + p.x * rect.width;
        const y = rect.top + p.y * rect.height;
        dispatchPointerLike(sigCanvas, "pointermove", x, y);
        await cancellableSleep(10, token);
      }

      const plast = stroke[stroke.length - 1];
      const xl = rect.left + plast.x * rect.width;
      const yl = rect.top + plast.y * rect.height;
      dispatchPointerLike(sigCanvas, "pointerup", xl, yl);
      await cancellableSleep(40, token);
    }

    try {
      const ctx = sigCanvas.getContext("2d");
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#111";
      for (const stroke of dashSig.strokes) {
        if (!stroke || stroke.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x * sigCanvas.width, stroke[0].y * sigCanvas.height);
        for (let i = 1; i < stroke.length; i++) {
          ctx.lineTo(stroke[i].x * sigCanvas.width, stroke[i].y * sigCanvas.height);
        }
        ctx.stroke();
      }
    } catch {}

    log("✍️ Signatur ins Modal übertragen.");
    return true;
  }

  function findKorrekturBeendenButton(modal) {
    const btns = Array.from(modal.querySelectorAll("button, a, input[type='button'], input[type='submit']"));
    for (const el of btns) {
      const t = (el.textContent || el.value || "").trim().toLowerCase();
      if (t.includes("korrektur beenden")) return el;
    }
    for (const el of btns) {
      const t = (el.textContent || el.value || "").trim().toLowerCase();
      if (t.includes("korrektur") && t.includes("beenden")) return el;
    }
    for (const el of btns) {
      const title = (el.getAttribute("title") || "").toLowerCase();
      const da = (el.getAttribute("data-action") || "").toLowerCase();
      if (title.includes("korrektur") || da.includes("korrektur")) return el;
    }
    return null;
  }
  async function clickKorrekturBeenden(modal, token) {
    const btn = findKorrekturBeendenButton(modal);
    if (!btn) {
      log("ℹ️ Button 'Korrektur beenden' nicht gefunden (Selector).");
      return false;
    }
    try {
      btn.scrollIntoView({ block: "center" });
    } catch {}
    await cancellableSleep(100, token);
    btn.click();
    log("✅ 'Korrektur beenden' geklickt.");
    return true;
  }

  /* ---------------- Driver (Select2 FIX) ---------------- */
  function getSelect2Container() {
    return $("#select2-staff_id-container") || $('span.select2-selection__rendered[id*="staff_id"]');
  }
  function getDriverSelect() {
    return $("#staff_id") || $('select[name="staff_id"]') || $("#driverSelect") || $('select[name="driver"]') || $("select#driver") || $("select");
  }
  function getSelectedDriverName() {
    const s2 = getSelect2Container();
    if (s2 && (s2.textContent || "").trim()) return (s2.textContent || "").trim();
    const sel = getDriverSelect();
    if (!sel) return "";
    const opt = sel.options[sel.selectedIndex];
    return (opt?.textContent || opt?.innerText || "").trim();
  }
  async function selectDriverByNameSelect2UI(name, token) {
    const container = $("#select2-staff_id-container");
    const clickable = container?.closest(".select2")?.querySelector(".select2-selection") || container?.closest(".select2-selection") || container;
    if (!clickable) return false;

    clickable.click();
    await cancellableSleep(250, token);

    const input = $(".select2-container--open .select2-search__field");
    if (!input) return false;

    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await cancellableSleep(350, token);

    const options = $$(".select2-container--open .select2-results__option[role='option']:not(.select2-results__message)");
    if (!options.length) return false;

    const target = normName(name);
    const best = options.find((o) => normName(o.textContent || "") === target) || options[0];
    best.scrollIntoView({ block: "center" });
    best.click();
    await cancellableSleep(350, token);
    return true;
  }
  async function selectDriverByName(name, token) {
    const sel = getDriverSelect();
    const target = normName(name);

    if (sel && sel.options && sel.options.length) {
      for (let i = 0; i < sel.options.length; i++) {
        const txt = (sel.options[i].textContent || "").trim();
        if (normName(txt) === target) {
          sel.selectedIndex = i;
          try {
            if (window.jQuery && jQuery(sel).data("select2")) jQuery(sel).val(sel.options[i].value).trigger("change");
            else sel.dispatchEvent(new Event("change", { bubbles: true }));
          } catch {
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          }
          await cancellableSleep(350, token);
          return true;
        }
      }
    }
    return await selectDriverByNameSelect2UI(name, token);
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

  /* ---------------- Vehicle (Select2 FIX) ---------------- */
  function getVehicleSelect() {
    return $("#working_time_vehicle_id") || $('select[name="working_time_vehicle_id"]') || $("#vehicle_id") || $('select[name="vehicle_id"]');
  }
  function getVehicleSelect2Container() {
    return $("#select2-working_time_vehicle_id-container") || $('span.select2-selection__rendered[id*="working_time_vehicle_id"]');
  }
  async function selectVehicleByTextSelect2UI(text, token) {
    const container = getVehicleSelect2Container();
    const clickable = container?.closest(".select2")?.querySelector(".select2-selection") || container?.closest(".select2-selection") || container;
    if (!clickable) return false;

    clickable.click();
    await cancellableSleep(250, token);

    const input = $(".select2-container--open .select2-search__field");
    if (!input) return false;

    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await cancellableSleep(350, token);

    const options = $$(".select2-container--open .select2-results__option[role='option']:not(.select2-results__message)");
    if (!options.length) return false;

    const target = normName(text);
    const best =
      options.find((o) => normName(o.textContent || "") === target) ||
      options.find((o) => normName(o.textContent || "").includes(target)) ||
      options[0];

    best.scrollIntoView({ block: "center" });
    best.click();
    await cancellableSleep(350, token);
    return true;
  }
  async function selectVehicleByText(_modal, text, token) {
    const t = normName(text);
    if (!t) return false;

    const sel = getVehicleSelect();
    if (sel && sel.options && sel.options.length) {
      for (let i = 0; i < sel.options.length; i++) {
        const label = (sel.options[i].textContent || "").trim();
        if (normName(label).includes(t)) {
          sel.selectedIndex = i;
          try {
            if (window.jQuery && jQuery(sel).data("select2")) jQuery(sel).val(sel.options[i].value).trigger("change");
            else sel.dispatchEvent(new Event("change", { bubbles: true }));
          } catch {
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          }
          await cancellableSleep(250, token);
          return true;
        }
      }
    }
    return await selectVehicleByTextSelect2UI(text, token);
  }
  async function waitForVehicleApplied(expectedText, token) {
    const target = normName(expectedText);
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      requireToken(token);
      const c = getVehicleSelect2Container();
      const cur = normName((c?.textContent || "").trim());
      if (cur && !cur.includes("bitte auswählen") && cur.includes(target)) return true;
      await cancellableSleep(200, token);
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
  function setDashKmDot00FromInt(n) {
    const input = $("#mt_km");
    if (input) input.value = `${n}.00`;
    persistProfileLastKm(`${n}.00`);
  }
  function getDashStartKmInt() {
    return parseKmInt(formatDashKmDot00($("#mt_km")?.value || ""));
  }
  function getOtRangeFromDash() {
    const minH = parseFloat(($("#mt_ot_min")?.value || "").replace(",", "."));
    const maxH = parseFloat(($("#mt_ot_max")?.value || "").replace(",", "."));
    const min = isFinite(minH) && minH >= 0 ? minH : 7;
    const max = isFinite(maxH) && maxH >= min ? maxH : 9;
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
    while (Date.now() - t0 < 5000) {
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

  /* ---------------- Injected UI (KEEP ALL FORMS) ---------------- */
  function injectUI() {
    if ($("#mt_card")) return;

    const css = `
      :root{ --mt-accent:${MODES[state.mode].accent}; --mt-bg:${MODES[state.mode].bg}; --mt-border:${MODES[state.mode].border}; --mt-muted:${MODES[state.mode].muted}; --mt-primary:${MODES[state.mode].primary}; }
      .mt-card{ position:fixed; top:14px; right:14px; width:360px; max-height:92vh; overflow:auto; z-index:999999; background:var(--mt-bg); color:#fff; border:1px solid var(--mt-border); border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.35); font-family:Segoe UI,Arial; }
      .mt-inner{ padding:12px; }
      .mt-title{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .mt-badge{ padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12); font-size:12px; }
      .mt-btn{ flex:1; padding:10px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.06); color:#fff; cursor:pointer; font-weight:700; }
      .mt-btn:hover{ background:rgba(255,255,255,.10); }
      .mt-btn.primary{ background:var(--mt-primary); border-color:rgba(255,255,255,.18); }
      .mt-btn.muted{ background:rgba(255,255,255,.05); }
      .mt-btn.danger{ background:#b00020; }
      .mt-row{ display:flex; gap:10px; align-items:center; }
      .mt-field{ display:flex; flex-direction:column; gap:4px; margin:6px 0; }
      .mt-field label{ font-size:12px; opacity:.88; }
      .mt-field input,.mt-field textarea,.mt-field select{ width:100%; padding:9px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.05); color:#fff; outline:none; }
      .mt-field textarea{ resize:vertical; }
      .mt-sigbox{ border:1px dashed rgba(255,255,255,.18); border-radius:12px; padding:10px; margin:8px 0; background:rgba(255,255,255,.04); }
      .mt-sigrow{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
      .mt-sigstatus{ font-size:12px; opacity:.9; }
      .mt-canvas{ width:100%; height:110px; background:#fff; border-radius:10px; touch-action:none; }
      .mt-log{ white-space:pre-wrap; font-family:Consolas, monospace; font-size:12px; background:rgba(0,0,0,.2); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:10px; margin-top:10px; min-height:90px; }
      .mt-sign{ font-size:11px; opacity:.75; text-align:center; margin-top:8px; }
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
          <div class="mt-row" style="gap:6px;">
            <button class="mt-btn muted" id="mt_minimize">_</button>
          </div>
        </div>

        <div class="mt-field" style="margin-top:8px;">
          <label>MODE</label>
          <select id="mt_mode">
            <option value="UPS">UPS</option>
            <option value="DPD">DPD</option>
            <option value="GLS">GLS</option>
          </select>
        </div>

        <div style="font-weight:900;margin:10px 0 6px;">Setup (Fahrzeug + Start-KM + Signatur)</div>
        <div class="mt-field"><label>Fahrzeug / Vozilo</label><input id="mt_fzg" type="text"></div>
        <div class="mt-field"><label>Start-KM / Početni KM</label><input id="mt_km" type="text" placeholder="z.B. 215000.00"></div>

        <div class="mt-row" style="gap:8px;margin-top:6px;">
          <div class="mt-field" style="flex:1;">
            <label>Überstunden Ziel (Monat) — MIN (h, netto)</label>
            <input id="mt_ot_min" type="number" min="0" step="0.5" value="7">
          </div>
          <div class="mt-field" style="flex:1;">
            <label>Überstunden Ziel (Monat) — MAX (h, netto)</label>
            <input id="mt_ot_max" type="number" min="0" step="0.5" value="9">
          </div>
        </div>

        <div class="mt-sigbox">
          <div class="mt-sigrow">
            <div class="mt-sigstatus" id="mt_sig_status">Signatur: leer</div>
            <button class="mt-btn danger" id="mt_sig_clear">Clear</button>
          </div>
          <canvas id="mt_sig_canvas" class="mt-canvas" width="800" height="240"></canvas>
          <div style="margin-top:6px;opacity:.9;">➡️ Zeichne hier die Signatur für den aktuellen Fahrer.</div>
        </div>

        <div class="mt-row">
          <button class="mt-btn primary" id="mt_ready_btn">ALLES BEREIT</button>
          <button class="mt-btn muted" id="mt_stop">Stop / Zaustavi</button>
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
      document.documentElement.style.setProperty("--mt-muted", MODES[v].muted);
      document.documentElement.style.setProperty("--mt-primary", MODES[v].primary);
      $("#mt_mode_badge").textContent = MODES[v].label;
      const t = $("#mt_icon_text");
      if (t) t.textContent = MODES[v].iconText;
      const drv = state.currentDriverName || getSelectedDriverName();
      if (drv) loadProfileToDashboard(drv);
      log(`MODE geändert: ${v}`);
    });

    initSigPad();
    wireButtons();

    const isMin = !!GM_GetValueSafe(KEYS.uiMin, false);
    applyMinimizedUI(isMin);
  }

  /* ---------------- TABLE + DATE detection ---------------- */
  function getRowDate(tr) {
    const td = tr.querySelector("td.sorting_1");
    const s1 = (td?.textContent || "").trim();
    if (DATE_RE.test(s1)) return s1;
    const txt = (tr.innerText || "").replace(/\s+/g, " ");
    const m = txt.match(DATE_RE);
    return m ? m[0] : "";
  }
  function findTimeTable() {
    const dateCells = $$("td.sorting_1").filter((td) => DATE_RE.test((td.textContent || "").trim()));
    if (dateCells.length) {
      const tbl = dateCells[0].closest("table");
      if (tbl) return tbl;
    }
    const tables = $$("table");
    let best = null,
      bestScore = 0;
    for (const t of tables) {
      const score = $$("tbody tr", t).filter((tr) => DATE_RE.test(tr.innerText || "")).length;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return bestScore > 0 ? best : null;
  }
  function findEditButton(tr) {
    const candidates = Array.from(tr.querySelectorAll("a,button"));
    for (const el of candidates) {
      const t = (el.textContent || "").trim().toLowerCase();
      const title = (el.getAttribute("title") || "").toLowerCase();
      const href = (el.getAttribute("href") || "").toLowerCase();
      const dt = (el.getAttribute("data-target") || "").toLowerCase();
      const toggle = (el.getAttribute("data-toggle") || "").toLowerCase();
      const hasPencil = !!el.querySelector?.("i.fa-pencil, i.fa-pencil-alt, i.fas.fa-pencil-alt, i.fa-edit");
      const ok =
        hasPencil ||
        toggle.includes("modal") ||
        dt.includes("modal") ||
        title.includes("bearbeit") ||
        title.includes("edit") ||
        t.includes("bearbeit") ||
        t.includes("details") ||
        href.includes("edit") ||
        href.includes("bearbeit") ||
        href.includes("detail");
      if (ok) return el;
    }
    return candidates[0] || null;
  }

  /* ---------------- Modal helpers ---------------- */
  function q(modal, sel) {
    return modal.querySelector(sel);
  }

  // ✅ FIX: Flatpickr-aware setter (Arbeitsbeginn/Arbeitsende are flatpickr-input)
  function setVal(el, val) {
    if (!el) return false;

    try {
      el.removeAttribute("readonly");
    } catch {}

    const isFlatpickr = el.classList && el.classList.contains("flatpickr-input") && el._flatpickr;

    if (isFlatpickr) {
      const fp = el._flatpickr;
      // try multiple parse formats (time-only + datetime + date)
      const formats = ["H:i", "H:i:S", "d.m.Y H:i", "d.m.Y H:i:S", "d.m.Y"];
      let ok = false;
      for (const fmt of formats) {
        try {
          fp.setDate(val, true, fmt); // triggerChange=true
          ok = true;
          break;
        } catch {}
      }
      if (!ok) {
        try {
          el.value = val;
        } catch {}
        try {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } catch {}
        try {
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {}
      }
      try {
        el.blur();
      } catch {}
      return true;
    }

    // normal inputs: native setter (framework-safe)
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = desc && desc.set ? desc.set : null;

    try {
      el.focus();
    } catch {}

    try {
      if (setter) setter.call(el, val);
      else el.value = val;
    } catch {
      el.value = val;
    }

    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {}
    try {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {}
    try {
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch {}

    return true;
  }

  async function waitForModal(token) {
    const t0 = Date.now();
    while (Date.now() - t0 < DELAYS.modal) {
      requireToken(token);
      const m = $(".modal.show, .modal.in, .modal.fade.show") || $(".modal-dialog")?.closest(".modal");
      if (m) return m;
      await cancellableSleep(120, token);
    }
    return null;
  }
  async function waitForModalClosed(token) {
    const t0 = Date.now();
    while (Date.now() - t0 < DELAYS.modalClose) {
      requireToken(token);
      const m = $(".modal.show, .modal.in, .modal.fade.show");
      if (!m) return true;
      await cancellableSleep(120, token);
    }
    return false;
  }

  /* ---------------- Overtime + RP rule helpers ---------------- */
  function calcNetMinsFromPlan(plan) {
    const ruDur = plan?.ru?.end != null && plan?.ru?.start != null ? plan.ru.end - plan.ru.start : 0;
    return plan.end - plan.start - ruDur;
  }
  // IMPORTANT RULE: if (end-start) >= 9:00h => RP must be 45–50 min
  function pickRuDurByRule(durMins, baseMin, baseMax) {
    if (durMins >= 540) return randInt(45, 50);
    return randInt(baseMin, baseMax);
  }

  /* ---------------- Mode-specific constraints for overtime adjustment ---------------- */
  function getEndConstraintsByMode(dateStr, startMins) {
    const d = deDateStrToDate(dateStr);
    const wd = d.getDay();

    if (state.mode === "UPS") {
      let END_MIN = timeStrToMins("15:10");
      let END_MAX = timeStrToMins("15:45");
      let DUR_MIN = 510,
        DUR_MAX = 540;
      if (wd === 2 || wd === 3) {
        DUR_MIN = 540;
        DUR_MAX = 555;
        END_MAX = timeStrToMins("16:15");
      }
      return { endMin: END_MIN, endMax: END_MAX, durMin: DUR_MIN, durMax: DUR_MAX, locked: false };
    }
    if (state.mode === "GLS") {
      return { endMin: timeStrToMins("15:10"), endMax: timeStrToMins("15:45"), durMin: 510, durMax: 540, locked: false };
    }

    // DPD
    const MON_THU_FRI_MIN = 480,
      MON_THU_FRI_MAX = 510;
    const WED_MIN = 480,
      WED_MAX = 510;
    const TUE_MIN = 525,
      TUE_MAX = 540;

    if (wd === 1) return { endMin: timeStrToMins("14:25"), endMax: timeStrToMins("14:35"), durMin: MON_THU_FRI_MIN, durMax: MON_THU_FRI_MAX, locked: false };
    if (wd === 2) return { endMin: startMins + TUE_MIN, endMax: startMins + TUE_MAX, durMin: TUE_MIN, durMax: TUE_MAX, locked: false };
    if (wd === 3) return { endMin: startMins + WED_MIN, endMax: startMins + WED_MAX, durMin: WED_MIN, durMax: WED_MAX, locked: false };
    if (wd === 4 || wd === 5) return { endMin: timeStrToMins("13:55"), endMax: timeStrToMins("14:10"), durMin: MON_THU_FRI_MIN, durMax: MON_THU_FRI_MAX, locked: false };
    return { endMin: 0, endMax: 0, durMin: 0, durMax: 0, locked: true };
  }

  function rebuildPlanAfterEndChange(plan) {
    const start = plan.start,
      end = plan.end;
    const dur = end - start;

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

    plan.so3 = { start: end - randInt(15, 20), end };
    plan.lenk.end = end;
    return plan;
  }

  /* ---------------- Month overtime planner (NET + 40h/week base) ---------------- */
  function initMonthPlansFromTable(table) {
    const rows = Array.from(table.querySelectorAll("tbody tr")).filter((r) => {
      const td = r.querySelector("td.sorting_1");
      return td && DATE_RE.test((td.textContent || "").trim());
    });

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

    let delta = targetNet - currentNet;
    const shuffled = dates.slice().sort(() => Math.random() - 0.5);

    for (let pass = 0; pass < 6 && Math.abs(delta) > 8; pass++) {
      for (const dateStr of shuffled) {
        if (Math.abs(delta) <= 8) break;
        const plan = plans[dateStr];
        if (!plan) continue;

        const cons = getEndConstraintsByMode(dateStr, plan.start);
        if (cons.locked) continue;

        const step = Math.min(20, Math.max(5, Math.abs(delta)));
        const direction = delta > 0 ? +1 : -1;
        let desiredEnd = plan.end + direction * step;

        const minEnd = Math.max(cons.endMin, plan.start + cons.durMin);
        const maxEnd = Math.min(cons.endMax, plan.start + cons.durMax);
        desiredEnd = Math.min(Math.max(desiredEnd, minEnd), maxEnd);

        if (desiredEnd === plan.end) continue;

        const oldNet = calcNetMinsFromPlan(plan);
        plan.end = desiredEnd;
        rebuildPlanAfterEndChange(plan);
        const newNet = calcNetMinsFromPlan(plan);

        const gain = newNet - oldNet;
        if (gain === 0) continue;
        delta -= gain;
      }
    }

    const finalNet = Object.values(plans).reduce((a, p) => a + calcNetMinsFromPlan(p), 0);
    return { plans, baseNet, overtimeTarget, targetNet, finalNet };
  }

  /* ---------------- Plan generators (RP 9h rule included) ---------------- */
  function genPlanUPS(dateStr) {
    const d = deDateStrToDate(dateStr);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) return null;

    const START_MIN = timeStrToMins("06:40"),
      START_MAX = timeStrToMins("07:10");

    let END_MIN = timeStrToMins("15:10");
    let END_MAX = timeStrToMins("15:45");
    let DUR_MIN = 510,
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

    const adjMin = Math.max(END_MIN, start + DUR_MIN);
    const adjMax = Math.min(END_MAX, start + DUR_MAX);
    end = Math.min(Math.max(end, adjMin), adjMax);

    const so1 = { start, end: start + randInt(15, 20) };
    const so2 = { start: so1.end + randInt(5, 10) };
    so2.end = so2.start + randInt(115, 130);

    const dur = end - start;
    const ruDur = pickRuDurByRule(dur, 32, 36);
    const rpWinStart = timeStrToMins("10:00");
    const rpWinEnd = timeStrToMins("12:00");
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
    const rpWinStart = timeStrToMins("10:50");
    const rpWinEnd = timeStrToMins("11:50");
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

    const adjMin = Math.max(END_MIN, start + DUR_MIN);
    const adjMax = Math.min(END_MAX, start + DUR_MAX);
    end = Math.min(Math.max(end, adjMin), adjMax);

    const so1 = { start, end: start + randInt(15, 20) };
    const so2 = { start: so1.end + randInt(5, 10) };
    so2.end = so2.start + randInt(115, 130);

    const dur = end - start;
    const ruDur = pickRuDurByRule(dur, 32, 36);
    const rpWinStart = timeStrToMins("09:00");
    const rpWinEnd = timeStrToMins("10:30");
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

  /* ---------------- Completion helpers ---------------- */
  function getDayStatus(modal) {
    const start = q(modal, "#start");
    const end = q(modal, "#end");

    const hasStart = !!(start && start.value && start.value.trim().length >= 4);
    const hasEnd = !!(end && end.value && end.value.trim().length >= 4);

    const vehRow = q(modal, "#vehicle_dataList_body tr");
    const hasVehicleRow = !!vehRow;

    const endKm = q(modal, ".end_km") || q(modal, "#end_km");
    const hasEndKm = !!(endKm && endKm.value && endKm.value.trim().length > 0);

    const lenkEnd = q(modal, "#vehicle_end") || q(modal, 'input[placeholder="Lenkende"]');
    const lenkStart = q(modal, "#vehicle_start") || q(modal, 'input[placeholder="Lenkbeginn"]');
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
      pauses.push({ type: kind, s: timeStrToMins(s), e: timeStrToMins(e), raw: type });
    }

    const isComplete = hasStart && hasEnd && hasVehicleRow && hasLenkStart && hasLenkEnd && hasEndKm && pauses.length >= 3;
    return { hasStart, hasEnd, hasVehicleRow, hasLenkStart, hasLenkEnd, hasEndKm, pauses, isComplete };
  }

  function pauseExists(existing, type, s, e) {
    return existing.some((p) => p.type === type && Math.abs(p.s - s) <= 1 && Math.abs(p.e - e) <= 1);
  }
  async function addPause(modal, pauseTypeVal, startStr, endStr, token) {
    const typeSel = q(modal, "#pause_type");
    const ps = q(modal, "#pause_start");
    const pe = q(modal, "#pause_end");
    if (typeSel) typeSel.value = String(pauseTypeVal);
    if (typeSel) typeSel.dispatchEvent(new Event("change", { bubbles: true }));
    await cancellableSleep(120, token);
    setVal(ps, startStr);
    await cancellableSleep(120, token);
    setVal(pe, endStr);
    await cancellableSleep(160, token);
    q(modal, "#btn_pause_add")?.click();
    await cancellableSleep(DELAYS.ajax, token);
  }

  function getSecondSoEndMins(existing, plan) {
    if (plan?.so2?.end != null) return plan.so2.end;
    const sos = existing.filter((p) => p.type === "SO").sort((a, b) => a.s - b.s);
    return sos.length >= 2 ? sos[1].e : plan.end;
  }

  function readEndKmFromUIOrTable(modal, dashStartKmInt) {
    const endField = q(modal, ".end_km") || q(modal, "#end_km");
    const v = endField?.value || "";
    const n = parseInt(String(v).replace(/\D/g, ""), 10);
    if (n) return n;
    return dashStartKmInt ? dashStartKmInt + randInt(70, 90) : randInt(10000, 90000);
  }

  async function ensureStartKm(modal, kmInt, token) {
    const startField = q(modal, ".start_km") || q(modal, "#start_km");
    if (startField && (!startField.value || !startField.value.trim())) {
      setVal(startField, String(kmInt));
      await cancellableSleep(DELAYS.step, token);
    }
  }
  async function keepStartKmStable(modal, kmInt, token) {
    const startField = q(modal, ".start_km") || q(modal, "#start_km");
    if (!startField) return;
    const n = parseInt(String(startField.value || "").replace(/\D/g, ""), 10);
    if (!n || n !== kmInt) {
      setVal(startField, String(kmInt));
      await cancellableSleep(DELAYS.step, token);
    }
  }

  /* ---------------- Core day completion (FIXED start/end) ---------------- */
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
      const endInt = readEndKmFromUIOrTable(modal, dashStartKmInt);
      setDashKmDot00FromInt(endInt);
      log(`Übersprungen (vollständig): ${dateStr} — End-KM übernommen: ${endInt}`);
    } else {
      // ✅ FIX: Always set both Arbeitsbeginn + Arbeitsende via flatpickr-aware setVal
      if (!status.hasStart) {
        const ab = q(modal, "#start");
        if (ab) {
          setVal(ab, toTimeStr(plan.start));
          await cancellableSleep(250, token);
        } else {
          log("❌ Arbeitsbeginn Feld (#start) nicht gefunden");
        }
      }
      if (!status.hasEnd) {
        const ae = q(modal, "#end");
        if (ae) {
          setVal(ae, toTimeStr(plan.end));
          await cancellableSleep(250, token);
        } else {
          log("❌ Arbeitsende Feld (#end) nicht gefunden");
        }
      }

      // re-check after set
      status = getDayStatus(modal);

      if (!status.hasVehicleRow) {
        const fzg = ($("#mt_fzg")?.value || "").trim();
        if (fzg) {
          const ok = await selectVehicleByText(modal, fzg, token);
          if (ok) await waitForVehicleApplied(fzg, token);
        }

        await cancellableSleep(DELAYS.step, token);

        if (dashStartKmInt) {
          await ensureStartKm(modal, dashStartKmInt, token);
          await keepStartKmStable(modal, dashStartKmInt, token);
        }

        q(modal, "#btn_vehicle_add")?.click();
        await cancellableSleep(DELAYS.ajax, token);

        if (dashStartKmInt) await keepStartKmStable(modal, dashStartKmInt, token);
        status = getDayStatus(modal);
      }

      if (!status.hasLenkStart || !status.hasLenkEnd || !status.hasEndKm) {
        const pencil = q(
          modal,
          "#vehicle_dataList_body .fa-pencil, #vehicle_dataList_body .fa-pencil-alt, #vehicle_dataList_body .fas.fa-pencil-alt, #vehicle_dataList_body a.text-success"
        );
        if (pencil) {
          pencil.closest("a,button")?.click();
          await cancellableSleep(DELAYS.ajax, token);
        }

        const endField = q(modal, ".end_km") || q(modal, "#end_km");
        if (endField && !endField.value) {
          const endKmInt = dashStartKmInt + randInt(70, 90);
          setVal(endField, String(endKmInt));
          await cancellableSleep(DELAYS.step, token);
        }

        const vEnd = q(modal, "#vehicle_end") || q(modal, 'input[placeholder="Lenkende"]');
        if (vEnd && !vEnd.value) {
          setVal(vEnd, toTimeStr(plan.lenk.end));
          await cancellableSleep(DELAYS.step, token);
        }

        q(modal, "#btn_vehicle_update")?.click();
        await cancellableSleep(DELAYS.ajax, token);
        if (dashStartKmInt) await keepStartKmStable(modal, dashStartKmInt, token);
        status = getDayStatus(modal);
      }

      const need = [
        { type: "SO", val: 2, s: plan.so1.start, e: plan.so1.end },
        { type: "SO", val: 2, s: plan.so2.start, e: plan.so2.end },
        { type: "RP", val: 0, s: plan.ru.start, e: plan.ru.end },
        { type: "SO", val: 2, s: plan.so3.start, e: plan.so3.end },
      ];
      const existing = status.pauses.slice();
      for (const n of need) {
        if (!pauseExists(existing, n.type, n.s, n.e)) {
          await addPause(modal, n.val, toTimeStr(n.s), toTimeStr(n.e), token);
          existing.push({ type: n.type, s: n.s, e: n.e });
        }
      }

      // Force Lenkbeginn = Ende 2. SO
      {
        const lenkBeginMins = getSecondSoEndMins(existing, plan);
        const desired = toTimeStr(lenkBeginMins);

        const pencil2 = q(
          modal,
          "#vehicle_dataList_body .fa-pencil, #vehicle_dataList_body .fa-pencil-alt, #vehicle_dataList_body .fas.fa-pencil-alt, #vehicle_dataList_body a.text-success"
        );
        if (pencil2) {
          pencil2.closest("a,button")?.click();
          await cancellableSleep(DELAYS.ajax, token);
        }

        const vStart = q(modal, "#vehicle_start") || q(modal, 'input[placeholder="Lenkbeginn"]');
        if (vStart) {
          setVal(vStart, desired);
          await cancellableSleep(DELAYS.step, token);
        }

        q(modal, "#btn_vehicle_update")?.click();
        await cancellableSleep(DELAYS.ajax, token);
        if (dashStartKmInt) await keepStartKmStable(modal, dashStartKmInt, token);
      }

      const endInt = readEndKmFromUIOrTable(modal, dashStartKmInt);
      setDashKmDot00FromInt(endInt);
      log(`✅ ${driver}: ${dateStr} — Start ${toTimeStr(plan.start)} End ${toTimeStr(plan.end)} | RP ${plan.ru.end - plan.ru.start}min (Regel ok)`);
    }

    // Always push signature into modal before finishing correction
    await replaySignatureIntoModal(modal, token);
    await cancellableSleep(200, token);

    // Click "Korrektur beenden"
    await clickKorrekturBeenden(modal, token);

    // Fallback close
    await cancellableSleep(450, token);
    q(modal, "button[data-dismiss='modal'], .modal-footer .btn-secondary, .close, button.close")?.click();
  }

  /* ---------------- Auto runner: current page ---------------- */
  async function runAuto(token) {
    state.processedDates.clear();
    state.lastPickedDate = null;
    log(`▶️ Auto gestartet (nur aktuelle Seite) — MODE ${state.mode}`);

    state.monthPlans = null;

    const table = findTimeTable();
    if (!table) {
      log("❌ Tabelle nicht gefunden (keine td.sorting_1 Datumszellen).");
      return;
    }

    const built = initMonthPlansFromTable(table);
    if (built?.plans) {
      state.monthPlans = built.plans;
      state.monthBaseNet = built.baseNet;
      state.monthOvertimeTarget = built.overtimeTarget;
      state.monthTargetNet = built.targetNet;
      log(`📊 Overtime-Plan: Basis ${Math.round(built.baseNet / 60)}h + Ziel-OT ${Math.round(built.overtimeTarget / 60)}h ⇒ Ziel NET ${Math.round(built.targetNet / 60)}h`);
    } else {
      log("ℹ️ Overtime-Plan konnte nicht erstellt werden (keine Datumszeilen gefunden).");
    }

    while (true) {
      requireToken(token);

      const tbody = table.tBodies && table.tBodies[0] ? table.tBodies[0] : table.querySelector("tbody");
      if (!tbody) {
        log("Kein tbody.");
        break;
      }

      const rows = Array.from(tbody.querySelectorAll("tr")).filter((r) => r.querySelector("td.sorting_1"));

      let picked = null,
        pickedDate = null;

      for (const tr of rows) {
        const dateStr = getRowDate(tr);
        if (!dateStr) continue;
        if (state.processedDates.has(dateStr) || state.lastPickedDate === dateStr) continue;

        const btn = findEditButton(tr);
        if (!btn) {
          state.processedDates.add(dateStr);
          continue;
        }
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
      findEditButton(picked).click();

      const modal = await waitForModal(token);
      if (!modal) {
        log(`Modal nicht geöffnet: ${pickedDate}`);
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

  /* ---------------- Duplicate pause cleaner (SO/RP) ---------------- */
  const CLEAN_CFG = {
    pauseRowSel: "#pause_dataList_body > tr",
    deleteBtnSel: 'a[title="Löschen"]',
    swalConfirmSel: ".swal2-confirm",
  };

  function readPauseRows(modal) {
    const rows = $$(CLEAN_CFG.pauseRowSel, modal);
    return rows.map((tr) => {
      const tds = $$("td", tr);
      const start = (tds[0]?.textContent || "").trim();
      const end = (tds[1]?.textContent || "").trim();
      const type = (tds[2]?.textContent || "").trim();
      const del = $(CLEAN_CFG.deleteBtnSel, tds[3] || tr);
      let kind = "OTHER";
      if (/^Sonstige\s*Arbeitszeit\s*\(SO\)$/i.test(type)) kind = "SO";
      else if (/^Ruhepause\s*\(RP\)$/i.test(type)) kind = "RP";
      return { tr, start, end, rawType: type, kind, del };
    });
  }
  function listDuplicates(rows) {
    const map = new Map();
    for (const r of rows) {
      if (r.kind !== "SO" && r.kind !== "RP") continue;
      const key = `${r.kind}|${r.start}|${r.end}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const dups = [];
    for (const [key, arr] of map) if (arr.length > 1) dups.push({ key, keep: arr[0], extras: arr.slice(1) });
    return dups;
  }
  async function deletePauseRow(rowObj, token) {
    const btn = rowObj?.del;
    if (!btn) return false;
    try {
      btn.scrollIntoView({ block: "center" });
    } catch {}
    await cancellableSleep(80, token);
    btn.click();
    await cancellableSleep(700, token);

    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const confirm = $(CLEAN_CFG.swalConfirmSel);
      if (confirm) {
        confirm.click();
        await cancellableSleep(800, token);
        break;
      }
      await cancellableSleep(120, token);
    }
    return true;
  }
  async function cleanDuplicatesInOpenModal(modal, token) {
    const rows = readPauseRows(modal);
    const dups = listDuplicates(rows);
    if (!dups.length) {
      log("🧼 Keine Duplikate gefunden.");
      return 0;
    }
    let removed = 0;
    for (const d of dups) {
      for (const ex of d.extras) {
        requireToken(token);
        const ok = await deletePauseRow(ex, token);
        if (ok) removed++;
        await cancellableSleep(250, token);
      }
    }
    log(`🧼 Duplikate entfernt: ${removed}`);
    return removed;
  }
  async function cleanOneOpen(token) {
    const modal = $(".modal.show, .modal.in, .modal.fade.show");
    if (!modal) {
      alert("Kein offenes Modal gefunden.");
      return;
    }
    await cleanDuplicatesInOpenModal(modal, token);
  }
  async function cleanPageCurrentDriver(token) {
    const table = findTimeTable();
    if (!table) {
      log("Tabelle nicht gefunden.");
      return;
    }
    const tbody = table.tBodies && table.tBodies[0] ? table.tBodies[0] : table.querySelector("tbody");
    const rows = Array.from(tbody.querySelectorAll("tr")).filter((r) => r.querySelector("td.sorting_1"));
    for (const tr of rows) {
      requireToken(token);
      const btn = findEditButton(tr);
      if (!btn) continue;
      btn.click();
      const modal = await waitForModal(token);
      if (!modal) continue;
      await cancellableSleep(DELAYS.openWait, token);
      await cleanDuplicatesInOpenModal(modal, token);

      await clickKorrekturBeenden(modal, token);
      await cancellableSleep(450, token);
      q(modal, "button[data-dismiss='modal'], .modal-footer .btn-secondary, .close, button.close")?.click();

      await waitForModalClosed(token);
      await cancellableSleep(DELAYS.afterClose, token);
    }
  }
  async function cleanAllPagesForCurrentDriver(token) {
    await cleanPageCurrentDriver(token);
  }

  /* ---------------- Multi driver ---------------- */
  function parseDriverList() {
    const raw = ($("#mt_driver_list")?.value || "").trim();
    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
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

      const ok = await selectDriverByName(name, token);
      if (!ok) {
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

      log(`🧼 Monat fertig → starte Duplikate-Cleaner (von Anfang): ${name}`);
      await cleanAllPagesForCurrentDriver(token);

      state.currentDriverName = null;
      setReady(false);
      log(`✅ Fahrer fertig: ${name}`);
    }
    log("✅ Multi fertig");
  }

  /* ---------------- Buttons wiring (KEEP ALL FORMS) ---------------- */
  function wireButtons() {
    $("#mt_stop").addEventListener("click", () => {
      state.runToken++;
      setRunning(false);
      setReady(false);
      log("Stop gedrückt: Abbruch läuft …");
    });

    $("#mt_ready_btn").addEventListener("click", () => {
      const drv = state.currentDriverName || getSelectedDriverName();
      if (!drv || /Alle Auswählen/i.test(drv)) {
        alert('Bitte einen Fahrer auswählen (nicht "Alle Auswählen").');
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
        if (!drv || /Alle Auswählen/i.test(drv)) {
          alert('Bitte einen Fahrer auswählen (nicht "Alle Auswählen").');
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

        log(`🧼 Monat fertig → starte Duplikate-Cleaner (von Anfang): ${drv}`);
        await cleanAllPagesForCurrentDriver(token);
      } catch (e) {
        if (e === ABORT) log("Gestoppt");
        else logErr(e, "Auto(1)");
      } finally {
        state.currentDriverName = null;
        setRunning(false);
        setReady(false);
      }
    });

    $("#mt_one_day").addEventListener("click", async () => {
      if (state.running) return;
      const token = ++state.runToken;
      setRunning(true);
      state.running = true;
      try {
        const drv = state.currentDriverName || getSelectedDriverName();
        if (!drv || /Alle Auswählen/i.test(drv)) {
          alert('Bitte einen Fahrer auswählen (nicht "Alle Auswählen").');
          throw ABORT;
        }
        state.currentDriverName = drv;
        loadProfileToDashboard(drv);
        await waitForReady(drv, token);

        const modal = $(".modal.show, .modal.in, .modal.fade.show");
        if (!modal) {
          alert("Bitte zuerst einen Tag öffnen (Bearbeiten).");
          throw ABORT;
        }
        const dateStr = state.lastPickedDate || prompt("Datum (DD.MM.YYYY) eingeben:", "");
        if (!dateStr) throw ABORT;

        await completeDayIfNeeded(modal, dateStr, drv, token);
      } catch (e) {
        if (e === ABORT) log("Gestoppt");
        else logErr(e, "Nur 1 Tag");
      } finally {
        state.currentDriverName = null;
        setRunning(false);
        setReady(false);
      }
    });

    $("#mt_clean_one_open").addEventListener("click", async () => {
      if (state.running) return;
      const token = ++state.runToken;
      setRunning(true);
      state.running = true;
      try {
        await cleanOneOpen(token);
      } catch (e) {
        if (e === ABORT) log("Gestoppt");
        else logErr(e, "Clean(1 open)");
      } finally {
        setRunning(false);
      }
    });

    $("#mt_clean_page").addEventListener("click", async () => {
      if (state.running) return;
      const token = ++state.runToken;
      setRunning(true);
      state.running = true;
      try {
        await cleanPageCurrentDriver(token);
      } catch (e) {
        if (e === ABORT) log("Gestoppt");
        else logErr(e, "Clean(page)");
      } finally {
        setRunning(false);
      }
    });

    $("#mt_clean_driver").addEventListener("click", async () => {
      if (state.running) return;
      const token = ++state.runToken;
      setRunning(true);
      state.running = true;
      try {
        await cleanAllPagesForCurrentDriver(token);
      } catch (e) {
        if (e === ABORT) log("Gestoppt");
        else logErr(e, "Clean(driver)");
      } finally {
        setRunning(false);
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
