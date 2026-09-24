// Recording and saving, one piece at a time, apart from the page so that it can be tested with a
// stand-in store (tests/recorder.test.js). Three rules keep a row safe:
//  - finishing a piece takes its session, metadata and raw log into its own hands before anything
//    is awaited, so the next piece can start at once without either being misfiled;
//  - a save reports what it wrote, and hands back the row, so a failed write can still be
//    downloaded from memory;
//  - while a row is going its raw log is written every `checkpointS` seconds under the row's
//    name. A raw log with no session beside it is a row that never finished (a tab closed or
//    killed mid-row), and rebuild() turns it back into a session.
import { Session, bytesToHex, readLines } from "./decode.js";

export const CHECKPOINT_S = 60;

export class Recorder {
  /** store: {putSession(data), putRaw(started, lines)} returning promises.
   *  stamp(): the name of a piece starting now. onStart(meta): a piece has begun.
   *  fatigue(data): adds anything computed from the finished row before it is saved. */
  constructor({ store, stamp, emit = () => {}, onStart = () => {}, fatigue = d => d, checkpointS = CHECKPOINT_S }) {
    Object.assign(this, { store, stamp, emit, onStart, fatigue, checkpointS });
    this.session = null; this.raw = []; this.meta = {};
    this.device = undefined; this.workout = undefined;   // carried into each piece
    this.lastCheckpoint = null;
  }

  start() {
    this.session = new Session(this.emit);
    this.raw = [];
    this.meta = { started: this.stamp(), device: this.device, workout: this.workout };
    this.lastCheckpoint = null;
    this.onStart(this.meta);
  }

  /** One notification from the PM5. Returns {finishing} (the old piece's save) when this packet
   *  showed that a new piece had started; the new piece is already recording it. */
  packet(t, short, b) {
    const line = { t: Math.round(t * 1000) / 1000, uuid: short.toString(16).padStart(4, "0"), hex: bytesToHex(b) };
    if (!this.session) {            // between pieces: nothing is kept until the next stroke
      if (short !== 0x0035) return {};
      this.start();
    }
    this.session.feed(t, short, b);
    if (this.session.newPieceAt !== null) {
      const finishing = this.finish();
      this.start();
      this.raw.push(line);
      this.session.feed(t, short, b);
      return { finishing };
    }
    this.raw.push(line);
    if (this.session.strokes.size && (this.lastCheckpoint === null || t - this.lastCheckpoint >= this.checkpointS)) {
      this.lastCheckpoint = t;
      this.store.putRaw(this.meta.started, this.lines()).catch(() => { /* the next checkpoint or the save will try again */ });
    }
    return {};
  }

  /** The programmed piece changed: kept for this piece and the ones after it. */
  setWorkout(desc, t = Date.now() / 1000) {
    this.workout = desc || undefined;
    if (this.session) { this.meta.workout = this.workout; this.raw.push({ t: Math.round(t), workout: desc }); }
  }

  lines(meta = this.meta, raw = this.raw) {
    return [{ t: raw.length ? raw[0].t : Math.round(Date.now() / 1000), device: meta.device || null, workout: meta.workout || null }, ...raw];
  }

  /** Save the current piece, if it has strokes. Resolves to null (nothing to save) or
   *  {id, data, lines, saved: "all" | "session" | "none", error}: the row itself comes back, so
   *  whatever was not written can still be downloaded. */
  async finish() {
    const session = this.session, meta = this.meta, raw = this.raw;   // this piece's, whatever starts next
    this.session = null;
    if (!session || !session.strokes.size) return null;
    const id = meta.started, data = this.fatigue(session.result(meta)), lines = this.lines(meta, raw);
    const out = { id, data, lines, saved: "none", error: null };
    try {
      await this.store.putSession(data); out.saved = "session";
      await this.store.putRaw(id, lines); out.saved = "all";
    } catch (e) { out.error = e; }
    return out;
  }
}

/** A session rebuilt from a raw log's lines: an imported log, or the checkpoint of a row that never
 *  finished (then marked `recovered`, since the last minute or so may be missing). */
export function rebuild(started, lines, { recovered = false, fatigue = d => d } = {}) {
  const { meta, events } = readLines(lines), s = new Session(() => {});
  for (const [t, short, b] of events) s.feed(t, short, b);
  if (!s.strokes.size) return null;
  const data = fatigue(s.result({ started, ...meta }));
  if (recovered) data.recovered = true;
  return data;
}
