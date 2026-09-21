#!/usr/bin/env python3
"""Check the files web/fit.js writes against parsers written by other people.

The Node tests read the file back with a reader written from the FIT format's description, which
is still our own reading of it. This reads the same files with Garmin's own SDK and with
fitdecode, so a misunderstanding on our side shows up as a decode error rather than a clean pass.

    pip install garmin-fit-sdk fitdecode
    node web/tools/tofit.mjs web/tests/fixtures/sample_session.json /tmp/sample.fit
    python3 web/tests/verify_fit.py /tmp/sample.fit

It prints what the session, lap and first record came out as, so the numbers can be read against
the row they came from. Every developer field should come back named, not as a bare number.
"""
import sys

from garmin_fit_sdk import Decoder, Stream
import fitdecode


def main(paths):
    ok = True
    for path in paths:
        print(f"=== {path}")
        decoder = Decoder(Stream.from_file(path))
        if not decoder.is_fit():
            print("  not a FIT file"); ok = False; continue
        if not Decoder(Stream.from_file(path)).check_integrity():
            print("  failed the SDK's integrity check"); ok = False; continue
        messages, errors = Decoder(Stream.from_file(path)).read(apply_scale_and_offset=True)
        if errors:
            print(f"  SDK errors: {errors}"); ok = False
        print("  messages:", {k: len(v) for k, v in messages.items()})
        for key in ("session_mesgs", "lap_mesgs", "record_mesgs"):
            if messages.get(key):
                print(f"  first {key}:", {k: v for k, v in messages[key][0].items()})

        named = {}
        with fitdecode.FitReader(path) as reader:
            for frame in reader:
                if frame.frame_type == fitdecode.FIT_FRAME_DATA and frame.name == "record":
                    named = {f.name: f.value for f in frame.fields}
                    break
        rowing = [n for n in named if n[0].isupper()]
        print("  rowing fields fitdecode names:", rowing)
        if not rowing:
            print("  no developer fields came back named"); ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["sample.fit"]))
