# Plinth

Device-framed, DPR-correct screenshots of a running app or URL — the
Figma-mockup-plugin workflow (device frames around app shots) without
leaving the terminal, driven by your coding agent, with spec-accurate
device chrome.

Plinth captures with Playwright at the device's **safe-area viewport**
(page content never sits under the Dynamic Island, status bar, or home
indicator), draws faithful chrome, and composites at native DPR. Frames
and chrome are generated CSS/SVG — no copyrighted vendor artwork.

![x.ai (public homepage) on phone, tablet and laptop frames](assets/xai-multi-device.png)

## Quick start

```bash
cd skills/plinth && npm install     # playwright-core + @fontsource/inter
node scripts/plinth.mjs https://x.ai --device iphone-16-pro
node scripts/plinth.mjs https://x.ai --device iphone-16-pro --mode safari
```

Requires Node ≥ 18 and an installed Chrome/Chromium (playwright-core
drives it via the `chrome` channel — no browser download; set
`PLINTH_BROWSER=/path/to/chrome` to override). ffmpeg only for `--scroll`.

<p>
  <img alt="x.ai as iPhone 16 Pro, app mode: status bar, island, home indicator, content inside the safe area" src="assets/xai-iphone-16-pro-app.png" width="300" />
  &nbsp;
  <img alt="x.ai as iPhone 16 Pro in safari mode with the compact bottom address bar" src="assets/xai-iphone-16-pro-safari.png" width="300" />
</p>

All showcase shots are public, logged-out pages (captures run in a
fresh browser context, so there is never a session to leak).

## Phone presentation modes

- **`--mode standalone`** (default): app-style. Plinth draws the iOS
  status bar (9:41, cellular/wifi/battery) and home indicator; the page
  is captured at `height − safe-area-top − safe-area-bottom`, so no
  content ever sits under the island. The safe-area bands are painted
  with the page's own sampled background color, like a real
  safe-area-aware app.
- **`--mode safari`**: mobile Safari. Status bar plus the iOS-18-style
  compact bottom address bar showing the domain, viewport reduced to
  match. (Safari's bar is a dynamic element with no fixed published
  height; drawn as a 50pt pill zone above the 34pt safe area —
  approximation by design.)
- **`--mode bare`**: full-bleed capture under everything (the old
  behavior), island drawn on top. For pages that draw their own mobile
  chrome.

The status bar color scheme follows the page's background luminance
(light content on dark pages), overridable with `--status light|dark`.
The home indicator adapts the same way. Status-bar text renders in
**Inter** (bundled via `@fontsource/inter`): SF Pro cannot be
redistributed, and Inter is the closest freely-licensed metric match.

## Device spec table (all values cited)

