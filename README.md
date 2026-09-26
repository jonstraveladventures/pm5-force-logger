# pm5-force-logger

**Use it now, nothing to install: [jonstraveladventures.github.io/pm5-force-logger](https://jonstraveladventures.github.io/pm5-force-logger/)** in Chrome or Edge. Wake the PM5, press Connect, row.

Record every stroke from a Concept2 PM5 over Bluetooth, including its force curve, and watch the data live in your browser.

The Concept2 Logbook keeps the time, distance, pace, stroke rate and heart rate for each stroke, but not its force. ErgData shows the force curve while you row but, as far as I can tell, doesn't save it. The PM5 sends more than either keeps: drive length and time, recovery time, peak and average force, work per stroke, and the full force curve for every stroke. This project saves all of that data, shows it live and scores the shape of each force curve against published technique targets.

![The dashboard during a row](docs/dashboard-2026-09.gif)

*A minute of one of my own 5 km rows, played back through the browser version at about six times its speed.*

## What you get

**A live dashboard** at `http://localhost:8750`, with three things on it.

| | |
|---|---|
| Numbers | Time, distance, pace, stroke rate, power, heart rate, peak force, drive length and time, drive-to-recovery ratio, distance and work per stroke, drag factor, calories. |
| Force curve | Your latest stroke, your last eight, your session average and a reference shape, with the curve-shape measures against their targets. |
| History | Stroke-by-stroke trends and a table of recent strokes. |

**A dashboard you can rearrange.** The "Change the display" menu sets text size and the size of the curve, the tiles and the trend charts, and switches off any part you don't want. Tick "customise" in it and the page becomes movable: drag a tile, chart or section somewhere else, drag its corner to resize it, press the ✕ to hide it. Resizing a tile, a trend chart or the force-curve panel moves the matching slider, so the two never disagree. Your arrangement is remembered in the browser, and Reset puts it all back.

**Every stroke saved to disk**, as a raw log of every Bluetooth message and a session file with one record per stroke, including both force curves.

**A row you can take elsewhere.** Any saved row exports as a Garmin FIT activity, carrying the per-stroke rowing detail in the developer fields of the emerging [Rowing Data Standard](https://github.com/MoveLab-Studio/rowing-data-standard), so Garmin Connect, intervals.icu, Strava or Rowsandall will take it.

**Optional extras.** The page can set up the workout on the PM5, and run a guided session (see below). Given your mass and maximum heart rate, each row reports the watts you hold at a set heart rate and an estimate of VO2max. Each row can also go to your Concept2 Logbook, which matters because ErgData cannot connect while this script holds the PM5's Bluetooth connection, so nothing else would send it.

## Use it in the browser, nothing to install

The same logger runs as a web page in Chrome or Edge, which can talk to Bluetooth devices directly (Safari and Firefox can't). Open the page, press **Connect to PM5**, pick the monitor from the list and row. The dashboard, the workout set-up bar and the fitness report are all there, and each finished row is kept in the browser, from where you can download the same session JSON and raw log the Python version writes. Your rows never leave your computer. The published page counts visits, connections to a PM5 and saved rows with GoatCounter, anonymously and with no cookies; a copy you serve yourself counts nothing. When it connects, the page asks the PM5 which heart-rate monitor it is paired with and remembers it; on a later day when the PM5 has nothing paired, the page asks it to pair with that monitor, so you don't have to go through the monitor's menus ("forget" beside the status line stops this). It also shows the PM5's battery level. While the PM5 is connected, or a guided session is running, the page asks the browser to keep the screen on, so it doesn't dim or lock mid-row; a note by the status line says so. The browser lets go whenever the page is out of view, and takes it back when you return to it. The Concept2 Logbook upload is not in the browser version yet; ErgData can still sync the row from the PM5's own memory afterwards. The Python logger serves this same page as its dashboard: there the logger holds the PM5 and writes the files, and the page shows the row.

On a phone the page opens with only what you read from the seat: time, distance, pace, rate, heart rate and peak force in large type, the force curve, and the controls for setting up a piece and running a guided session. When a guided session starts, the page scrolls to its instructions. Everything is still recorded and saved; "Change the display" brings back any part, and Reset returns to this layout. For the full analysis, download the row's session JSON and raw log from Saved rows on the phone, and use "Add rows from files" in Saved rows on a computer. A raw log on its own is enough, since the page rebuilds the session from it. While you row, the page also writes the raw log to the browser's storage once a minute, so if the page is closed or the phone shuts it down mid-row, the row is rebuilt from that the next time the page opens, missing at most its last minute. If saving a finished row fails, the page keeps it and offers it as files to download. This needs Chrome on Android: iPhone browsers all use Safari's engine, which has no Web Bluetooth, so an iPhone needs an app that adds it, such as Bluefy, and this page has not been tried in one.

The page is published from the `web/` folder by GitHub Actions, so it lives at the repository's GitHub Pages address once Pages is switched on. To run it yourself, serve the folder over HTTP (Web Bluetooth needs `http://localhost` or `https://`):

```bash
python3 -m http.server 8765 --directory web
```

Then open `http://localhost:8765`. "Try the sample" plays a synthetic row through the page without a rower. The decoder, the workout builder and the fitness estimate are ports of the Python modules, and `node --test web/tests/` checks them against fixtures generated by the Python code.

## Guided sessions (browser version)

The page can run a session for you, fitted to the length you want: set the piece on the monitor (a 30-minute piece, say) or type the total, and the warm-up and blocks share that time out, with a line under the settings showing how ("30:00 of rowing: 8:00 warm-up, then 6 blocks of 3:40"). If the time is too short for the blocks to give reliable numbers it says so, and if it is far too short it says what length would do. It speaks each instruction ("Seventeen strokes a minute. Pace two twelve. For three and a half minutes."), shows the target in large type with a countdown and a check that you are on it, and reports at the end. The report is saved with the row. Row a Just Row piece on the monitor and press Start.

The voice is recorded in advance: every sentence a session can say, spoken whole by the Kokoro text-to-speech model (hexgrad/Kokoro-82M, Apache 2.0 licence) in its af_heart voice and kept in `web/voice/` (1,671 sentences, 21 MB). Pressing Start fetches only the sentences that session can need (100 to 250 KB for most sessions, 2.6 MB for a capped row, whose steering can reach many paces and heart rates), and the page plays them back to back with short pauses between. A sentence that was not recorded, such as a pace outside 1:20 to 3:30 or a power that is not a multiple of 5 W, is spoken in the browser's own voice instead. `python web/tools/make_voice.py` makes the recordings from the sentence list in `web/voice.js`, and `--voice` picks another Kokoro voice.

- **Best stroke rate at a fixed pace.** Rows each rate twice in a palindrome (14, 17, 20, 20, 17, 14), so the steady rise in heart rate over a row lands equally on every rate and cancels out. Heart rate over the last two minutes of each block, adjusted to the target power, shows which rate costs you least, and how much heart rate drifted per minute. The report names a rate only when the data can carry it: every block needs heart rate for at least 80 per cent of its counted minutes, at least 60 per cent of its strokes within 10 per cent of the target power, and at least 60 per cent within one stroke a minute of the target rate; and the best rate has to beat the next by more than 1.5 bpm and by more than a rate's two blocks disagree once drift is taken off. Otherwise it says which block fell short, or that the result is too close to call.
- **Heart-rate-capped row.** Steers the pace to keep heart rate under a ceiling and reports the watts you held there. If heart rate drops out, it holds the pace instead of steering on an old reading, says so once, and the report gives how long it was missing. Rowed regularly, that number is a direct measure of aerobic progress.
- **Drift test.** A long row at fixed power. The fall in watts per heartbeat from the first half to the second is the aerobic decoupling; under 5% is the usual sign that the pace is sustainable.
- **Step test.** Stages of power up and back down again (110, 140, 170, 170, 140, 110 W by default), all easy. Heart rate at the end of each gives the heart-rate-against-power line and, with your fitness settings, a VO2max estimate. Going back down cancels the upward drift in heart rate that would otherwise make the line too steep.
- **Drag sweep.** The palindrome design across damper settings, to find the drag at which heart rate per watt is lowest, with the same checks before a setting is named. The report gives the drag factor each damper setting produced, since the same setting can give a different drag on another day.
- **Readiness check** (optional). Five minutes at a fixed easy power. Once there are three earlier checks at that power it compares today with your usual, and afterwards it asks how hard the check felt (0 to 10) and about any soreness or feeling unwell, with room for a note. A reading well above your usual, an effort well above your usual or marked soreness is reported as unusual: a prompt to look at sleep, illness and recent training together, not a verdict. It can replace the warm-up of any other session.
- **Technique drills.** Drill blocks with easy rowing between: peak position early, a long recovery, or strokes of a consistent shape. Every ten drill strokes you hear how many were on target.

Every session ends with a minute of rest for your recovery heart rate, and every saved row records when peak position started drifting later, if it did. Voice cues use the browser's speech synthesis and can be switched off.

The session engine and analysis are tested against a simulated rower whose heart rate responds to power, rate, drag and time in a known way (`node --test web/tests/`): each protocol has to recover what the simulator built in. Adding `?sim` to the page address shows a "Simulate a rower" button that runs a session against the same simulator at 20 times speed (`?sim=60` for 60 times).

## Try it without a rower

```bash
git clone https://github.com/jonstraveladventures/pm5-force-logger.git
cd pm5-force-logger
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python pm5_logger.py --replay examples/sample_row.jsonl --loop --speed 4
```

Your browser opens the dashboard and plays about three minutes of rowing. The sample is synthetic and was made by `examples/make_sample.py` in the same packet format that a PM5 sends. The only real rowing data in this repository is the animation above.

The browser version has the same sample behind "Try the sample", and "Replay a saved log" plays back the raw log of any row you have saved, at twice its speed.

## Record a session

You need a PM5 with Bluetooth, a computer with Bluetooth LE and Python 3.10 or newer. The project has been tested on macOS, and the Bluetooth library, [bleak](https://github.com/hbldh/bleak), also supports Windows and Linux.

1. Close ErgData and any other app that connects to your rower. The PM5 talks to one app at a time and stops advertising while anything is connected. If there is a Bluetooth symbol on the PM5's screen, something is still connected.
2. Wake the PM5 by pressing a button.
3. Run `python pm5_logger.py`. It finds the PM5, connects to it and opens the dashboard. On a Mac, `caffeinate -d python pm5_logger.py` also keeps the screen from dimming or locking while it runs.
4. Row, then end the piece on the monitor with the Menu button. The PM5 sends its end-of-workout summary only when the piece is ended on the monitor.
5. The logger stops 75 seconds later, when the PM5 sends the summary again with your recovery heart rate. It also stops 10 minutes after the last stroke, or when you press Ctrl+C. Every way of stopping saves the session.

It records one piece per run. Stroke counts restart at 1 when you start another piece on the monitor, so if that happens the logger saves the first piece and exits; run it again for the next one. Pausing mid-piece is fine.

On macOS, run the logger from Terminal or iTerm. The first run asks for Bluetooth permission. macOS kills a Bluetooth program started from an app without Bluetooth permission, and all you see is exit code 134.

Other commands:

```bash
python pm5_logger.py --scan      # list PM5s advertising nearby
python pm5_logger.py --info      # model, serial number and firmware version
python pm5_logger.py --reparse data/raw/<start>.jsonl       # rebuild a session file from its raw log
python pm5_logger.py --replay data/raw/<start>.jsonl        # replay a real session through the dashboard
```

Keep your PM5's firmware up to date through ErgData. Concept2's March 2026 firmware added a new force-curve format over Bluetooth, and the May 2026 release fixed the monitor freezing while sending force-curve data.

## Program a workout

The logger can program the piece on the PM5, as ErgData does, so you can leave your phone in another room. The easiest way is from the dashboard: once the logger has connected, choose a named workout or type one in the "Set up the PM5" bar and press Send to PM5; the monitor goes to its "prepare to row" screen, and Clear ends the piece. The same works from the command line:

```bash
python pm5_logger.py --workout 5000m/1000m      # single distance with 1000 m splits, then record
python pm5_logger.py --workout 4x4:00/3:00r     # 4 intervals of 4:00 with 3:00 rest, then record
python pm5_workouts.py 20:00/4:00               # program only, row without the logger
python pm5_workouts.py --list                   # the named workouts in workouts.json
python pm5_workouts.py --terminate              # clear a programmed piece
```

A workout can be a distance (`2000m`, `2.5km`), a time (`20:00`, `1:00:00`) or calories (`100cal`). You can add a split after a slash (`5000m/1000m`). If you leave it out, you get five splits. Use `NxWORK/RESTr` for N intervals with timed rest, such as `8x500m/1:00r`. The trailing r marks the preceding value as rest. With `NxWORK`, the rest is undefined and ends when you start rowing again. You can also mix intervals in a comma-separated list (`4:00/3:00r,500m/1:00r`), up to the PM5's limit of 50 intervals. Add `@1:45` at the end to set a target pace per 500 m.

You can use a workout name from `workouts.json` in place of this syntax, and edit the file to add your own named pieces. The frames are built from Concept2's CSAFE specification and checked against its worked examples in the tests. To inspect them without using Bluetooth, `--frame SPEC` prints the bytes.

## What's saved

Everything is saved in `data/` (change it with `--out`), which `.gitignore` keeps out of version control.

- `data/raw/<start>.jsonl` contains every Bluetooth notification as hex, with the time it arrived. This is the source of truth: if the parser improves, `--reparse` can rebuild the session from it.
- `data/sessions/<start>.json` contains one record per stroke:

```json
{
  "stroke_count": 12, "elapsed_s": 31.2, "distance_m": 118.4,
  "drive_length_m": 1.44, "drive_time_s": 0.81, "recovery_time_s": 1.92,
  "stroke_distance_m": 9.6, "peak_force_lbf": 111.0, "avg_force_lbf": 58.2,
  "work_j": 441.0, "power_w": 163, "spm": 22, "pace_s": 130.1, "hr": 131,
  "force_curve": [0, 0, 0, 12, 12, 29, 29, 48, "..."],
  "force_curve_v2": [12, 29, 48, 66, 81, "..."]
}
```

Forces are in pounds of force (lbf), which is how the PM5 reports them.

## Sending a row somewhere else (FIT)

Every saved row in the browser has a **FIT** button beside it. What comes out is an ordinary
Garmin FIT activity, so Garmin Connect, intervals.icu, Strava and Rowsandall read it as an indoor
row: time, distance, pace, stroke rate, heart rate, power, calories, and one lap for each split
the PM5 reported.

The per-stroke detail travels in FIT developer fields under the application UUID of the
[Rowing Data Standard](https://github.com/MoveLab-Studio/rowing-data-standard), the shared
convention Concept2, RP3, CrewNerd, Rowsandall and OpenRowingMonitor are working towards. Anything
that ignores it still gets the activity; anything that knows it also gets, for every stroke, the
drive length, the drive and recovery times, the drag factor, the average and peak force in
newtons, the work, the stroke rate to a hundredth of a stroke per minute, and how far into the
handle's travel the force peaked.

That standard is a working draft and its field numbers may change before it is ratified. The
in-stroke curve fields have no agreed numbering at all yet, so the curves themselves stay in the
session JSON for now.

For a row recorded with the Python logger, the same encoder runs from the command line:

```bash
node web/tools/tofit.mjs data/sessions/2026-09-18_171111.json
```

## Reading the force curve

There is no single perfect curve, and coaches disagree about the details, though they agree on the basics. Concept2 describes a good curve as one smooth hump and says that the usual fault is a dip at the handover from the legs to the back. Valery Kleshnev's measurements of elite rowers give targets for four measures of the curve's shape. The dashboard scores each stroke against them:

| Measure | What it is | Target |
|---|---|---|
| Peak position | Where in the drive force peaks | ≤40% of the drive; after 55% is late |
| Catch gradient | How far into the drive before force reaches 70% of peak | ≤17% |
| Finish plateau | How long force stays above 70% of peak after the peak | 28–40% of the drive |
| Rectangle index | Average force ÷ peak force | 38–64%; higher is a fuller curve |

There is a second school, and the dashboard offers it as an alternative. RP3 Rowing, whose dynamic ergs measure force curves for many national crews, argues for a rounder curve (the German "Schubschlag", a thrust stroke) with its peak just before the oar is square, at about 43 to 48 per cent of the drive depending on the boat, and says that the front-loaded shape Kleshnev's targets describe is rare among winning crews. Their guidance is set out in their training guide "Training with RP3 for Dummies" (v1.2, 2025) and the white paper "How coaches could use the RP3 indoor rower" (Broenink and Bon, v1.3, 2023), both on rp3rowing.com. Choose "RP3" under Targets to score the peak position against their band and to compare with a rounded reference shape instead. The two schools disagree about the peak; they agree that the curve should be smooth, with no dips, and that a peak later than about 55 per cent of the drive is late. The dashboard reports where the peak falls; why it moved is a question for your own curves at a similar power and rate, or for video.

Two things from the RP3 material are shown whichever school you pick. The parabola fit is how closely the curve follows a parabola, the score RP3's own software uses for stroke quality; work per stroke times that score is their "effective work per stroke". And with "RP3 bands" switched on, the work per stroke, peak force and drive length of each stroke are placed against RP3's guideline bands for club, intermediate and elite rowers (men or women, drive length for a rower of average height). Those bands come from a dynamic erg whose force is not the PM5's handle force, so they place a number roughly; they are not a ranking. Enter your body mass in the same panel and work per stroke and peak force are also shown per kilogram, which compares rowers of different sizes without weight classes or invented bands.

The PM5's curves are not smooth as they come: the plateau ripples by about 2.5% of peak, and the ripple occasionally looks like a dip. "Smoothing: light" runs a 5-point Savitzky-Golay filter over each curve before it is drawn and measured. Tested the way OpenRowingMonitor tests its own filter, on known curves with noise like the PM5's added, it took false dips from 27 in 400 strokes to 1 and found real handover dips as often as the raw curve did. A 7-point window lost a fifth of the real dips, so it isn't offered. Smoothing does not steady the peak position: on a flat-topped curve the highest point wanders whatever you do.

The dashboard also counts dips as the force rises and measures how far the shape of each stroke is from the reference and your session average. For these comparisons, each curve is trimmed from the first force to the release and scaled to its own peak. This compares the shape of the curves, not how hard you pulled.

Treat the targets as guides, not pass marks:

- Kleshnev's figures come from boats on the water, where force was measured at the oarlock against oar angle. The PM5 measures force at the handle.
- With the default channel, the chart's horizontal axis is handle travel: each reading is 3.5/3 inches (2.96 cm) of the handle moving away from the flywheel, as Concept2 describes the newer force channel, so peak position is a real distance into the stroke, and it is shown in centimetres as well as per cent. That is close to, though not the same as, Kleshnev's oar angle. The other channel is force against time, and on it peak position is a share of the drive's duration instead, which comes out a little different.
- The default reference is a smooth shape built to meet the targets. It is not a measured elite curve.

Comparing with yourself is more useful. After a row that felt right, press "Save average as my reference" and switch "Compare to" over to it. You can then watch whether your peak moves later as you tire, whether the rectangle index falls, whether a dip appears at the leg-to-back handover and how much your strokes vary over the session.

## Concept2 Logbook upload (optional)

1. Register an API application with Concept2 (see the [Logbook API documentation](https://log.concept2.com/developers/documentation/)) and set its redirect URI to `http://localhost:8766`.
2. Copy `.env.example` to `.env` and fill in your client ID and secret. Set `CONCEPT2_WEIGHT_CLASS=L` if you row lightweight.
3. Run `python concept2.py auth`, approve access in the browser, then check it with `python concept2.py whoami`.

The logger will then post each finished row to your Logbook, together with its stroke data. It posts only rows that the PM5 ended properly, and only Just Row, fixed-distance and fixed-time pieces. Interval workouts aren't supported yet. It never posts the same session twice, and the Logbook refuses duplicates anyway. To check a row before it is posted, or to retry one, run `python pm5_upload.py data/sessions/<start>.json --dry-run`.

The row is dated by the time it ended, in your computer's timezone as read from `/etc/localtime` or the `TZ` environment variable. Where neither is available, on Windows for instance, it is dated in UTC and labelled as such.

Concept2 issues a new refresh token every time one is used and cancels the old token, so `concept2.py` saves each new token back to `.env`. If you ever see "The refresh token is invalid", run `python concept2.py auth` again.

## Watts at a fixed heart rate, and a VO2max estimate (optional)

If a heart-rate monitor is paired with the PM5, every stroke carries power and heart rate, which is what the submaximal fitness tests use. Set `PM5_MASS_KG`, `PM5_HRMAX` and `PM5_HR_REST` in `.env` (see `.env.example`) and the logger prints two numbers after each row: the watts you hold at a chosen heart rate (`PM5_ZONE_HR`, say the top of your zone 2), and an estimate of VO2max. The same report runs over any set of sessions:

```bash
python pm5_vo2.py data/sessions/*.json
```

Each row's steady part (after the first five minutes, without the last minute, sprints and pauses) gives a mean power and heart rate. The watts at your chosen heart rate and at your maximum are read off the line through that point and your resting heart rate, and the power at maximum becomes oxygen uptake by way of the energy cost of rowing. With three or more rows at different intensities, the report fits the line to the rows instead. A guided step test in the browser gives that spread in one row: the report reads each finished stage as a point of its own, fits a line to the stages alone, and adds them to the fit across your other rows. Heart rate drifts upwards through a long row even at a steady power. In a test that only climbs, that rise lands on the later, harder stages and reads your fitness low, so the step test comes back down the same steps, which leaves the line where it would be without drift. The report flags a step test that stopped before the way down was finished, and any done before this change, which only climbed. Heart-rate estimates of VO2max are usually reported to fall within 10 to 15 per cent of a laboratory measurement; this project has not checked its own against one. The figure inherits any error in your maximum heart rate (220 minus age is often ten beats out), in wrist heart-rate readings while rowing, and in rowing economy. The watts at a fixed heart rate near the one you rowed at need almost no extrapolation and are the number to track. `pm5_vo2.py` sets out the method and its assumptions. Nothing from this is stored in the session file or uploaded.

In the browser, "Progress on repeated pieces" follows each piece you row more than once: the same distance or time set on the monitor (a Just Row counts when it stops on a round distance or a whole number of minutes). For each row it lists the result, mean watts and heart rate, the time spent above your easy-row ceiling, the heart-rate drift over the steady part and the watts at your ceiling, and once there are three finished rows it fits a line through all of them and gives the scatter about it, so a single good or bad day reads as one. Rows that stopped short of their piece are listed but kept out of the line. Set your easy-row ceiling in the fitness settings; without it the report leaves out the figures that depend on it.

## Notes on the PM5's Bluetooth data

The published specification doesn't make the following behaviour obvious:

- Stroke data arrives twice per stroke: once at the end of the drive and again at the end of the recovery, when it contains that stroke's recovery time. The first copy contains the previous stroke's recovery time. The logger merges the two copies into one record per stroke.
- There are two force-curve channels. The documented channel (`0x003D`) is sampled in time steps, so each reading repeats two or three times and there are zeros at the start. The newer channel (`0x0043`) arrives just after it, uses the same packet scheme and gives one point per reading. It is force against distance: Concept2 confirmed (September 2026, and revision 0.36 of the CSAFE definition) that each point is 3.5/3 inches of handle travel on RowErg models B to D, and in rows logged here a stroke's points span about 90% of the drive length the PM5 reports, the rest being the first and last few centimetres where the force is too low to register. Both are saved as `force_curve` and `force_curve_v2`. The peak of every curve matches the peak force that the PM5 reports for the stroke, confirming that the unit is pounds of force.
- Characteristic `0x003E` ("additional status 3" in revision 0.36) sends, once a second, the operating state, the screen being shown, the last error code, calibration and game fields, and the battery level; the dashboard shows the battery.
- Characteristics `0x0037` and `0x0038` arrive at the end of each split with its time, distance, pace, rate, power, heart rate and drag factor. They are saved as `splits` in the session file and shown in a table under the strokes. The Logbook upload rebuilds splits from the strokes, which agree with the PM5's own to within a metre.
- On macOS, the device name is often available only in the advertisement's local name. bleak's `find_device_by_filter` sometimes missed a PM5 that a plain scan had just found, so the logger runs repeated discovery passes.
- Heart rate reaches this data only when a heart-rate monitor is paired with the PM5 itself.

So far this has been tested on one PM5, running firmware 178.069. Other PM5 versions and firmware may behave differently. The raw log means that anything decoded wrongly can be fixed afterwards.

## Tests

```bash
python -m unittest discover -s tests -v
```

The tests build packets by hand from the specification's byte layouts, check the force-curve reassembly and the merging of the two stroke-data copies, and run the synthetic sample through the same parser the logger uses live. They need no Bluetooth or network, and run on every push through GitHub Actions. The browser version has its own tests (`node --test web/tests/`) against fixtures written by `web/tests/make_fixtures.py` from the Python code, so the two implementations are checked against each other; re-run that script after changing the Python side. The FIT files are read back in the Node tests by a reader written from the file format rather than from the writer; `web/tests/verify_fit.py` puts them through Garmin's own SDK and fitdecode as well, which needs `pip install garmin-fit-sdk fitdecode`.

## How this was built

Jonathan Shock built this with Claude, Anthropic's AI model, working in Claude Code. Claude wrote the code, the dashboard, the tests and the first draft of this README, from Concept2's published specification, the PM5's own Bluetooth traffic and the sources below. The decoding was checked against a real PM5 and the rest against synthetic data. If you find something wrong, please open an issue.

## Sources

- Concept2, [PM Bluetooth Smart Communication Interface Definition](https://www.concept2.co.in/files/pdf/us/monitors/PM5_BluetoothSmartInterfaceDefinition.pdf), revision 1.30
- Concept2, PM CSAFE Communication Definition, revision 0.36 (August 2026), sent by Concept2 in September 2026; it documents the force-against-distance channel `0x0043`, the status characteristic `0x003E`, the split characteristics and the heart-rate monitor commands used here. An earlier revision is [published here](http://www.concept2.co.in/files/pdf/us/monitors/PM5_CSAFECommunicationDefinition.pdf).
- Concept2, [Logbook API documentation](https://log.concept2.com/developers/documentation/)
- [Rowing Data Standard](https://github.com/MoveLab-Studio/rowing-data-standard), draft v0.1 (August 2026), originally written by Sander Roosendaal: the FIT developer fields this project writes. Nothing in it is ratified yet.
- Concept2, [Improving your rows with the force curve](https://www.concept2.com/blog/improving-your-rows-with-the-force-curve)
- V. Kleshnev (2011), *Biomechanics of Rowing*; the targets as summarised by [biomex.studio](https://biomex.studio/rowing/)
- RP3 Rowing, [Training with RP3 for Dummies](https://rp3rowing.com/wp-content/uploads/2025/09/Training-with-RP3-for-Dummies-v1.2-English.pdf), v1.2 (2025), and S. Broenink and S. Bon, [How coaches could use the RP3 indoor rower to improve rowers](https://rp3rowing.com/wp-content/uploads/2025/09/White-Paper-Improve-the-ForceCurve-ENG-1.3-4.pdf), v1.3 (2023). Their peak-position band, stroke-quality score and guideline bands are restated here with attribution; the documents themselves are RP3's.

This project is not affiliated with or endorsed by Concept2.

## Not advice

This is a hobby project, not coaching or medical advice. The shape targets are guides from published rowing research, the fitness numbers are rough estimates, and rowing hard carries the usual risks, so row within your own limits and talk to a professional about your health. The software is offered as is, under the MIT licence, and its authors accept no liability for its use.

## Licence

MIT
