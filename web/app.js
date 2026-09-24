// The page: connects to the PM5, feeds its notifications through the Session, drives the
// dashboard, programs workouts, saves finished rows in the browser and shows the fitness report.
// Served by the Python logger instead, it leaves the PM5 and the saving to the logger and
// follows the logger's events (logger-feed.js).
import { Session, readRaw, AFTER_END_S, parse } from "./decode.js";
import * as C from "./csafe.js";
import * as V from "./vo2.js";
import * as BLE from "./ble.js";
import * as DB from "./store.js";
import { H, render, S, metrics } from "./dashboard.js";
import * as G from "./guided.js";
import { GuidedUI } from "./guided-ui.js";
import * as Wake from "./wake.js";
import * as Fit from "./fit.js";
import * as P from "./progress.js";
import * as Logger from "./logger-feed.js";
import { Recorder, rebuild } from "./recorder.js";

const $ = id => document.getElementById(id);
const state = { pm: null, endTimer: null, sample: false, named: {}, lastSaved: null, logger: null, unsaved: new Map() };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function setConn(text, cls = "") { $("conn").textContent = text; $("conn").className = cls; }
const emit = (kind, data) => { (H[kind] || (() => {}))(data); if (!state.sample) guided.onEvent(kind, data); render(); };

// ---------- a session per piece (recorder.js does the recording and saving) ----------
const rec = new Recorder({ store: DB, stamp, emit, fatigue: d => withFatigue(d),
  onStart: meta => { H.reset({}); if (state.pm) H.device({ ...state.pm.info, workout: meta.workout }); render(); } });
const recording = () => !!(rec.session && rec.session.strokes.size);

function onPacket(t, short, b) {
  if (short === 0x003b) { const p = parse(short, b); if (p && p.hrm_id) rememberHrm({ mfg: p.hrm_mfg, type: p.hrm_type, id: p.hrm_id }, "paired with"); }
  const { finishing } = rec.packet(t, short, b);
  if (finishing) {                      // the PM5 started a new piece: the recorder is saving the old one and recording the new
    clearTimeout(state.endTimer); state.endTimer = null;
    finishing.then(out => afterSave(out, "a new piece started on the PM5"));
  }
  if (rec.session && rec.session.endAt !== null && !state.endTimer) {
    setConn(`piece ended on the PM5; saving in ${AFTER_END_S} s (it re-sends its summary with the recovery heart rate)`, "live");
    state.endTimer = setTimeout(() => saveRow("the piece ended on the PM5"), AFTER_END_S * 1000);
  }
}

/** When peak position started drifting later, if it did: saved with every row. */
function withFatigue(data) {
  data.fatigue = G.fatigueOnset(data.strokes.map(st => { const c = st.force_curve_v2 || st.force_curve, m = c ? metrics(c) : null; return { t: st.elapsed_s, a100: m ? m.a100 : null }; }));
  return data;
}

/** Save the current piece (if it has strokes) and leave the dashboard showing it. */
async function saveRow(reason) {
  clearTimeout(state.endTimer); state.endTimer = null;
  afterSave(await rec.finish(), reason);
}

/** Report a save. What was not written stays in memory, with buttons to download it. */
function afterSave(out, reason) {
  if (!out) return;
  const { id, data } = out;
  if (out.saved !== "none") state.lastSaved = id;
  if (out.saved === "all") {
    H.ended({ session: id });
    if (data.fatigue && data.fatigue.onset_s != null) $("banner").textContent += ` · peak position drifted later from ${G.fmtClock(data.fatigue.onset_s)}`;
    setConn(`${reason}; saved ${data.strokes.length} strokes as ${id}`, state.pm && state.pm.connected ? "live" : "");
  } else {
    state.unsaved.set(id, { ...out, need: new Set(out.saved === "session" ? ["raw"] : ["json", "raw"]) });
    showUnsaved();
    setConn(`${reason}; saving ${id} failed: download it from the box above`, "err");
    $("banner").textContent = out.saved === "session" ? "raw log not saved" : "not saved";
  }
  showFitness([[id, data]]);
  refreshSessions();
}

