// The page: connects to the PM5, feeds its notifications through the Session, drives the
// dashboard, programs workouts, saves finished rows in the browser and shows the fitness report.
import { Session, readRaw, bytesToHex, AFTER_END_S } from "./decode.js";
import * as C from "./csafe.js";
import * as V from "./vo2.js";
import * as BLE from "./ble.js";
import * as DB from "./store.js";
import { H, render, S, metrics } from "./dashboard.js";
import * as G from "./guided.js";
import { GuidedUI } from "./guided-ui.js";

const $ = id => document.getElementById(id);
const state = { pm: null, session: null, raw: [], meta: {}, endTimer: null, sample: false, named: {}, lastSaved: null };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function setConn(text, cls = "") { $("conn").textContent = text; $("conn").className = cls; }
const emit = (kind, data) => { (H[kind] || (() => {}))(data); if (!state.sample) guided.onEvent(kind, data); render(); };

// ---------- a session per piece ----------
function startSession() {
  state.session = new Session(emit);
  state.raw = [];
  state.meta = { started: stamp(), device: state.pm ? state.pm.info : undefined, workout: state.meta.workout };
  H.reset({});
  if (state.pm) H.device({ ...state.pm.info, workout: state.meta.workout });
  render();
}

function onPacket(t, short, b) {
  const line = { t: Math.round(t * 1000) / 1000, uuid: short.toString(16).padStart(4, "0"), hex: bytesToHex(b) };
  if (!state.session) {                 // between pieces: keep showing the last one until the next stroke arrives
    if (short !== 0x0035) return;
    startSession();
  }
  const s = state.session;
  s.feed(t, short, b);
  if (s.newPieceAt !== null) {          // the PM5 started a new piece: save this one and give the new one that stroke
    finish("a new piece started on the PM5").then(() => { startSession(); state.raw.push(line); state.session.feed(t, short, b); });
    return;
  }
  state.raw.push(line);
  if (s.endAt !== null && !state.endTimer) {
    setConn(`piece ended on the PM5; saving in ${AFTER_END_S} s (it re-sends its summary with the recovery heart rate)`, "live");
    state.endTimer = setTimeout(() => finish("the piece ended on the PM5"), AFTER_END_S * 1000);
  }
}

/** Save the current session (if it has strokes) and leave the dashboard showing it. */
async function finish(reason) {
  clearTimeout(state.endTimer); state.endTimer = null;
  const s = state.session;
  state.session = null;
  if (!s || !s.strokes.size || state.sample) return;
  const data = s.result(state.meta);
  // when peak position started drifting later, if it did: saved with every row
  data.fatigue = G.fatigueOnset(data.strokes.map(st => { const c = st.force_curve_v2 || st.force_curve, m = c ? metrics(c) : null; return { t: st.elapsed_s, a100: m ? m.a100 : null }; }));
  const head = { t: state.raw.length ? state.raw[0].t : Math.round(Date.now() / 1000), device: state.meta.device || null, workout: state.meta.workout || null };
  try {
    await DB.putSession(data);
    await DB.putRaw(state.meta.started, [head, ...state.raw]);
    state.lastSaved = state.meta.started;
    H.ended({ session: state.meta.started });
    if (data.fatigue && data.fatigue.onset_s != null) $("banner").textContent += ` · peak position drifted later from ${G.fmtClock(data.fatigue.onset_s)}`;
    setConn(`${reason}; saved ${data.strokes.length} strokes as ${state.meta.started}`, state.pm && state.pm.connected ? "live" : "");
  } catch (e) {
    setConn(`${reason}; saving failed (${e.message}). Download it now from the table below before leaving the page.`, "err");
    $("banner").textContent = "not saved";
  }
  showFitness([[state.meta.started, data]]);
  refreshSessions();
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
  state.meta.workout = undefined;
  startSession();
  setConn(`live: ${state.pm.info.name}${state.pm.info.firmware_rev ? ", firmware " + state.pm.info.firmware_rev : ""}. Row when ready; end the piece on the PM5 (Menu)`, "live");
}

async function onDisconnected() {
  if (state.session && state.session.strokes.size) await finish("the PM5 disconnected");
  else setConn("the PM5 disconnected");
  state.pm = null;
  $("connect").disabled = false; $("stop").hidden = true; $("wo_send").disabled = true; $("wo_clear").disabled = true;
}

