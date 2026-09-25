---
name: bezel
description: >-
  Produce device-framed, DPR-correct screenshots of a running app or URL
  for READMEs, PR bodies, and social posts. Use whenever the user asks
  for app screenshots, device mockups, framed screenshots, hero images,
  a phone/tablet/laptop/browser frame around a UI, or a scrolled video
  capture of a page. Captures with Playwright at exact device viewports
  and composites into generated CSS frames — no design tool needed.
---

# Bezel

Screenshots that look like product shots, straight from the running app.
Bezel captures a URL at an exact device viewport (DPR-correct, so text
is pixel-sharp) and composites it into a clean generated device frame.

## Workflow

1. One-time setup in the skill directory: `npm install` (installs
   playwright-core; it drives the system Chrome — no browser download).
   The target app must be reachable by URL (local dev server or public).

2. Capture:

   ```bash
   node <path-to-skill>/scripts/bezel.mjs http://localhost:3000 --device iphone-15-pro
   node <path-to-skill>/scripts/bezel.mjs https://myapp.dev --devices iphone-15-pro,macbook-14 --dark
   node <path-to-skill>/scripts/bezel.mjs https://myapp.dev --device iphone-15-pro --scroll --out demo.mp4
   ```

   Devices: `iphone-15-pro`, `pixel-8`, `ipad-pro-11`, `macbook-14`,
   `browser`. Useful flags: `--dark` (page color scheme + dark studio
   background), `--bg studio|studio-dark|sunset|ocean|none|<css>`,
   `--frame light`, `--padding`, `--no-shadow`,
   `--hide "<selector,selector>"` for cookie banners, `--wait <ms>` for
   slow pages.

3. **Trust the checks, and say what they said.** Every single-device run
   verifies itself and prints `check:` lines: capture is DPR-exact,
   output dimensions match the device spec, and frame alignment via
   pixel sampling. Exit 1 means a check failed — do not hand the image
   over; re-run with `--wait` higher or report the failure.

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