function showUnsaved() {
  const box = $("unsaved");
  box.replaceChildren(); box.hidden = !state.unsaved.size;
  for (const [id, u] of state.unsaved) {
    const p = box.appendChild(document.createElement("div"));
    p.textContent = u.saved === "session"
      ? `${id} was saved in this browser, but its raw log was not (${u.error.message}). Download the raw log before leaving the page: `
      : `${id} could not be saved in this browser (${u.error.message}). Download it before leaving the page, or it is lost: `;
    for (const kind of u.need) {
      const b = p.appendChild(document.createElement("button"));
      b.textContent = kind === "json" ? "session JSON" : "raw log";
      b.addEventListener("click", () => {
        if (kind === "json") DB.download(`${id}.json`, JSON.stringify(u.data, null, 1));
        else DB.download(`${id}.jsonl`, u.lines.map(l => JSON.stringify(l)).join("\n") + "\n", "application/x-ndjson");
        u.need.delete(kind); if (!u.need.size) state.unsaved.delete(id);
        showUnsaved();
      });
    }
  }
}

/** A raw log with no session beside it is a row the page never finished: the tab was closed or
 *  killed mid-row. Rebuild it from its last checkpoint. (Were another tab still recording it, which
 *  the PM5's single connection all but rules out, that tab's own save would replace this copy.) */
async function recoverUnfinished() {
  try {
    const have = new Set((await DB.listSessions()).map(s => s.started)), found = [];
    for (const id of await DB.listRawIds()) {
      if (have.has(id)) continue;
      const r = await DB.getRaw(id), lines = r ? r.lines : [];
      const data = rebuild(id, lines, { recovered: true, fatigue: withFatigue });
      if (data) { await DB.putSession(data); found.push(`${id} (${data.strokes.length} strokes)`); }
    }
    if (found.length) { setConn(`recovered ${found.join(", ")} from a row that was not finished; the last minute or so may be missing`); refreshSessions(); }
  } catch { /* no storage: nothing to recover */ }
}

// ---------- Bluetooth ----------
async function connect() {
  if (!BLE.supported()) { $("nobt").hidden = false; setConn("this browser has no Web Bluetooth", "err"); return; }
  state.sample = false;
  $("connect").disabled = true;
  try {
    setConn("choose your PM5 in the browser's list…");
    state.pm = await BLE.connect({ onNotify: onPacket, onDisconnect: onDisconnected, log: msg => setConn(msg) });
  } catch (e) {
    state.pm = null; $("connect").disabled = false;
    setConn(e.name === "NotFoundError" ? "no PM5 chosen" : `could not connect: ${e.message}`, e.name === "NotFoundError" ? "" : "err");
    return;
  }
  $("intro").hidden = true; $("stop").hidden = false; $("wo_send").disabled = !state.pm.control; $("wo_clear").disabled = !state.pm.control;
  rec.device = state.pm.info; rec.workout = undefined;
  rec.start();
  updateWake();
  syncHeartRateMonitor();
  setConn(`live: ${state.pm.info.name}${state.pm.info.firmware_rev ? ", firmware " + state.pm.info.firmware_rev : ""}. Row when ready; end the piece on the PM5 (Menu)`, "live");
}

async function onDisconnected() {
  if (recording()) await saveRow("the PM5 disconnected");
  else if (!state.stopping) setConn("the PM5 disconnected");   // after Stop, the line keeps what the save said
  state.stopping = false;
  state.pm = null;
  updateWake();
  $("connect").disabled = false; $("stop").hidden = true; $("wo_send").disabled = true; $("wo_clear").disabled = true;
}

async function stop() {
  state.stopping = recording();       // a save to report, which the disconnect then leaves on the line
  if (state.stopping) await saveRow("stopped");
  if (state.pm) state.pm.disconnect();   // onDisconnected does the rest
}

