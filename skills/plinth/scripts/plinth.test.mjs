import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEVICES, frameSize, screenRect, contentRect } from "./devices.mjs";
import { decodePng, getPixel, pngSize, colorDistance } from "./png.mjs";
import { browserAvailable } from "./capture.mjs";

const CLI = fileURLToPath(new URL("./plinth.mjs", import.meta.url));
const PAD = 48;

// Fixture edge markers (see fixture-server.mjs): lime pins the top of the
// page viewport, blue the bottom. Their presence inside chrome regions
// would mean page content under the island / status bar / home indicator.
const MARKER_TOP = [0, 255, 0, 255];
const MARKER_BOTTOM = [0, 0, 255, 255];
const HERO = [225, 29, 72, 255];

// Same launch path as the CLI, so a Chrome the CLI can drive is never
// skipped. PLINTH_REQUIRE_BROWSER=1 (CI) turns a missing browser into a
// failure instead of a skip.
const hasBrowser = await browserAvailable();
const requireBrowser = process.env.PLINTH_REQUIRE_BROWSER === "1";
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const opts = { skip: hasBrowser || requireBrowser ? false : "no browser (install Chrome or set PLINTH_BROWSER)" };

let server;
let baseUrl;
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "plinth-test-"));
  server = spawn(process.execPath, [fileURLToPath(new URL("./fixture-server.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not start")), 10000);
    server.stdout.on("data", (chunk) => {
      const m = chunk.toString().match(/listening (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
  baseUrl = `http://localhost:${port}`;
});

after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

function runPlinth(args, env = process.env) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: dir, env });
  return { code: res.status, out: res.stdout + res.stderr };
}

// Renders are memoized by name so tests sharing an output stay
// independent: whichever test runs first renders it.
const renders = new Map();
function render(name, args) {
  if (!renders.has(name)) {
    const out = path.join(dir, `${name}.png`);
    const res = runPlinth([...args, "--out", out]);
    renders.set(name, { ...res, out, img: res.code === 0 ? decodePng(readFileSync(out)) : null });
  }
  return renders.get(name);
}
const phone = () => render("phone", [baseUrl, "--device", "iphone-16-pro"]);
const browserShot = () => render("banner", [baseUrl, "--device", "browser"]);

test("a browser is available when PLINTH_REQUIRE_BROWSER=1", { skip: requireBrowser ? false : "PLINTH_REQUIRE_BROWSER not set" }, () => {
  assert.ok(hasBrowser, "no browser could be launched (install Chrome or set PLINTH_BROWSER)");
});

/** Absolute output px for a screen-relative pt coordinate. */
function absPx(device, ptX, ptY) {
  const sr = screenRect(device);
  return [Math.round((PAD + sr.x + ptX) * device.dpr), Math.round((PAD + sr.y + ptY) * device.dpr)];
}

function pixelAt(img, device, ptX, ptY) {
  const [x, y] = absPx(device, ptX, ptY);
  return getPixel(img, x, y);
}

/** Scan a screen-relative pt region for any pixel close to `color`. */
function regionHasColor(img, device, rect, color, tolerance = 20) {
  const [x0, y0] = absPx(device, rect.x, rect.y);
  const [x1, y1] = absPx(device, rect.x + rect.width, rect.y + rect.height);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      if (colorDistance(getPixel(img, x, y), color) <= tolerance) return true;
    }
  }
  return false;
}

