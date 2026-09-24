// The spoken cues as short sentences, each recorded whole in advance (web/voice/, made by
// tools/make_voice.py with the Kokoro model) and played back to back: joins fall only at full
// stops, where a pause is natural. A sentence with no recording is spoken by the browser's own
// voice instead. The sentence families here are the single source for both the cues a session
// speaks and the list the generator records, so the two cannot drift apart.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A whole number from 0 to 999 in words, British style: "one hundred and forty". */
export function words(n) {
  n = Math.round(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? " and " + words(n % 100) : ""}`;
}
const cap = s => s[0].toUpperCase() + s.slice(1);

/** A pace the way rowers say it: 2:12 "two twelve", 2:08 "two oh eight", 2:00 "two flat". */
export function paceWords(s) {
  s = Math.round(s);
  const m = Math.floor(s / 60), sec = s % 60;
  return `${words(m)} ${sec === 0 ? "flat" : sec < 10 ? "oh " + words(sec) : words(sec)}`;
}

/** A length of time as the cues say it: "one minute", "three and a half minutes", "three minutes forty seconds". */
export function durationWords(s) {
  s = Math.round(s);
  const m = Math.floor(s / 60), sec = s % 60;
  if (!sec) return m === 1 ? "one minute" : `${words(m)} minutes`;
  if (sec === 30 && m) return `${words(m)} and a half minutes`;
  if (!m) return `${words(sec)} seconds`;
  return `${words(m)} minute${m > 1 ? "s" : ""} ${words(sec)} seconds`;
}

const ratioWords = t => (Number.isInteger(t) ? words(t) : t % 1 === 0.5 ? `${words(Math.floor(t))} and a half` : null);

/** The sentence families. Each returns one sentence, or null when it has no spoken form. */
export const say = {
  rate: r => `${cap(words(r))} strokes a minute.`,
  pace: p => `Pace ${paceWords(p)}.`,
  ease: p => `Ease off to ${paceWords(p)}.`,
  holding: p => `Holding pace ${paceWords(p)}.`,
  watts: w => `${cap(words(w))} watts.`,
  duration: s => `For ${durationWords(s)}.`,
  hr: n => `Heart rate ${words(n)}.`,
  under: n => `Now I'll steer the pace to keep your heart rate under ${words(n)}.`,
  stage: (i, n) => `Stage ${words(i)} of ${words(n)}.`,
  setDamper: d => `Set the damper to ${words(d)}.`,
  damper: d => `Damper ${words(d)}.`,
  count: n => `${cap(words(n))} of ten.`,
  peak: t => `Peak force by ${words(t)} per cent of the drive.`,
  ratio: t => (ratioWords(t) ? `Recovery at least ${ratioWords(t)} times as long as the drive.` : null),
};

/** Sentences that never change. */
export const FIXED = {
  warmup: "Warm up.", easy: "Easy.", readiness: "Readiness check.", anyRate: "Any rate.",
  recovery: "Stop rowing and sit still for one minute, for your recovery heart rate.", recoveryNext: "Recovery heart rate.",
  capped: "The capped row.", downAgain: "Then back down the same steps.",
  drill: "Drill.", legs: "Push with the legs early.", slide: "Slow the slide.", shape: "Make every stroke the same shape.",
  easyRowing: "Easy rowing.", relax: "Relax.", tenSeconds: "In ten seconds.",
  complete: "Session complete.", endPiece: "End the piece on the monitor when you're ready.",
  hrLost: "Heart rate lost.", ready: "Start rowing when you're ready.", stopped: "Session stopped.",
  rateTest: "Stroke rate test.", dragSweep: "Drag sweep.", hrcap: "Heart-rate-capped row.", drift: "Drift test.",
  step: "Step test.", readinessTest: "Readiness check.", drills: "Technique drill.",
};