// ---------- the heart-rate monitor: remembered here, paired by the PM5 ----------
// The PM5 reports the monitor it is paired with (a CSAFE query on connect, and characteristic
// 0x003B whenever it changes). The page remembers it, and on a later connection where the PM5
// has nothing paired it asks the PM5 to pair with that one, saving a trip through its menus.
const loadHrm = () => { try { return JSON.parse(localStorage.getItem("pm5_hrm")); } catch { return null; } };
const hrmName = m => `monitor ${m.id.toString(16).toUpperCase().padStart(8, "0")}`;
function showHrm(text, known) {
  $("hrm").innerHTML = text ? `${text}${known ? ' <a href="#" id="hrm_forget" title="Stop pairing this monitor automatically">forget</a>' : ""}` : "";
  const f = $("hrm_forget");
  if (f) f.addEventListener("click", e => { e.preventDefault(); localStorage.removeItem("pm5_hrm"); showHrm("heart rate: monitor forgotten", false); });
}
function rememberHrm(m, verb) {
  try { localStorage.setItem("pm5_hrm", JSON.stringify({ mfg: m.mfg, type: m.type, id: m.id })); } catch { /* private window */ }
  showHrm(`heart rate: ${verb} ${hrmName(m)}`, true);
}
async function syncHeartRateMonitor() {
  if (!state.pm || !state.pm.control) return;
  try {
    const [, resp] = await state.pm.send(C.hrBeltQueryFrame());
    const now = C.parseHrBelt(resp), saved = loadHrm();
    if (now && now.id) return rememberHrm(now, "paired with");
    if (saved && saved.id) {
      const [st] = await state.pm.send(C.hrBeltPairFrame(saved));
      if (st & 0x30) throw new Error(`the PM5 said ${C.describeStatus(st)}`);
      return showHrm(`heart rate: asked the PM5 to pair with ${hrmName(saved)}`, true);
    }
    showHrm("heart rate: nothing paired; pair once on the monitor and the page will remember it", false);
  } catch (e) { showHrm(`heart rate: couldn't check the monitor (${e.message})`, !!loadHrm()); }
}

// ---------- programming the PM5 ----------
async function loadWorkouts() {
  try {
    const r = await fetch("workouts.json"); state.named = C.namedWorkouts(await r.json());
    const sel = $("wo_named");
    for (const [name, spec] of Object.entries(state.named)) { const o = document.createElement("option"); o.value = name; o.textContent = `${name} · ${C.describe(spec)}`; sel.appendChild(o); }
  } catch { /* the page still works without the list */ }
}
async function program(specText) {
  const st = $("wo_status"); st.className = "";
  if (state.logger) return programThroughLogger(specText);
  if (!state.pm) { st.className = "err"; st.textContent = "connect to the PM5 first"; return; }
  try {
    let frame, desc = null;
    if (specText === null) { frame = C.terminateFrame(); st.textContent = "clearing…"; }
    else { const spec = C.parseSpec(specText, state.named); frame = C.build(spec); desc = C.describe(spec); st.textContent = "sending to the PM5…"; }
    const [status] = await state.pm.send(frame);
    if (status & 0x30) throw new Error(`the PM5 did not accept it (${C.describeStatus(status)}); is it on the main menu?`);
    rec.setWorkout(desc);
    H.device({ ...state.pm.info, workout: desc });
    st.className = "ok"; st.textContent = desc ? `PM5 set: ${desc}. Row when ready.` : "cleared";
  } catch (e) { st.className = "err"; st.textContent = e.message; }
}
$("wo_named").addEventListener("change", e => { $("wo_spec").value = e.target.value; });
$("wo_send").addEventListener("click", () => { const spec = $("wo_spec").value.trim(); if (!spec) { $("wo_status").textContent = "choose a workout or type one"; return; } program(spec); });
$("wo_spec").addEventListener("keydown", e => { if (e.key === "Enter") $("wo_send").click(); });
$("wo_clear").addEventListener("click", () => program(null));

// ---------- replay: the built-in sample, or a raw log you saved ----------
async function playRaw(text, label, speed = 2) {
  if (state.pm || state.sample || state.logger) return;
  $("sample").disabled = true;
  try {
    const { meta, events } = readRaw(text), session = new Session(emit);   // a replay is shown, never recorded
    state.sample = true;
    H.reset({ replay: `${label} (at ${speed}x)` }); if (meta.device) H.device(meta.device); render();
    $("intro").hidden = true; setConn(`replaying ${label}`);
    let prev = events.length ? events[0][0] : 0;
    for (const [t, short, b] of events) {
      if (!state.sample) return;
      await sleep(Math.max(0, (t - prev) / speed * 1000)); prev = t;
      session.feed(t, short, b);
    }
    showFitness([[label, session.result({ started: "replay", ...meta })]]);
    setConn(`${label} finished (a replay is not saved)`); $("banner").textContent = "a replay is not saved";
  } catch (e) { setConn(`could not replay: ${e.message}`, "err"); }
  finally { state.sample = false; $("sample").disabled = false; }
}
const playSample = async () => playRaw(await (await fetch("examples/sample_row.jsonl")).text(), "the sample row (synthetic)");
$("replayfile").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  playRaw(await f.text(), f.name); e.target.value = "";
});
window.pm5Replay = playRaw;    // for recording the README animation from a saved row
// ?replay=<file in this folder>[&speed=N] plays a raw log straight away, which is how the
// README animation is recorded (headless Chrome, one frame per step of virtual time)
(async () => {
  const q = new URLSearchParams(location.search), f = q.get("replay");
  if (f && /^[\w.-]+$/.test(f)) playRaw(await (await fetch(f)).text(), q.get("label") || f, Number(q.get("speed")) || 1);
})();