async function stop() {
  if (state.session && state.session.strokes.size) await finish("stopped");
  if (state.pm) state.pm.disconnect();   // onDisconnected does the rest
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
  if (!state.pm) { st.className = "err"; st.textContent = "connect to the PM5 first"; return; }
  try {
    let frame, desc = null;
    if (specText === null) { frame = C.terminateFrame(); st.textContent = "clearing…"; }
    else { const spec = C.parseSpec(specText, state.named); frame = C.build(spec); desc = C.describe(spec); st.textContent = "sending to the PM5…"; }
    const [status] = await state.pm.send(frame);
    if (status & 0x30) throw new Error(`the PM5 did not accept it (${C.describeStatus(status)}); is it on the main menu?`);
    state.meta.workout = desc || undefined;
    state.raw.push({ t: Math.round(Date.now() / 1000), workout: desc });
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
  if (state.pm || state.sample) return;
  $("sample").disabled = true;
  let mine = null;
  try {
    const { meta, events } = readRaw(text);
    state.sample = true; state.session = new Session(emit); state.meta = { started: "replay", ...meta };
    mine = state.session;
    H.reset({ replay: `${label} (at ${speed}x)` }); if (meta.device) H.device(meta.device); render();
    $("intro").hidden = true; setConn(`replaying ${label}`);
    let prev = events.length ? events[0][0] : 0;
    for (const [t, short, b] of events) {
      if (!state.sample) return;
      await sleep(Math.max(0, (t - prev) / speed * 1000)); prev = t;
      state.session.feed(t, short, b);
    }
    showFitness([[label, state.session.result(state.meta)]]);
    setConn(`${label} finished (a replay is not saved)`); $("banner").textContent = "a replay is not saved";
  } catch (e) { setConn(`could not replay: ${e.message}`, "err"); }
  finally { state.sample = false; if (state.session === mine) state.session = null; $("sample").disabled = false; }   // a connect during a replay owns the session now
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
  const rows = all.map(s => {
    const sm = s.summary || {}, last = s.strokes[s.strokes.length - 1] || {};
    const dist = sm.distance_m ?? last.distance_m, time = sm.elapsed_s ?? last.elapsed_s;
    return `<tr><td>${s.started}</td><td>${dist != null ? Math.round(dist) + " m" : "—"}</td><td>${time != null ? fmt(time) : "—"}</td><td>${s.strokes.length}</td>
      <td><button data-act="view" data-id="${s.started}">view</button><button data-act="json" data-id="${s.started}">session JSON</button><button data-act="raw" data-id="${s.started}">raw log</button><button data-act="del" data-id="${s.started}">delete</button></td></tr>`;
  });
  $("sessions_list").innerHTML = `<table><thead><tr><th>Started</th><th>Distance</th><th>Time</th><th>Strokes</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
$("sessions_list").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  if (act === "view") {
    const s = await DB.getSession(id);
    if (state.session || state.sample) { $("banner").textContent = "stop the current row first"; return; }
    const sm = s.summary || {}, last = s.strokes[s.strokes.length - 1] || {};   // the status the PM5 left is the reset screen, so show the piece's totals
    const status = { elapsed_s: sm.elapsed_s ?? last.elapsed_s, distance_m: sm.distance_m ?? last.distance_m, avg_pace_s: sm.avg_pace_s, pace_s: last.pace_s,
      stroke_rate: sm.avg_stroke_rate ?? last.spm, hr: last.hr, drag_factor: sm.drag_factor_avg, calories_total: sm.calories_total, avg_power_w: sm.avg_watts, workout_type: sm.workout_type };
    H.snapshot({ status, summary: sm, strokes: s.strokes }); $("banner").textContent = `showing ${id}`; render();
    showFitness([[id, s]]);
  } else if (act === "json") {
    DB.download(`${id}.json`, JSON.stringify(await DB.getSession(id), null, 1));
  } else if (act === "raw") {
    const r = await DB.getRaw(id);
    DB.download(`${id}.jsonl`, (r ? r.lines : []).map(l => JSON.stringify(l)).join("\n") + "\n", "application/x-ndjson");
  } else if (act === "del") {
    if (confirm(`Delete the row ${id} from this browser? Download it first if you want to keep it.`)) { await DB.deleteSession(id); refreshSessions(); }
  }
});

// ---------- guided sessions ----------
const guided = new GuidedUI({ $, H, S, render, metrics, DB, isConnected: () => !!(state.pm && state.pm.connected),
  onResult: async result => {   // the report goes into the row's session file
    if (state.session && state.session.strokes.size) { state.meta.guided = result; return; }
    if (!state.lastSaved) return;
    try { const s = await DB.getSession(state.lastSaved); if (s) { s.guided = result; await DB.putSession(s); } } catch { /* the report is still on the page */ }
  } });

// ---------- wiring ----------
$("connect").addEventListener("click", connect);
$("stop").addEventListener("click", stop);
$("sample").addEventListener("click", playSample);
window.addEventListener("beforeunload", e => { if (state.session && state.session.strokes.size && !state.sample) { e.preventDefault(); e.returnValue = ""; } });
if (!BLE.supported()) { $("nobt").hidden = false; $("connect").disabled = true; setConn("no Web Bluetooth in this browser; use Chrome or Edge", "err"); }
loadWorkouts();
refreshSessions();
render();
