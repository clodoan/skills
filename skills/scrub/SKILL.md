---
name: scrub
description: >-
  Frame-by-frame analysis of UI animation screen recordings (.mp4/.mov/.gif
  from CleanShot, QuickTime, Screen Studio). Use when the user shares a
  recording and asks about motion, timing, easing, duration, jank, dropped
  frames, overshoot, or whether it matches a spec. Produces frame/ms-stamped
  contact sheets and a motion table via ffmpeg.
---

# Scrub

## Workflow

1. Run the script on the recording (requires ffmpeg ≥ 4.4 on PATH):

   ```bash
   node <path-to-skill>/scripts/scrub.mjs <recording>
   ```

   It writes `<recording>-scrub/`. A different `--out` must be new, empty,
   or a previous scrub output. Defaults usually work; see `--help` for
   `--max-frames`, `--grid`, `--fps`, `--no-crop`, `--min-px`, `--threshold`.

2. **Read `index.md` first**: metadata, the active motion window, the crop,
   the files to open, and the motion table. Then look at `overview.png`,
   `sheets/sheet-*.png` (each cell stamped `f<frame> <ms>ms`) and
   `sheets/diff-*.png` (same cells; black = a hold, possible jank
   mid-animation). If index.md says cells are unstamped, use its per-sheet
   frame lists.

3. Take the numbers from `motion.csv`. The bbox is **estimated from pixel
   differencing**, not the real animation values: say so when precision
   matters, and verify positions on the sheets.

## Reporting findings

Always answer in frame/ms terms tied to what the user asked, and name
what the numbers show with terms from
[references/motion-vocabulary.md](references/motion-vocabulary.md),
which maps each term to its signature in the table and sheets:

> Movement runs frames 16–43 (533–1433 ms, ~900 ms total). The center-x
> curve decelerates smoothly into the target, overshoots to ~257 px by
> frame 31 and settles back to ~241 px by frame 43 — reads as an
> ease-out ending in a bounce (~10% overshoot, one reversal, so fairly
> high damping). The spec says plain ease-out: the overshoot at frames
> 30–35 is the mismatch.

Call out: total duration, easing shape (from the position curve and the
spacing of the diff bars), overshoot/settle, holds or dropped frames
(black diff cells, repeated positions), and direction changes.

## When something looks off

- "No motion detected" but the overview shows change: re-run with
  `--min-px 5` for tiny changes or `--threshold 4` for slow fades.
- Multiple elements moving: the bbox is their union; read the sheets
  visually instead of trusting cx/cy.
- Need exact frames beyond the sheets: extract from
  `work/normalized.mp4` (all frame numbers refer to it), e.g. from the
  output dir:
  `ffmpeg -i work/normalized.mp4 -vf "select='eq(n\,31)'" -frames:v 1 f31.png`.