/** The file a sentence's recording is kept in, without the folder or extension. */
export const clipId = sentence => sentence.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// What the recordings cover. A session outside these (a pace of 3:40, 173 watts) still speaks,
// in the browser's voice, for that sentence only.
export const RANGES = {
  rate: [10, 40, 1], pace: [80, 210, 1], watts: [40, 400, 5], duration: [5, 3600, 5], hr: [60, 220, 1], under: [100, 200, 1],
  stageOf: [2, 12, 1], damper: [1, 10, 1], count: [0, 10, 1], peak: [20, 70, 1], ratio: [1, 4, 0.5],
};
const span = ([a, b, step]) => { const out = []; for (let v = a; v <= b + 1e-9; v += step) out.push(Math.round(v * 10) / 10); return out; };

/** Every sentence the recordings should hold. */
export function allSentences() {
  const R = RANGES, out = new Set(Object.values(FIXED));
  for (const r of span(R.rate)) out.add(say.rate(r));
  for (const p of span(R.pace)) { out.add(say.pace(p)); out.add(say.ease(p)); out.add(say.holding(p)); }
  for (const w of span(R.watts)) out.add(say.watts(w));
  for (const s of span(R.duration)) out.add(say.duration(s));
  for (const n of span(R.hr)) out.add(say.hr(n));
  for (const n of span(R.under)) out.add(say.under(n));
  for (const n of span(R.stageOf)) for (let i = 1; i <= n; i++) out.add(say.stage(i, n));
  for (const d of span(R.damper)) { out.add(say.setDamper(d)); out.add(say.damper(d)); }
  for (const n of span(R.count)) out.add(say.count(n));
  for (const t of span(R.peak)) out.add(say.peak(t));
  for (const t of span(R.ratio)) { const s = say.ratio(t); if (s) out.add(s); }
  return [...out];
}

// ---------------------------------------------------------------- playback (browser only)

export const GAP_S = 0.32;        // added between sentences; each recording already carries 0.12 s of its own
export const GAP_BEFORE_FOR_S = 0.03;   // "For three minutes." carries on from the sentence before it

/** Plays cues from the recordings, queued one after another like speech. `fallback(text)` speaks
 *  a cue some sentence of which has no recording, and may return a promise that ends with it. */
export class Player {
  constructor({ base = "voice/", fallback = () => {} } = {}) {
    Object.assign(this, { base, fallback });
    this.ids = null; this.buffers = new Map(); this.ctx = null; this.queue = Promise.resolve(); this.ready = Promise.resolve();
  }
  async manifest() {
    if (this.ids) return this.ids;
    try { const m = await (await fetch(this.base + "manifest.json")).json(); this.ids = new Set(m.ids); }
    catch { this.ids = new Set(); }
    return this.ids;
  }
  /** Call from a click (browsers only start audio from one): fetches and decodes the recordings
   *  of these sentences. Cues spoken before it finishes wait for it, up to a few seconds. */
  prepare(sentences) {
    const Ctx = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return (this.ready = Promise.resolve());
    this.ctx = this.ctx || new Ctx();
    this.ctx.resume();
    this.ready = (async () => {
      const ids = await this.manifest();
      const want = [...new Set(sentences.filter(Boolean).map(clipId))].filter(id => ids.has(id) && !this.buffers.has(id));
      await Promise.all(want.map(async id => {
        try { this.buffers.set(id, await this.ctx.decodeAudioData(await (await fetch(`${this.base}${id}.mp3`)).arrayBuffer())); }
        catch { /* that sentence falls back to the browser's voice */ }
      }));
    })();
    return this.ready;
  }
  /** Speak one cue: its sentences from the recordings when all are there, else `text` by fallback. */
  speak(sentences, text) {
    this.queue = this.queue.then(async () => {
      await Promise.race([this.ready, new Promise(r => setTimeout(r, 4000))]);
      const bufs = (sentences || []).map(s => this.buffers.get(clipId(s)));
      if (!this.ctx || !sentences || !sentences.length || bufs.some(b => !b)) { await this.fallback(text); return; }
      let t = this.ctx.currentTime + 0.05;
      bufs.forEach((b, i) => {
        if (i) t += sentences[i].startsWith("For ") ? GAP_BEFORE_FOR_S : GAP_S;
        const src = this.ctx.createBufferSource(); src.buffer = b; src.connect(this.ctx.destination); src.start(t);
        t += b.duration;
      });
      await new Promise(r => setTimeout(r, (t - this.ctx.currentTime) * 1000));
    });
    return this.queue;
  }
}
