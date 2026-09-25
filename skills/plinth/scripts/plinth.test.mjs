import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEVICES, frameSize, screenRect, contentRect } from "./devices.mjs";
import { decodePng, getPixel, pngSize, colorDistance } from "./png.mjs";
import { browserAvailable, withBrowser } from "./capture.mjs";
import { contentMismatch, chromePresence, MAX_MISMATCH, MIN_CHROME } from "./verify.mjs";

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
const probeLogs = [];

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "plinth-test-"));
  server = spawn(process.execPath, [fileURLToPath(new URL("./fixture-server.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not start")), 10000);
    server.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.startsWith("log ")) probeLogs.push(JSON.parse(line.slice(4)));
      }
      const m = text.match(/listening (\d+)/);
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
    const file = path.join(dir, `${name}.png`);
    const res = runPlinth([...args, "--out", file]);
    renders.set(name, { ...res, file, img: res.code === 0 ? decodePng(readFileSync(file)) : null });
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
  const dims = pngSize(readFileSync(res.file));
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
  const { file } = phone();
  const img = decodePng(readFileSync(file));
  assert.equal(img.width, pngSize(readFileSync(file)).width);
  assert.equal(getPixel(img, 0, 0).length, 4);
});

/** Pixels differing by more than `tol` within frame-relative pt columns [x0, x1). */
function diffColumns(a, b, device, x0, x1, tol = 2) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let diff = 0;
  const px0 = Math.round((PAD + x0) * device.dpr), px1 = Math.round((PAD + x1) * device.dpr);
  for (let y = 0; y < a.height; y++) {
    for (let x = px0; x < px1; x++) {
      if (colorDistance(getPixel(a, x, y), getPixel(b, x, y)) > tol) diff++;
    }
  }
  return diff;
}

test("--buttons adds buttons without moving the frame, screen, or chrome", opts, () => {
  const d = DEVICES["iphone-16-pro"];
  const plain = render("flat", [baseUrl, "--device", "iphone-16-pro", "--no-shadow"]);
  const btn = render("flat-buttons", [baseUrl, "--device", "iphone-16-pro", "--no-shadow", "--buttons"]);
  assert.equal(btn.code, 0, btn.out);
  const w = frameSize(d).width;
  // Buttons sit outside x∈[1, w−1]; everything inside must be identical.
  assert.equal(diffColumns(plain.img, btn.img, d, 1, w - 1), 0, "frame geometry changed with --buttons");
  assert.ok(diffColumns(plain.img, btn.img, d, -3, 1) > 0, "left buttons missing");
});

test("--buttons on Pixel draws right-side buttons only", opts, () => {
  const d = DEVICES["pixel-8"];
  const plain = render("pixel-flat", [baseUrl, "--device", "pixel-8", "--no-shadow"]);
  const btn = render("pixel-flat-buttons", [baseUrl, "--device", "pixel-8", "--no-shadow", "--buttons"]);
  assert.equal(btn.code, 0, btn.out);
  const w = frameSize(d).width;
  assert.equal(diffColumns(plain.img, btn.img, d, -3, w - 1), 0, "left side or frame changed");
  assert.ok(diffColumns(plain.img, btn.img, d, w - 1, w + 3) > 0, "right-side buttons missing");
});

async function probe(device) {
  const res = runPlinth([`${baseUrl}/probe?${device}`, "--device", device, "--wait", "300", "--out", path.join(dir, `probe-${device}.png`)]);
  assert.equal(res.code, 0, res.out);
  // The beacon lands on the server's stdout asynchronously.
  for (let i = 0; i < 50 && !probeLogs.some((l) => l.tag === device); i++) await new Promise((r) => setTimeout(r, 100));
  const log = probeLogs.find((l) => l.tag === device);
  assert.ok(log, `no probe report for ${device}`);
  return { ...log, out: res.out };
}