test("standalone: DPR-exact safe-area capture, exact dims, all checks pass", opts, () => {
  const res = phone();
  assert.equal(res.code, 0, res.out);
  // 402×778pt content viewport at @3x (874 − 62 top − 34 bottom) [devices.mjs]
  assert.match(res.out, /capture is DPR-exact \(safe-area viewport\) — ok \(1206×2334/);
  assert.match(res.out, /output matches device spec — ok/);
  assert.match(res.out, /frame alignment \(content center pixel\) — ok/);
  assert.match(res.out, /Dynamic Island is solid black at spec position — ok/);
  assert.match(res.out, /home indicator present at spec position — ok/);

  const d = DEVICES["iphone-16-pro"];
  const size = frameSize(d);
  const dims = pngSize(readFileSync(res.out));
  assert.equal(dims.width, Math.round((size.width + 2 * PAD) * d.dpr));
  assert.equal(dims.height, Math.round((size.height + 2 * PAD) * d.dpr));
});

test("fidelity: no page pixels under island, status bar, or home indicator", opts, () => {
  const { img } = phone();
  const d = DEVICES["iphone-16-pro"];
  const cr = contentRect(d, "standalone");

  // Page's top edge marker must start exactly at the content rect, not at y=0.
  const statusRegion = { x: 0, y: 0, width: d.pt.width, height: d.safeTop - 1 };
  assert.ok(!regionHasColor(img, d, statusRegion, MARKER_TOP), "page top marker leaked into the status bar region");
  assert.ok(!regionHasColor(img, d, statusRegion, MARKER_BOTTOM), "page bottom marker leaked into the status bar region");
  assert.ok(
    regionHasColor(img, d, { x: 0, y: cr.y, width: d.pt.width, height: 4 }, MARKER_TOP),
    "page top marker should start exactly at the safe-area top",
  );

  // Bottom band: no page pixels below the content rect.
  const bottomRegion = { x: 0, y: cr.y + cr.height + 1, width: d.pt.width, height: d.safeBottom - 2 };
  assert.ok(!regionHasColor(img, d, bottomRegion, MARKER_BOTTOM), "page bottom marker leaked into the home-indicator region");
  assert.ok(!regionHasColor(img, d, bottomRegion, HERO), "page content leaked into the home-indicator region");

  // Island interior is solid black.
  const isl = d.island;
  for (const dx of [-isl.width / 2 + 6, 0, isl.width / 2 - 6]) {
    const px = pixelAt(img, d, d.pt.width / 2 + dx, isl.y + isl.height / 2);
    assert.ok(colorDistance(px, [0, 0, 0, 255]) <= 8, `island not black at dx=${dx}: ${px}`);
  }

  // Status bar content exists: time glyphs somewhere in the left ear
  // (black or white — auto mode follows the sampled band luminance).
  const earRegion = { x: 20, y: isl.y, width: (d.pt.width - isl.width) / 2 - 40, height: isl.height };
  assert.ok(
    regionHasColor(img, d, earRegion, [255, 255, 255, 255], 30) ||
      regionHasColor(img, d, earRegion, [0, 0, 0, 255], 30),
    "no status-bar time glyphs found",
  );

  // Home indicator: present at spec position, contrasting with the band
  // around it (its light/dark choice follows the sampled band luminance).
  const hi = d.homeIndicator;
  const hiY = d.pt.height - hi.bottomGap - hi.height / 2;
  const hiPx = pixelAt(img, d, d.pt.width / 2, hiY);
  const bandPx = pixelAt(img, d, d.pt.width / 2 - hi.width / 2 - 40, hiY);
  assert.ok(colorDistance(hiPx, bandPx) > 40, `home indicator not visible: ${hiPx} vs band ${bandPx}`);
});

test("safari mode: reduced viewport, compact bottom bar with domain", opts, () => {
  const out = path.join(dir, "safari.png");
  const res = runPlinth([baseUrl, "--device", "iphone-16-pro", "--mode", "safari", "--out", out]);
  assert.equal(res.code, 0, res.out);
  // 874 − 54 status − (50 pill + 34 safe) = 736pt content height @3x
  assert.match(res.out, /capture is DPR-exact \(safe-area viewport\) — ok \(1206×2208/);

  const d = DEVICES["iphone-16-pro"];
  const img = decodePng(readFileSync(out));
  const cr = contentRect(d, "safari");
  // The pill zone must contain non-page pixels (the bar), and no page markers.
  const pillRegion = { x: 12, y: cr.y + cr.height + 2, width: d.pt.width - 24, height: 44 };
  assert.ok(!regionHasColor(img, d, pillRegion, MARKER_BOTTOM), "page leaked under the Safari bar");
  const bandPx = pixelAt(img, d, d.pt.width / 2, cr.y + cr.height + 24);
  const heroPx = pixelAt(img, d, d.pt.width / 2, cr.y + cr.height / 2);
  assert.ok(colorDistance(bandPx, heroPx) > 30, "Safari pill not visible over the band");
});

test("bare mode preserves full-bleed captures", opts, () => {
  const out = path.join(dir, "bare.png");
  const res = runPlinth([baseUrl, "--device", "iphone-16-pro", "--mode", "bare", "--out", out]);
  assert.equal(res.code, 0, res.out);
  // full 874pt height @3x
  assert.match(res.out, /capture is DPR-exact \(safe-area viewport\) — ok \(1206×2622/);
  const d = DEVICES["iphone-16-pro"];
  const img = decodePng(readFileSync(out));
  // In bare mode the top marker legitimately sits at y=0 (under the island).
  assert.ok(regionHasColor(img, d, { x: 0, y: 0, width: d.pt.width, height: 4 }, MARKER_TOP));
});

test("--dark flips the page color scheme", opts, () => {
  const out = path.join(dir, "dark.png");
  const res = runPlinth([baseUrl, "--device", "iphone-16-pro", "--dark", "--out", out]);
  assert.equal(res.code, 0, res.out);
  const d = DEVICES["iphone-16-pro"];
  const img = decodePng(readFileSync(out));
  const cr = contentRect(d, "standalone");
  const px = pixelAt(img, d, d.pt.width / 2, cr.y + cr.height / 2);
  assert.ok(colorDistance(px, [124, 58, 237, 255]) <= 6, `dark-mode hero should be purple, got ${px}`);
});

test("--status override forces status bar content color", opts, () => {
  const out = path.join(dir, "status-dark.png");
  // Red hero (light-ish? auto picks white); force dark content instead.
  const res = runPlinth([baseUrl, "--device", "iphone-16-pro", "--status", "dark", "--out", out]);
  assert.equal(res.code, 0, res.out);
  const d = DEVICES["iphone-16-pro"];
  const img = decodePng(readFileSync(out));
  const earRegion = { x: 20, y: d.island.y, width: (d.pt.width - d.island.width) / 2 - 40, height: d.island.height };
  assert.ok(regionHasColor(img, d, earRegion, [0, 0, 0, 255], 40), "forced dark status content not found");
});

test("--hide removes the cookie banner before capture", opts, () => {
  const d = DEVICES.browser;
  const cr = contentRect(d, "standalone");
  const bannerY = cr.height - 34; // fixed banner: 52px tall, 8px above bottom

  const kept = browserShot();
  assert.equal(kept.code, 0, kept.out);
  const imgKept = kept.img;
  assert.ok(colorDistance(pixelAt(imgKept, d, d.pt.width / 2, bannerY), [250, 204, 21, 255]) <= 8, "banner should be visible");

  const hidden = runPlinth([baseUrl, "--device", "browser", "--hide", "#cookie", "--out", path.join(dir, "nobanner.png")]);
  assert.equal(hidden.code, 0, hidden.out);
  const imgHidden = decodePng(readFileSync(path.join(dir, "nobanner.png")));
  assert.ok(colorDistance(pixelAt(imgHidden, d, d.pt.width / 2, bannerY), HERO) <= 8, "banner should be hidden");
});

test("browser frame has tab strip and toolbar above an exact-size viewport", opts, () => {
  const shot = browserShot();
  assert.equal(shot.code, 0, shot.out);
  const d = DEVICES.browser;
  const img = shot.img;
  const size = frameSize(d);
  const dims = { width: img.width, height: img.height };
  assert.equal(dims.width, (size.width + 2 * PAD) * d.dpr);
  assert.equal(dims.height, (size.height + 2 * PAD) * d.dpr);
  // Chrome rows above the content must not be page pixels.
  const sr = screenRect(d);
  const chromePx = getPixel(img, Math.round((PAD + sr.x + d.pt.width / 2) * d.dpr), Math.round((PAD + 20) * d.dpr));
  assert.ok(colorDistance(chromePx, HERO) > 40, "tab strip missing");
});

test("macbook frame draws menu bar and notch above the content", opts, () => {
  const out = path.join(dir, "mac.png");
  const res = runPlinth([baseUrl, "--device", "macbook-14", "--out", out]);
  assert.equal(res.code, 0, res.out);
  const d = DEVICES["macbook-14"];
  // content viewport = 1512×945 @2x (982 − 37 menu bar) [BJANGO]
  assert.match(res.out, /ok \(3024×1890/);
  const img = decodePng(readFileSync(out));
  // Notch: black at top center within the menu bar.
  const notchPx = pixelAt(img, d, d.pt.width / 2, d.notch.height / 2);
  assert.ok(colorDistance(notchPx, [0, 0, 0, 255]) <= 8, `notch not black: ${notchPx}`);
  // Menu bar next to the notch is not page content.
  const barPx = pixelAt(img, d, d.pt.width / 2 - d.notch.width, d.menuBar / 2);
  assert.ok(colorDistance(barPx, HERO) > 40, "menu bar missing");
  // Page top marker starts below the menu bar.
  assert.ok(regionHasColor(img, d, { x: 0, y: d.menuBar, width: d.pt.width, height: 4 }, MARKER_TOP));
  assert.ok(!regionHasColor(img, d, { x: 0, y: 0, width: d.pt.width, height: d.menuBar - 1 }, MARKER_TOP));
});

test("multi-device row has deterministic @2x dimensions", opts, () => {
  const out = path.join(dir, "multi.png");
  const res = runPlinth([baseUrl, "--devices", "iphone-16-pro,macbook-14", "--out", out]);
  assert.equal(res.code, 0, res.out);
  const a = frameSize(DEVICES["iphone-16-pro"]);
  const b = frameSize(DEVICES["macbook-14"]);
  const GAP = 56, DPR = 2;
  const dims = pngSize(readFileSync(out));
  assert.equal(dims.width, (PAD * 2 + a.width + GAP + b.width) * DPR);
  assert.equal(dims.height, (PAD * 2 + Math.max(a.height, b.height)) * DPR);
});

test("fractional DPR device (pixel-8 @2.625) is captured and verified", opts, () => {
  const res = runPlinth([baseUrl, "--device", "pixel-8", "--out", path.join(dir, "pixel.png")]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /capture is DPR-exact \(safe-area viewport\) — ok/);
});

test("--scroll writes a playable mp4 of the full page", { skip: opts.skip || (hasFfmpeg ? false : "ffmpeg not installed") }, () => {
  const out = path.join(dir, "scroll.mp4");
  const res = runPlinth([baseUrl, "--device", "iphone-16-pro", "--scroll", "--out", out]);
  assert.equal(res.code, 0, res.out);
  assert.ok(existsSync(out));
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", out,
  ], { encoding: "utf8" });
  const [w, h, frames] = probe.stdout.trim().split(",").map(Number);
  assert.ok(w > 700 && h > 1400, `unexpected video dims ${w}×${h}`);
  assert.ok(frames >= 60, `expected >=60 frames, got ${frames}`);
});

test("unknown device is a usage error listing devices", () => {
  const res = runPlinth(["http://localhost:1", "--device", "iphone-3g"]);
  assert.equal(res.code, 2);
  assert.match(res.out, /unknown device/);
  assert.match(res.out, /iphone-16-pro/);
});

test("png decoder round-trips Chromium output", opts, () => {
  const { out } = phone();
  const img = decodePng(readFileSync(out));
  assert.equal(img.width, pngSize(readFileSync(out)).width);
  assert.equal(getPixel(img, 0, 0).length, 4);
});
