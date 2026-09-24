// When the Python logger serves this page, the logger holds the PM5 and records the row; the page
// only shows it. The logger's Session emits the same (kind, data) events as the page's own, and
// sends them down /events, so they go through the same handlers here. The logger marks the page
// it serves with <meta name="pm5-logger">, which is how the page tells the two apart.

/** {replay: name or null} when the logger served this page, otherwise null. */
export function detect() {
  const m = document.querySelector('meta[name="pm5-logger"]');
  try { return m ? JSON.parse(m.content) : null; } catch { return null; }
}

/** Feed every event from the logger to emit(kind, data). onOpen(bool) reports the connection;
 * the browser reconnects by itself, and the logger answers a new connection with a snapshot. */
export function follow(emit, onOpen) {
  const es = new EventSource("/events");
  es.onopen = () => onOpen(true);
  es.onerror = () => onOpen(false);
  es.onmessage = e => { const m = JSON.parse(e.data); emit(m.kind, m.data); };
  return es;
}

/** Ask the logger to program the PM5 through its own connection: {spec} or {terminate: true}. */
export async function program(payload) {
  const r = await fetch("/program", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `the logger answered ${r.status}`);
  return j.workout;
}

/** Keep a guided session's report with the row the logger is recording. */
export async function saveGuided(report) {
  const r = await fetch("/guided", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guided: report }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `the logger answered ${r.status}`);
}

/** The saved rows' guided reports, [{started, guided}], shaped like store.js's listSessions. */
export async function guidedSessions() {
  const r = await fetch("/guided");
  return (await r.json()).sessions;
}

/** The named workouts as the logger knows them: [{name, description}]. */
export async function workouts() {
  const r = await fetch("/workouts");
  return (await r.json()).workouts;
}