test("phones capture as a touch device with a mobile UA, at exact device width", opts, async () => {
  const iphone = await probe("iphone-16-pro");
  assert.match(iphone.ua, /\(iPhone; CPU iPhone OS [\d_]+ like Mac OS X\).* Mobile\/\w+ Safari\//);
  assert.equal(iphone.coarse, "true");
  assert.ok(Number(iphone.touchPoints) > 0);
  // No viewport meta on the probe page: layout still at the device width.
  assert.equal(iphone.width, "402");
  assert.match(iphone.out, /capture is DPR-exact \(safe-area viewport\) — ok/);

  const pixel = await probe("pixel-8");
  assert.match(pixel.ua, /\(Linux; Android [^)]*\).* Chrome\/\d+\.0\.0\.0 Mobile Safari\//);
  assert.equal(pixel.coarse, "true");
});

test("desktop frames present the browser's own Chrome version, not a headless or stale one", opts, async () => {
  const major = await withBrowser(async (b) => b.version().split(".")[0]);
  const desktop = await probe("browser");
  assert.doesNotMatch(desktop.ua, /Headless|Mobile/);
  assert.match(desktop.ua, new RegExp(`Chrome/${major}\\.0\\.0\\.0 Safari/`));
  assert.equal(desktop.coarse, "false");
});

test("--hide works on pages with a strict Content-Security-Policy", opts, () => {
  const d = DEVICES.browser;
  const res = runPlinth([`${baseUrl}/csp`, "--device", "browser", "--hide", "#cookie", "--out", path.join(dir, "csp.png")]);
  assert.equal(res.code, 0, res.out);
  const img = decodePng(readFileSync(path.join(dir, "csp.png")));
  const bannerY = contentRect(d, "standalone").height - 34;
  assert.ok(colorDistance(pixelAt(img, d, d.pt.width / 2, bannerY), HERO) <= 8, "banner should be hidden");
});

/** null when equal, else a description of where the images differ. */
function imageDiff(a, b, tol = 2) {
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}×${a.height} vs ${b.width}×${b.height}`;
  let n = 0, box = [Infinity, Infinity, 0, 0];
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (colorDistance(getPixel(a, x, y), getPixel(b, x, y)) <= tol) continue;
      n++;
      box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    }
  }
  return n ? `${n} px differ in box ${box.join(",")}` : null;
}

test("chrome shows only the host: no credentials, query, or fragment", opts, () => {
  const plain = render("safari-plain", [baseUrl, "--device", "iphone-16-pro", "--mode", "safari"]);
  const port = new URL(baseUrl).port;
  const noisy = render("safari-noisy", [`http://user:s3cret@localhost:${port}/?token=abc#frag`, "--device", "iphone-16-pro", "--mode", "safari"]);
  assert.equal(noisy.code, 0, noisy.out);
  assert.equal(imageDiff(plain.img, noisy.img), null, "Safari pill shows more than the host");
});

test("URL text cannot inject markup into the frame", opts, () => {
  const plain = browserShot();
  const injected = render("injected", [`${baseUrl}/#<i style="position:fixed;inset:0;background:lime"></i>`, "--device", "browser"]);
  assert.equal(injected.code, 0, injected.out);
  assert.equal(imageDiff(plain.img, injected.img), null, "URL fragment changed the rendered chrome");
});

test("--bg accepts presets and CSS colors, rejects unknown names and markup", opts, () => {
  const ok = render("bg-hex", [baseUrl, "--device", "iphone-16-pro", "--bg", "#123456"]);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(getPixel(ok.img, 2, 2), [0x12, 0x34, 0x56, 255]);

  const typo = runPlinth([baseUrl, "--bg", "studo", "--out", path.join(dir, "bg-typo.png")]);
  assert.equal(typo.code, 2, typo.out);
  assert.match(typo.out, /--bg/);
  assert.ok(!existsSync(path.join(dir, "bg-typo.png")));

  const markup = runPlinth([baseUrl, "--bg", "red;}</style><h1>x</h1><style>", "--out", path.join(dir, "bg-inj.png")]);
  assert.equal(markup.code, 2, markup.out);
});

test("usage errors exit 2 before any capture", async () => {
  const cases = [
    ["--padding", "abc"], ["--padding", "-10"], ["--wait", "soon"],
    ["--device", "pixel-8", "--mode", "safari"], ["--device", "ipad-pro-11", "--mode", "safari"],
    ["--device", "macbook-14", "--mode", "bare"],
    ["--out", "shot.jpg"], ["--scroll", "--out", "demo.png"], ["--scroll", "--out", "demo.webm"],
    ["--scroll", "--devices", "iphone-16-pro,pixel-8"],
  ];
  for (const args of cases) {
    const res = runPlinth([baseUrl, ...args]);
    assert.equal(res.code, 2, `${args.join(" ")} → ${res.out}`);
    assert.doesNotMatch(res.out, /capturing/, `${args.join(" ")} started a capture`);
  }
});

test("scheme-less URLs use http for loopback hosts, https otherwise", async () => {
  const { normalizeUrl } = await import("./plinth.mjs");
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("127.0.0.1:8080/app"), "http://127.0.0.1:8080/app");
  assert.equal(normalizeUrl("[::1]:5173"), "http://[::1]:5173/");
  assert.equal(normalizeUrl("0.0.0.0:4000"), "http://0.0.0.0:4000/");
  assert.equal(normalizeUrl("example.com/x"), "https://example.com/x");
  assert.equal(normalizeUrl("HTTP://Example.com"), "http://example.com/");
});

