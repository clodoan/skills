---
name: plinth
description: >-
  Device-framed, DPR-correct screenshots of a URL or running app (iPhone,
  Pixel, iPad, MacBook, browser window), or a scrolled mp4/gif. Use for
  app screenshots, device mockups, and framed hero images for READMEs,
  PR bodies, and social posts.
---

# Plinth

## Workflow

1. One-time setup in the skill directory: `npm install` (playwright-core
   drives the installed Chrome; nothing is downloaded; `PLINTH_BROWSER`
   overrides the binary). The app must be reachable by URL; a bare
   `localhost:3000` means http.

2. Capture:

   ```bash
   node <path-to-skill>/scripts/plinth.mjs http://localhost:3000 --device iphone-16-pro
   node <path-to-skill>/scripts/plinth.mjs https://myapp.dev --device iphone-16-pro --mode safari
   node <path-to-skill>/scripts/plinth.mjs https://myapp.dev --devices iphone-16-pro,macbook-14 --dark
   node <path-to-skill>/scripts/plinth.mjs https://myapp.dev --device iphone-16-pro --scroll --out demo.mp4
   ```

   Devices: `iphone-16-pro` (default), `iphone-16`, `iphone-15-pro`,
   `pixel-8`, `ipad-pro-11`, `macbook-14`, `browser`. `--mode`:
   `standalone` (default: page inside the safe area, status bar + home
   indicator drawn), `safari` (iPhones only: compact bottom bar), `bare`
   (phones/tablets: full-bleed). Output defaults to
   `plinth-<device>.png` in the working directory (`plinth-multi.png`,
   `plinth-<device>-scroll.mp4`); `--out` must end in `.png`, or
   `.mp4`/`.gif` with `--scroll`. All flags: `--help`.

3. Report the `check:` lines. Single-device stills and frame 0 of a
   `--scroll` video are verified: content matches the capture
   pixel-for-pixel and the chrome (status bar, home indicator, menu bar,
   window chrome) is drawn. Exit 1: a check failed; the file is kept at
   `<name>.failed.png` (or `.failed.mp4`). Don't deliver it; report the
   failure. Exit 2 is a usage error, exit 3 a runtime error (navigation,
   browser, ffmpeg). Multi-device rows are not checked.

4. The checks can't see page problems, so open the image yourself:
   cookie banners (`--hide "<selector,…>"`), empty or unseeded states,
   late fonts or animations (`--wait 2000`), bot walls. In `--scroll`
   videos, sticky and fixed elements scroll away with the content.

## Choosing output

- README hero: multi-device row (`--devices`, composited at @2x), light `--bg`.
- PR body / bug report: single device, 1:1 native pixels (default).
- Social: single phone, `--dark --bg sunset`.
- Scrolled demo: `--scroll` (needs ffmpeg).

Full option and device reference: [README.md](README.md).