// ---------- fitness settings and report ----------
const FIT = { fit_mass: "PM5_MASS_KG", fit_hrmax: "PM5_HRMAX", fit_rest: "PM5_HR_REST", fit_zone: "PM5_ZONE_HR" };
function fitnessEnv() { try { return JSON.parse(localStorage.getItem("pm5_fitness")) || {}; } catch { return {}; } }
function fitnessCfg() { try { return V.settings(fitnessEnv()); } catch (e) { $("fit_out").textContent = e.message; return null; } }
function showFitness(sessions) {
  const cfg = fitnessCfg();
  if (!cfg) { if (!$("fit_out").textContent) $("fit_out").textContent = "Enter your mass and maximum heart rate above, then Save, to get watts at your chosen heart rate and a VO2max estimate after each row."; return; }
  $("fit_out").textContent = V.report(sessions, cfg);
}
(function initFitness() {
  const env = fitnessEnv();
  for (const [id, key] of Object.entries(FIT)) $(id).value = env[key] ?? "";
  $("fit_save").addEventListener("click", () => {
    const env = {};
    for (const [id, key] of Object.entries(FIT)) if ($(id).value !== "") env[key] = $(id).value;
    localStorage.setItem("pm5_fitness", JSON.stringify(env));
    $("mass").value = env.PM5_MASS_KG ?? ""; render();
    $("fit_out").textContent = "";
    const cfg = fitnessCfg();
    $("fit_out").textContent = cfg ? `saved: ${cfg.mass_kg} kg, HRmax ${cfg.hrmax}, resting ${cfg.hr_rest}, watts reported at ${cfg.zone_hr} bpm${cfg.notes.length ? "\n" + cfg.notes.map(n => "note: " + n).join("\n") : ""}` : "mass and maximum heart rate are both needed";
  });
  $("fit_progress").addEventListener("click", async () => {
    let all;
    try { all = await DB.listSessions(); } catch { $("fit_out").textContent = "this browser refused storage (private window?)"; return; }
    const env = fitnessEnv(), num = k => { const v = parseFloat(env[k]); return v > 0 ? v : null; };
    $("fit_out").textContent = P.progressReport(P.progress(all, { ceiling: num("PM5_ZONE_HR"), hr_rest: num("PM5_HR_REST") }));
  });
  $("fit_all").addEventListener("click", async () => {
    const all = (await DB.listSessions()).sort((a, b) => a.started.localeCompare(b.started));
    if (!all.length) { $("fit_out").textContent = "no saved rows yet"; return; }
    $("fit_out").textContent = "";
    showFitness(all.map(s => [s.started, s]));
  });
  showFitness([]);
})();

