"""Record the guided sessions' spoken sentences with the Kokoro text-to-speech model.

    python web/tools/make_voice.py [--voice af_heart] [--limit N]

Needs `pip install kokoro soundfile`, plus ffmpeg and espeak-ng (brew install ffmpeg espeak-ng),
and Node for the sentence list, which comes from web/voice.js so the page and the recordings
agree. Each sentence is spoken whole, trimmed to 0.02 s before its first word and 0.1 s after its
last, and saved as web/voice/<id>.mp3 (mono, 48 kbps). Sentences already recorded are skipped,
and web/voice/manifest.json lists what exists, so an interrupted run can simply be started again.
Kokoro (hexgrad/Kokoro-82M) is released under the Apache 2.0 licence.
"""
import argparse, io, json, re, subprocess, sys, time, warnings
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
OUT = WEB / "voice"
SR = 24000


def sentences():
    return json.loads(subprocess.run(["node", str(WEB / "tools" / "voice-sentences.mjs")], capture_output=True, text=True, check=True).stdout)


def write_manifest(voice):
    ids = sorted(p.stem for p in OUT.glob("*.mp3"))
    (OUT / "manifest.json").write_text(json.dumps({"model": "hexgrad/Kokoro-82M", "voice": voice, "ids": ids}, indent=0) + "\n")
    return len(ids)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--limit", type=int, help="record at most this many (to try it out)")
    args = ap.parse_args()
    warnings.filterwarnings("ignore")
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline
    pipe = KPipeline(lang_code=args.voice[0], repo_id="hexgrad/Kokoro-82M")
    OUT.mkdir(exist_ok=True)
    todo = [s for s in sentences() if not (OUT / f"{s['id']}.mp3").exists()][: args.limit]
    print(f"{len(todo)} to record", flush=True)
    t0 = time.time()
    for n, s in enumerate(todo, 1):
        audio, tokens = [], []
        for r in pipe(s["text"], voice=args.voice):
            audio.append(np.asarray(r.audio, dtype=np.float32))
            tokens += list(r.tokens or [])
        a = np.concatenate(audio)
        w = [t for t in tokens if re.search(r"\w", t.text) and t.start_ts is not None]
        if w:
            a = a[max(0, int((w[0].start_ts - 0.02) * SR)): int((w[-1].end_ts + 0.1) * SR)].copy()
        f = min(len(a) // 2, int(0.008 * SR))   # short fades so the clip starts and ends cleanly
        a[:f] *= np.linspace(0, 1, f); a[-f:] *= np.linspace(1, 0, f)
        wav = io.BytesIO(); sf.write(wav, a, SR, format="WAV")
        mp3 = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-b:a", "48k", "-f", "mp3", "pipe:1"],
                             input=wav.getvalue(), capture_output=True, check=True).stdout
        (OUT / f"{s['id']}.mp3").write_bytes(mp3)
        if n % 50 == 0 or n == len(todo):
            write_manifest(args.voice)
            print(f"{n}/{len(todo)}  {time.time() - t0:.0f} s", flush=True)
    print(f"done: {write_manifest(args.voice)} recordings", flush=True)


if __name__ == "__main__":
    sys.exit(main())
