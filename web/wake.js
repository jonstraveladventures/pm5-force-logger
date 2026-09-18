// Keeps the screen on while you row, with the Screen Wake Lock API (Chrome, Edge, and most
// Android browsers). On a Mac this also stops the lock screen, which only follows the display
// going to sleep. The browser drops the lock whenever the page is hidden (another tab, a
// minimised window), so it is taken again each time the page comes back into view. The OS can
// still refuse it, for instance on a laptop in low-power mode, and a closed lid or a managed
// Mac's forced lock still wins.
let lock = null, wanted = false, report = () => {};

export const supported = () => typeof navigator !== "undefined" && "wakeLock" in navigator;

async function take() {
  if (!wanted || lock || !supported() || document.visibilityState !== "visible") return;
  try {
    lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => { lock = null; report(wanted ? "paused" : "off"); });
    report("on");
  } catch (e) {
    lock = null; report("refused", e);
  }
}

/** Ask for the screen to stay on (true) or let it sleep again (false). */
export function keepAwake(on) {
  wanted = on;
  if (on) take();
  else { const l = lock; lock = null; if (l) l.release().catch(() => {}); report("off"); }
}

/** fn(state, error): state is "on", "off", "paused" (page hidden) or "refused". */
export function onStatus(fn) { report = fn; }

if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") take(); });