// ---------- saved rows ----------
async function refreshSessions() {
  let all;
  try { all = (await DB.listSessions()).sort((a, b) => b.started.localeCompare(a.started)); } catch { $("sessions_list").textContent = "this browser refused storage (private window?)"; return; }
  if (!all.length) { $("sessions_list").textContent = "none yet"; return; }
  // built from elements, not HTML text: a row's name came from a file and is only ever text here
  const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; };
  const table = el("table"), head = table.appendChild(el("thead")).appendChild(el("tr")), body = table.appendChild(el("tbody"));
  for (const h of ["Started", "Distance", "Time", "Strokes", ""]) head.appendChild(el("th", h));
  for (const s of all) {
    const sm = s.summary || {}, last = s.strokes[s.strokes.length - 1] || {};
    const dist = sm.distance_m ?? last.distance_m, time = sm.elapsed_s ?? last.elapsed_s;
    const tr = body.appendChild(el("tr"));
    for (const v of [s.started, dist != null ? Math.round(dist) + " m" : "—", time != null ? fmt(time) : "—", s.strokes.length]) tr.appendChild(el("td", v));
    const cell = tr.appendChild(el("td"));
    for (const [act, label] of [["view", "view"], ["json", "session JSON"], ["fit", "FIT"], ["raw", "raw log"], ["del", "delete"]]) {
      const b = cell.appendChild(el("button", label)); b.dataset.act = act; b.dataset.id = s.started;
    }
  }
  $("sessions_list").replaceChildren(table);
}
// Rows recorded elsewhere (a phone, or the Python logger) come in as the files they were saved
// as: a session JSON as it is, and a raw log under its row's name, rebuilt into a session when
// no session file came with it. Browsers add " (1)" to a repeated download; that is dropped.
async function importFiles(files) {
  const note = $("import_status"), done = [], failed = [];
  const order = [...files].sort((a, b) => /\.jsonl$/i.test(a.name) - /\.jsonl$/i.test(b.name));   // sessions before raw logs
  for (const f of order) {
    try {
      const text = await f.text();
      if (/\.jsonl$/i.test(f.name)) {
        const lines = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
        const name = f.name.replace(/\.jsonl$/i, "").replace(/\s*\(\d+\)$/, "");
        const started = DB.isRowId(name) ? name : lines.length && lines[0].t ? stamp(new Date(lines[0].t * 1000)) : null;
        if (!started) throw new Error("not a raw log");
        await DB.putRaw(started, lines);
        if (!(await DB.getSession(started))) {
          const data = rebuild(started, lines, { fatigue: withFatigue });
          if (!data) throw new Error("no strokes in it");
          await DB.putSession(data);
        }
        done.push(started);
      } else {
        const s = JSON.parse(text);
        if (!s || !Array.isArray(s.strokes)) throw new Error("not a session file");
        if (!DB.isRowId(s.started)) throw new Error("its \"started\" is not a row's start time");
        await DB.putSession(s);
        done.push(s.started);
      }
    } catch (e) { failed.push(`${f.name} (${e.message})`); }
  }
  const rows = [...new Set(done)];
  note.textContent = [rows.length ? `added ${rows.length === 1 ? "the row" : rows.length + " rows"} ${rows.join(", ")}` : "",
    failed.length ? `could not read ${failed.join(", ")}` : ""].filter(Boolean).join("; ");
  refreshSessions();
}
$("importfiles").addEventListener("change", e => { const f = e.target.files; if (f && f.length) importFiles(f); e.target.value = ""; });
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
$("sessions_list").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  if (act === "view") {
    const s = await DB.getSession(id);
    if (rec.session || state.sample) { $("banner").textContent = "stop the current row first"; return; }
    const sm = s.summary || {}, last = s.strokes[s.strokes.length - 1] || {};   // the status the PM5 left is the reset screen, so show the piece's totals
    const status = { elapsed_s: sm.elapsed_s ?? last.elapsed_s, distance_m: sm.distance_m ?? last.distance_m, avg_pace_s: sm.avg_pace_s, pace_s: last.pace_s,
      stroke_rate: sm.avg_stroke_rate ?? last.spm, hr: last.hr, drag_factor: sm.drag_factor_avg, calories_total: sm.calories_total, avg_power_w: sm.avg_watts, workout_type: sm.workout_type };
    H.snapshot({ status, summary: sm, strokes: s.strokes, splits: s.splits || [] }); $("banner").textContent = `showing ${id}`; render();
    showFitness([[id, s]]);
  } else if (act === "json") {
    DB.download(`${id}.json`, JSON.stringify(await DB.getSession(id), null, 1));
  } else if (act === "fit") {
    const s = await DB.getSession(id);
    DB.download(Fit.fileName(s), Fit.encode(s), "application/vnd.ant.fit");
  } else if (act === "raw") {
    const r = await DB.getRaw(id);
    DB.download(`${id}.jsonl`, (r ? r.lines : []).map(l => JSON.stringify(l)).join("\n") + "\n", "application/x-ndjson");
  } else if (act === "del") {
    if (confirm(`Delete the row ${id} from this browser? Download it first if you want to keep it.`)) { await DB.deleteSession(id); refreshSessions(); }
  }
});

// ---------- guided sessions ----------
// ---------- keep the screen on while connected or in a guided session ----------
const WAKE_TEXT = { on: "screen kept awake", paused: "", off: "", refused: "the browser won't keep the screen awake" };
Wake.onStatus(st => { $("wake").textContent = WAKE_TEXT[st] ?? ""; });
let guidedRunning = false;
const loggerLive = () => !!(state.logger && state.logger.open && !state.logger.replay);
function updateWake() { Wake.keepAwake(!!(state.pm && state.pm.connected) || loggerLive() || guidedRunning); }

