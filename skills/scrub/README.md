# Scrub

Frame-by-frame UI animation inspection for coding agents. Drop a screen
recording (CleanShot X, QuickTime, Screen Studio, a `.gif`) into your
agent chat, and the agent runs one script and reads the results — no
setup beyond ffmpeg.

Agents can't watch videos. Scrub converts a recording into things an
agent reads well: an `index.md`, contact sheets stamped with frame
numbers and milliseconds, difference images, and a per-frame motion
table.

## Quick start

```bash
node skills/scrub/scripts/scrub.mjs recording.mp4
# → recording-scrub/index.md  (read this first)
```

Requires ffmpeg + ffprobe 4.4 or newer on PATH and Node ≥ 18. No other
dependencies. Frame stamps need an ffmpeg that can draw text (freetype +
fontconfig): Homebrew's `ffmpeg` can't, so use `brew install ffmpeg-full`
(`apt-get install ffmpeg` is fine). Without it, scrub still runs, warns,
and lists each sheet's frames in `index.md` instead of stamping cells.

## What it produces

```
recording-scrub/
  index.md            metadata, motion summary, per-frame table — the entry point
  overview.png        16 frames sampled evenly across the whole clip
  sheets/sheet-*.png  dense 4×4 grids of the active window, cropped to motion,
                      each cell stamped f<frame> <ms>ms
  sheets/diff-*.png   consecutive-frame differences (brightened): what moved
  motion.csv          frame, ms, motion bbox (x y w h), center, changed pixels
  motion-curve.svg    plotted x/y center + changed-pixel curves
  work/normalized.mp4 the constant-fps clip all frame numbers refer to
```

## What it handles

- **Variable frame rate** — CleanShot and QuickTime recordings are often
  VFR; scrub detects it from packet timestamps and normalizes to a
  constant rate (at most 120 fps) before any frame math, so
  `frame × (1000/fps)` is always honest. The index states when this
  happened, and when a faster source lost frames.
- **Still head/tail** — trimmed automatically; only the window where
  something moves gets dense treatment.
- **Motion crop** — sheets are cropped to the bounding box of all motion
  (padded), and small crops are upscaled up to 4× (nearest-neighbor, so
  pixels stay inspectable). Every sheet stays within 4096 px per side;
  large frames are scaled down to fit. Rotated videos use their display
  orientation.
- **Long clips** — dense frames are capped (default 96): windows that
  fit get every frame, longer ones evenly spaced frames from start to
  end. The overview always spans the full clip.
- **Retina hint** — the index says whether the resolution could be a 2x
  capture. Resolution alone can't tell a 1x large monitor from Retina,
  or a 1x capture from a 2x region capture, so verify against a known
  element size.

## Honesty about the numbers

The motion table is **estimated from pixel differencing between
consecutive frames** — it is not the real animation values. The bbox of
a diff spans both the old and the new position of whatever moved;
fades, blurs, and sub-pixel motion register as changed pixels without a
clean box. Treat the curve as shape evidence (where motion starts,
eases, overshoots, settles) and confirm positions visually on the
sheets.

## Naming what moved

[`references/motion-vocabulary.md`](references/motion-vocabulary.md)
gives the agent a shared vocabulary for motion (stagger, pop in, bounce,
origin-aware, rubber-banding, and about 70 more) and maps each term to
what it looks like in scrub's table and sheets. The agent can then
report "a 40 ms stagger of scale-in entrances" instead of raw bbox
numbers. Terms and definitions come from Emil Kowalski's
[animation-vocabulary](https://github.com/emilkowalski/skills/tree/main/skills/animation-vocabulary)
skill (MIT).

## Options

```
--out <dir>        output directory (default <video>-scrub); must be new,
                   empty, or a previous scrub output (only scrub's own
                   files are replaced)
--fps <n>          override the normalized frame rate
--grid <n>         sheet grid (default 4 = 16 cells per sheet)
--max-frames <n>   cap on dense frames (default 96)
--pad <px>         padding around the motion crop (default 24, 0 allowed)
--no-crop          keep the full frame
--min-px <n>       changed pixels a frame needs to count as motion (default 20)
--threshold <n>    luma delta for faint change such as fades (default 8, max 24)
--keep-work        keep intermediate filter scripts and metadata
```

## Future mode (not in this version)

Driving a browser to capture the animation directly (Playwright/CDP
capture with device-pixel-ratio awareness and interaction scripting) is
a planned second input mode. This version is video-first: it analyzes
recordings you already have.

## Tests

```bash
node --test skills/scrub/scripts/scrub.test.mjs
```

The suite generates synthetic ffmpeg clips (a moving box with known
back-ease-out overshoot, a VFR retiming of it, a still clip, a long
oscillation, a GIF) and asserts the recovered motion matches within
tolerance. Tests self-skip when ffmpeg is not installed.