Geometry lives in `scripts/devices.mjs` with per-value citations.
Sources: [useyourloaf screen sizes](https://useyourloaf.com/blog/iphone-16-screen-sizes/)
(points, scale, status bar, safe areas), [1440px.com/safe-area](https://1440px.com/safe-area/)
(cross-model safe-area table), measured home-indicator geometry
([134×5pt, 8pt above the edge](https://stackoverflow.com/q/53109069)),
`_displayCornerRadius` collations (55pt / 62pt), island geometry from
public UI kits and simulator shells (124–126×36–37pt @ y≈11 — we use
125×37 and note the ±1pt source disagreement),
[bjango](https://bjango.com/articles/designingmenubarextras/) and
[crestnotch](https://crestnotch.app/macbook-notch-dimensions) for the
MacBook menu bar (37pt) and notch (≈185pt, flagged "derived" there).

| id | viewport (pt) | DPR | safe top/bottom | chrome |
| --- | --- | --- | --- | --- |
| `iphone-16-pro` | 402×874 | 3 | 62 / 34 | island 125×37 @y11, status 54, radius 62, indicator 134×5 |
| `iphone-16` | 393×852 | 3 | 59 / 34 | island, status 54, radius 55 |
| `iphone-15-pro` | 393×852 | 3 | 59 / 34 | island, status 54, radius 55 |
| `pixel-8` | 412×915 | 2.625 | 28 / 24 | punch hole, Android status bar — metrics APPROX |
| `ipad-pro-11` | 834×1194 | 2 | 24 / 20 | status 24, radius 18, indicator width APPROX |
| `macbook-14` | 1512×982 | 2 | menu bar 37 | notch 185×37, macOS-style menu bar |
| `browser` | 1280×800 | 2 | — | Chromium-style tab strip 38 + toolbar 44 (APPROX) |

Values marked APPROX have no authoritative public source (Android
chrome, Safari's dynamic bar, iPad indicator width, browser chrome) and
are drawn from real screenshots; everything else is cited.

Screen corners are **continuous-curvature**: a sampled superellipse
(exponent 4.5) rather than CSS's circular `border-radius`, and the same
squircle path both clips the screenshot and cuts the frame's hole, so
the inner radius matches exactly with no gaps or halos. Side buttons:
`--buttons` (positions approximate).

## Built-in verification (every single-device run, exit 1 on failure)

- capture buffer is exactly the safe-area viewport × DPR;
- output PNG dimensions equal the computed frame+padding size;
- content-center pixel matches the raw capture (alignment);
- the Dynamic Island region is solid black at its spec position;
- the home indicator is present at its spec position.

`scripts/spec-overlay.mjs` draws the cited geometry over any output for
visual review (a real iOS Simulator isn't runnable in a Linux
environment, so the overlay validates against the cited numeric spec):

<img alt="spec overlay: status bar, island, safe-area and home-indicator regions drawn over a real render" src="assets/spec-overlay-iphone-16-pro.png" width="300" />

## Options

```
--device <id>       one device (default iphone-16-pro)
--devices <a,b,c>   multi-device row (composited @2x)
--mode <m>          standalone | safari | bare   (phones/tablets)
--status <s>        auto | light | dark          (status bar content)
--buttons           side buttons on phone frames
--out <file>        output path (.png; .mp4/.gif with --scroll)
--bg <value>        studio | studio-dark | sunset | ocean | none | any CSS
--padding <px>      space around the frame (default 48)
--no-shadow         flat, no drop shadow
--dark              dark color scheme + dark studio background
--frame dark|light  frame body theme
--hide <selectors>  hide elements before capture (cookie banners etc.)
--wait <ms>         extra settle time (default 800)
--scroll            scrolled full-page capture → mp4/gif (ffmpeg)
```

## Tested on (real sites, 2026-09-25)

| Site | Run | Result / findings |
| --- | --- | --- |
| [x.ai](https://x.ai) and public pages (/grok, /api, /news, /company) | app + safari modes, multi-device row, browser frame | All fidelity checks pass; showcase images above come from these runs. Spec overlay confirms region registration. **Finding:** Cloudflare blocks the default HeadlessChrome user agent outright (the block page rendered and dimension checks passed, because a page really did render) — plinth now presents the equivalent stable-Chrome UA, which passes. Always eyeball output on bot-walled sites. |
| vercel.com, app-router.vercel.app, commerce-shopify.vercel.app, github.com | earlier runs | See git history: cookie banner via `--hide`, empty API-backed states, blocked-CDN blank pages — all documented app-state findings, not frame issues. |

Known limitations: multi-device rows composite at @2x (mixed native
DPRs can't share one page); verification is dimensional + pixel
sampling and cannot judge app-level blankness; APPROX metrics listed
above; no authenticated-session capture yet.

## Tests

```bash
cd skills/plinth && npm install && npm test
```

14 tests, including fidelity assertions against a fixture with edge
markers: no page pixels under the island/status bar/home indicator in
standalone mode, exact content-origin at the safe-area top, island
blackness at spec coordinates, home-indicator presence/contrast, safari
pill presence, macOS menu bar + notch, browser chrome, deterministic
multi-device dims, fractional DPR, scroll mp4. Tests self-skip without
Chrome.