const guided = new GuidedUI({ $, H, S, render, metrics, DB, isConnected: () => !!(state.pm && state.pm.connected) || loggerLive(),
  onRunning: running => {
    guidedRunning = running; updateWake();
    // on a phone the session's instructions sit below the numbers: bring them on screen
    if (running && matchMedia("(max-width: 640px)").matches) requestAnimationFrame(() => $("g_live").scrollIntoView({ block: "start", behavior: "smooth" }));
  },
  onResult: async result => {   // the report goes into the row's session file
    if (state.logger) {
      try { await Logger.saveGuided(result); }
      catch (e) { $("g_out").textContent += `\n\nThe logger did not keep this report (${e.message}); copy it from here.`; }
      return;
    }
    if (recording()) { rec.meta.guided = result; return; }
    if (!state.lastSaved) return;
    try { const s = await DB.getSession(state.lastSaved); if (s) { s.guided = result; await DB.putSession(s); } } catch { /* the report is still on the page */ }
  } });

// ---------- served by the Python logger: it records, the page shows ----------
// The logger holds the Bluetooth connection and writes the files, so the page hides what it
// would otherwise do itself (connect, replay, keep rows) and feeds the logger's events to emit.
// A guided session's report goes to the logger for the session file, and the readiness check
// reads earlier ones from the logger's saved rows. A replay has no row to keep one in.
function useLogger(info) {
  state.logger = { ...info, open: false };
  const hide = ["intro", "connect", "stop", "sample", "sessions", "fit_all", "fit_progress", ...(info.replay ? ["guided"] : [])];
  for (const id of hide) $(id).style.display = "none";
  $("replayfile").parentElement.style.display = "none";
  for (const id of ["guided", "sessions"]) { const cb = hide.includes(id) && document.querySelector(`#ui_parts [data-part="${id}"]`); if (cb) (cb.closest("label") || cb).remove(); }
  guided.DB = { listSessions: Logger.guidedSessions };
  $("wo_send").disabled = $("wo_clear").disabled = !!info.replay;
  Logger.workouts().then(list => {
    for (const w of list) { const o = document.createElement("option"); o.value = w.name; o.textContent = `${w.name} · ${w.description}`; $("wo_named").appendChild(o); }
  }).catch(() => { /* the page still works without the list */ });
  Logger.follow((kind, data) => {
    emit(kind, data);
    if (kind === "new_piece") $("banner").textContent = "a new piece started on the PM5: the logger is saving this one; run it again for the next piece";
    if (kind === "ended") {
      $("banner").textContent = info.replay ? `replay of ${data.session} finished (a replay is not saved)` : `session ${data.session} saved by the logger`;
      showFitness([[data.session, { strokes: [...S.strokes.values()].sort((a, b) => a.stroke_count - b.stroke_count), summary: S.summary, splits: [...S.splits.values()] }]]);
    }
  }, open => {
    state.logger.open = open;
    updateWake();
    if (open) setConn(info.replay ? `replaying ${info.replay} from the logger` : "live: following the logger. Row when ready; end the piece on the PM5 (Menu)", "live");
    else setConn("not connected: is the logger still running?", "err");
  });
}
async function programThroughLogger(specText) {
  const st = $("wo_status");
  st.textContent = specText === null ? "clearing…" : "sending to the PM5…";
  try {
    const desc = await Logger.program(specText === null ? { terminate: true } : { spec: specText });
    st.className = "ok"; st.textContent = desc ? `PM5 set: ${desc}. Row when ready.` : "cleared";
  } catch (e) { st.className = "err"; st.textContent = e instanceof TypeError ? "the logger is not reachable" : e.message; }
}

// ---------- wiring ----------
$("connect").addEventListener("click", connect);
$("stop").addEventListener("click", stop);
$("sample").addEventListener("click", playSample);
window.addEventListener("beforeunload", e => { if (recording() || state.unsaved.size) { e.preventDefault(); e.returnValue = ""; } });
if (!BLE.supported()) { $("nobt").hidden = false; $("connect").disabled = true; setConn("no Web Bluetooth in this browser; use Chrome or Edge", "err"); }
const loggerInfo = Logger.detect();
if (loggerInfo) useLogger(loggerInfo); else { loadWorkouts(); refreshSessions(); recoverUnfinished(); }
render();
