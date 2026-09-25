---
name: plinth
description: >-
  Produce device-framed, DPR-correct screenshots of a running app or URL
  for READMEs, PR bodies, and social posts. Use whenever the user asks
  for app screenshots, device mockups, framed screenshots, hero images,
  a phone/tablet/laptop/browser frame around a UI, or a scrolled video
  capture of a page. Captures with Playwright at exact device viewports
  and composites into generated CSS frames — no design tool needed.
---

# Plinth

Screenshots that look like product shots, straight from the running app.
Plinth captures a URL at an exact device viewport (DPR-correct, so text
is pixel-sharp) and composites it into a clean generated device frame.

## Workflow

1. One-time setup in the skill directory: `npm install` (installs
   playwright-core; it drives the system Chrome — no browser download).
   The target app must be reachable by URL (local dev server or public).

2. Capture:

   ```bash
   node <path-to-skill>/scripts/plinth.mjs http://localhost:3000 --device iphone-16-pro
   node <path-to-skill>/scripts/plinth.mjs https://myapp.dev --device iphone-16-pro --mode safari
   node <path-to-skill>/scripts/plinth.mjs https://myapp.dev --devices iphone-16-pro,macbook-14 --dark
   node <path-to-skill>/scripts/plinth.mjs https://myapp.dev --device iphone-16-pro --scroll --out demo.mp4
   ```

   Devices: `iphone-16-pro`, `iphone-16`, `iphone-15-pro`, `pixel-8`,
   `ipad-pro-11`, `macbook-14`, `browser`. Phone modes: `--mode
   standalone` (default: status bar + home indicator, page captured
   inside the safe area so nothing sits under the Dynamic Island) |
   `safari` (mobile Safari with compact bottom bar) | `bare`
   (full-bleed). Other flags: `--status light|dark` overrides the
   luminance-based status bar scheme, `--buttons`, `--dark`,
   `--bg <preset|css>`, `--frame light`, `--padding`, `--no-shadow`,
   `--hide "<selector,selector>"`, `--wait <ms>`.

3. **Trust the checks, and say what they said.** Every single-device run
   verifies itself and prints `check:` lines: safe-area capture is
   DPR-exact, output dimensions match the device spec, frame alignment,
   the Dynamic Island is solid black at its spec position, and the home
   indicator is present. Exit 1 means a check failed — do not hand the
   image over; re-run with `--wait` higher or report the failure.

4. Look at the output image before delivering it. Real pages have real
   problems: cookie banners (`--hide`), unseeded/empty states, fonts
   still swapping (`--wait 2000`), lazy images below the fold (only
   `--scroll` runs the full-page pre-scroll).

## Choosing output

- README hero: multi-device row (`--devices`), light `--bg`, PNG.
- PR body / bug report: single device at 1:1 (default), studio bg.
- Social: single phone `--dark --bg sunset`.
- Animated/scrolled demo: `--scroll` → mp4 (or `--out x.gif`), uses
  ffmpeg.

Multi-device rows composite at @2x for sane file sizes; single-device
output is 1:1 native pixels of the capture.

Full option and device reference: [README.md](README.md).
