---
name: scrub
description: >-
  Inspect a UI animation frame by frame from a screen recording. Use
  whenever the user shares a video or GIF of a UI or animation (CleanShot,
  QuickTime, Screen Studio, .mp4/.mov/.gif) and asks about motion, timing,
  easing, duration, jank, dropped frames, overshoot, or whether the motion
  matches a spec. Runs an ffmpeg-based script that produces stamped
  contact sheets and a per-frame motion table, then reports findings in
  frame/ms terms.
---

# Scrub

You cannot watch a video, but you can read frames. Scrub turns a screen
recording into artifacts you can actually inspect: contact sheets stamped
with frame numbers and milliseconds, difference images showing what
moved, and a per-frame motion table.

## Workflow

1. Run the script on the recording (requires ffmpeg ≥ 4.4 on PATH):

   ```bash
   node <path-to-skill>/scripts/scrub.mjs <recording>
   ```

   It writes `<recording>-scrub/`. Long clips are sampled automatically;
   pass `--max-frames`, `--grid`, `--fps`, `--no-crop` only if the
   defaults fail you.

2. **Read `index.md` first.** It has the metadata (duration, real fps,
   VFR handling, resolution and retina hint), the active motion window,
   the crop applied, and the motion table.

3. Look at the images in this order:
   - `overview.png` — the whole clip at a glance.
   - `sheets/sheet-*.png` — dense frames of the active window, cropped
     to the motion. Each cell is stamped `f<frame> <ms>ms`.
   - `sheets/diff-*.png` — what changed between consecutive frames;
     black cells are holds (possible jank mid-animation).

4. Use `motion.csv` / the table for the numbers: where motion starts,
   peaks, overshoots, settles. The bbox curve is **estimated from pixel
   differencing**, not the real animation values — say so when precision
   matters, and verify positions visually on the sheets.

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

- Motion too small to crop or all-black diffs: re-run with `--no-crop`
  and check the overview — the change may be a fade, not movement.
- Multiple elements moving: the bbox is their union; read the sheets
  visually instead of trusting cx/cy.
- Need exact frames beyond the sheets: extract from
  `work/normalized.mp4` (all frame numbers refer to it), e.g.
  `ffmpeg -i work/normalized.mp4 -vf "select='eq(n\,31)'" -frames:v 1 f31.png`.