test("a scheme-less localhost URL captures over http", opts, () => {
  const res = runPlinth([`localhost:${new URL(baseUrl).port}`, "--device", "browser", "--out", path.join(dir, "schemeless.png")]);
  assert.equal(res.code, 0, res.out);
});

test("runtime failures exit 3 with a one-line message", opts, () => {
  const nav = runPlinth(["http://127.0.0.1:1", "--out", path.join(dir, "nav.png")]);
  assert.equal(nav.code, 3, nav.out);
  assert.match(nav.out, /plinth: page\.goto: net::ERR_/);
  assert.doesNotMatch(nav.out, /Call log/);

  const browser = runPlinth([baseUrl, "--out", path.join(dir, "nobrowser.png")], { ...process.env, PLINTH_BROWSER: "/nonexistent/chrome" });
  assert.equal(browser.code, 3, browser.out);
  assert.match(browser.out, /could not launch Chrome/);

  const noFfmpeg = runPlinth([baseUrl, "--scroll", "--out", path.join(dir, "noff.mp4")], { ...process.env, PATH: "/nonexistent" });
  assert.equal(noFfmpeg.code, 3, noFfmpeg.out);
  assert.match(noFfmpeg.out, /needs ffmpeg/);
  assert.doesNotMatch(noFfmpeg.out, /node:events|at .*\(/);
});

/** Copy of a decoded image's pt rect (frame-relative, PAD included). */
function cropPt(img, device, x, y, w, h) {
  const px = (v) => Math.round((PAD + v) * device.dpr);
  const [x0, y0, width, height] = [px(x), px(y), Math.round(w * device.dpr), Math.round(h * device.dpr)];
  const pixels = Buffer.alloc(width * height * img.channels);
  for (let row = 0; row < height; row++) {
    const from = ((y0 + row) * img.width + x0) * img.channels;
    img.pixels.copy(pixels, row * width * img.channels, from, from + width * img.channels);
  }
  return { width, height, channels: img.channels, pixels };
}

function mutated(img, fn) {
  const copy = { ...img, pixels: Buffer.from(img.pixels) };
  fn(copy);
  return copy;
}

test("checks catch shifted content and missing chrome that dimension checks miss", opts, () => {
  const d = DEVICES["iphone-16-pro"];
  const { img } = phone();
  const sr = screenRect(d), cr = contentRect(d, "standalone");
  const capture = cropPt(img, d, sr.x + cr.x, sr.y + cr.y, cr.width, cr.height);
  const bands = { top: getPixel(img, ...absPx(d, d.pt.width / 2, 2)), bottom: getPixel(img, ...absPx(d, 20, d.pt.height - 20)) };
  assert.equal(contentMismatch(img, capture, d, "standalone", PAD).bad, 0);
  assert.ok(chromePresence(img, d, "standalone", PAD, bands).every((r) => r.fraction >= MIN_CHROME));

  // Content drawn 30pt low (the audit's M1 mutation): rows move down.
  const rowBytes = img.width * img.channels;
  const [, top] = absPx(d, 0, cr.y), [, bottom] = absPx(d, 0, cr.y + cr.height);
  const shift = 30 * d.dpr;
  const shifted = mutated(img, (m) => img.pixels.copy(m.pixels, (top + shift) * rowBytes, top * rowBytes, (bottom - shift) * rowBytes));
  assert.ok(contentMismatch(shifted, capture, d, "standalone", PAD).fraction > MAX_MISMATCH, "30pt shift not detected");

  // Chrome wiped to the flat band (the audit's markup-injection result).
  const [, statusEnd] = absPx(d, 0, cr.y);
  const [bandX, bandY] = absPx(d, d.pt.width / 2, 2);
  const wiped = mutated(img, (m) => {
    for (let y = absPx(d, 0, 0)[1]; y < statusEnd; y++) {
      for (let x = absPx(d, 0, 0)[0]; x < absPx(d, d.pt.width, 0)[0]; x++) {
        img.pixels.copy(m.pixels, (y * img.width + x) * img.channels, (bandY * img.width + bandX) * img.channels, (bandY * img.width + bandX + 1) * img.channels);
      }
    }
  });
  const status = chromePresence(wiped, d, "standalone", PAD, bands).find((r) => r.name === "status bar");
  assert.ok(status.fraction < MIN_CHROME, "wiped status bar not detected");
});
