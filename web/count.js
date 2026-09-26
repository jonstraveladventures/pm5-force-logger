// Anonymous usage counts with GoatCounter (no cookies, no personal data, nothing about a row):
// page visits, connections to a PM5 and rows saved. Off until SITE is set, and never on this
// machine or under the Python logger, only on the published page. While it is on, the page's
// privacy line says so.
export const SITE = "pm5-force-logger";   // the GoatCounter site name: counts go to https://<SITE>.goatcounter.com

const on = () => !!SITE && location.protocol === "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const waiting = [];

export function start() {
  if (!on()) return;
  const s = document.createElement("script");
  s.async = true; s.src = "https://gc.zgo.at/count.js"; s.dataset.goatcounter = `https://${SITE}.goatcounter.com/count`;
  s.addEventListener("load", () => { while (waiting.length) event(waiting.shift()); });
  document.head.appendChild(s);
  for (const el of document.querySelectorAll("[data-privacy]")) el.textContent = "Visits are counted anonymously, with no cookies.";
}

/** Count something that happened ("connected", "row-saved"): a name, never any data. */
export function event(name) {
  if (!on()) return;
  if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true });
  else waiting.push(name);
}
