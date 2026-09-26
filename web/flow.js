// The app as a few screens instead of one long page: About you (first visit, then Settings),
// Today's row, Rowing, Finished and History. It drives the same page code (app.js), which works
// by element id wherever an element sits; this only shows one screen at a time, moves the odd
// shared piece to the screen that needs it, and follows a row from start to finish. Each screen
// is a history entry, so a phone's back button steps between them.
import { render, partIds, setHiddenParts } from "./dashboard.js";
import * as DB from "./store.js";
import * as P from "./progress.js";

const $ = id => document.getElementById(id);
const SCREENS = ["about", "today", "row", "done", "history"];
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };

// ---------- what to show while rowing: asked once, changeable any time ----------
const MINIMAL_TILES = ["tile_time", "tile_dist", "tile_pace", "tile_rate", "tile_hr", "tile_peak"];
const PRESETS = {
  minimal: ids => ids.filter(id => (id.startsWith("tile_") ? !MINIMAL_TILES.includes(id) : /^(panel_shape|trend\d+|tablewrap)$/.test(id))),
  standard: ids => ids.filter(id => id === "tablewrap"),
  everything: () => [],
};
function applyPreset(name) { setHiddenParts(PRESETS[name](partIds())); keep("pm5_flow_display", name); }

// ---------- screens ----------
function show(name) {
  if (!SCREENS.includes(name)) name = load("pm5_flow_seen", false) ? "today" : "about";
  for (const s of SCREENS) $("screen_" + s).hidden = s !== name;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("here", a.getAttribute("href") === "#" + name));
  $("display").hidden = name !== "row";
  if (name === "history") $("history_fit").appendChild($("fit_out"));
  if (name === "done") {
    $("done_fit").prepend($("fit_out"));
    $("done_guided_card").hidden = !$("g_out").textContent.trim() && $("g_feel").hidden;
  }
  if (name === "about") {
    const cur = load("pm5_flow_display", matchMedia("(max-width: 640px)").matches ? "minimal" : "standard");
    for (const r of document.querySelectorAll('input[name="flow_display"]')) r.checked = r.value === cur;
  }
  window.scrollTo(0, 0);
  if (name === "row") render();   // the charts measure themselves, which they cannot do while hidden
}
const go = name => { if (location.hash.slice(1) === name) show(name); else location.hash = name; };
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

// ---------- About you ----------
$("flow_about_done").addEventListener("click", () => {
  $("fit_save").click();   // the app's own save of the fitness settings
  const picked = document.querySelector('input[name="flow_display"]:checked');
  applyPreset(picked ? picked.value : "standard");
  keep("pm5_flow_seen", true);
  go("today");
});

// ---------- Today's row ----------
const kind = () => (document.querySelector('input[name="flow_kind"]:checked') || {}).value;
for (const r of document.querySelectorAll('input[name="flow_kind"]')) r.addEventListener("change", () => {
  $("flow_piece").hidden = kind() !== "piece"; $("flow_guided").hidden = kind() !== "guided"; $("flow_msg").textContent = "";
});
const live = () => !$("stop").hidden || $("conn").classList.contains("live");
$("flow_start").addEventListener("click", () => {
  const msg = $("flow_msg"); msg.textContent = "";
  if (kind() === "guided") {
    $("g_start").click();   // the guided session starts itself, or says why not
    if (!$("g_live").hidden) go("row"); else msg.textContent = $("g_out").textContent || "The session didn't start.";
    return;
  }
  if (!live()) { msg.textContent = "Connect to the PM5 first, or try it with a sample row."; return; }
  if (kind() === "piece" && $("wo_spec").value.trim() && $("wo_status").className !== "ok") $("wo_send").click();
  go("row");
});
$("sample").addEventListener("click", () => go("row"));          // the app starts the replay itself
$("replayfile").addEventListener("change", () => go("row"));
if ($("g_sim")) $("g_sim").addEventListener("click", () => go("row"));

// ---------- Finished ----------
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const pace = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

window.addEventListener("pm5:finished", async ({ detail: { id, data, saved, replay } }) => {
  const strokes = data.strokes || [], sm = data.summary || {}, last = strokes[strokes.length - 1] || {};
  const dist = sm.distance_m ?? last.distance_m, time = sm.elapsed_s ?? last.elapsed_s;
  const w = mean(strokes.map(s => s.power_w).filter(Boolean)), hr = mean(strokes.map(s => s.hr).filter(Boolean));
  const items = [["Distance", dist != null ? `${Math.round(dist)} m` : "—"], ["Time", time != null ? fmt(time) : "—"],
    ["Pace /500m", sm.avg_pace_s ? pace(sm.avg_pace_s) : dist && time ? pace(time / dist * 500) : "—"],   // the monitor's own average when it gives one ["Strokes", strokes.length],
    ["Power", w != null ? `${Math.round(w)} W` : "—"], ["Heart rate", hr != null ? `${Math.round(hr)} bpm` : "—"]];
  $("summary").replaceChildren(...items.map(([k, v]) => { const d = document.createElement("div"), a = document.createElement("span"), b = document.createElement("b"); a.textContent = k; b.textContent = v; d.append(a, b); return d; }));
  $("done_title").textContent = replay ? "Replay finished" : "Row finished";
  $("done_note").textContent = replay ? "A replay is not saved." : saved === "all" || saved === undefined ? `Saved as ${id}.` : "Not saved in full: the box at the top has the files to download.";
  const files = $("done_files"); files.replaceChildren();
  if (id && saved !== "none" && saved !== undefined) for (const [act, label] of [["json", "Session JSON"], ["fit", "FIT file"], ["raw", "Raw log"]]) {
    const b = document.createElement("button"); b.textContent = label;
    b.addEventListener("click", () => { const src = document.querySelector(`#sessions_list button[data-act="${act}"][data-id="${CSS.escape(id)}"]`); if (src) src.click(); });
    files.appendChild(b);
  }
  $("done_progress_card").hidden = true;
  if (id && saved !== undefined) {
    try {
      const env = load("pm5_fitness", {}), num = k => { const v = parseFloat(env[k]); return v > 0 ? v : null; };
      const p = P.progress(await DB.listSessions(), { ceiling: num("PM5_ZONE_HR"), hr_rest: num("PM5_HR_REST") });
      const piece = P.pieceOf(data), g = piece && p.groups.find(x => x.name === piece.name);
      if (g) { $("done_progress").textContent = P.progressReport({ groups: [g], skipped: 0, ceiling: p.ceiling }); $("done_progress_card").hidden = false; }
    } catch { /* no storage */ }
  }
  go("done");
});

// ---------- start ----------
if (!load("pm5_flow_display", null) && load("pm5_flow_seen", false)) applyPreset("standard");
show(location.hash.slice(1));
