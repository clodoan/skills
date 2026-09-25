import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEVICES, frameSize, screenRect } from "./devices.mjs";
import { decodePng, getPixel, pngSize, colorDistance } from "./png.mjs";

const CLI = fileURLToPath(new URL("./plinth.mjs", import.meta.url));

const hasChrome =
  spawnSync("google-chrome", ["--version"], { stdio: "ignore" }).status === 0 ||
  spawnSync("google-chrome-stable", ["--version"], { stdio: "ignore" }).status === 0 ||
  Boolean(process.env.PLINTH_BROWSER);
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const opts = { skip: hasChrome ? false : "Chrome not installed" };

// The fixture server runs as a child process: spawnSync (used to run the
// CLI) blocks this process's event loop, so an in-process server would
// never answer Chrome's requests.
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

function runPlinth(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: dir });
  return { code: res.status, out: res.stdout + res.stderr };
}

function screenPixel(outFile, deviceId, relX, relY, padding = 48) {
  const device = DEVICES[deviceId];
  const rect = screenRect(device);
  const img = decodePng(readFileSync(outFile));
  const x = Math.round((padding + rect.x + rect.width * relX) * device.dpr);
  const y = Math.round((padding + rect.y + rect.height * relY) * device.dpr);
  return getPixel(img, x, y);
}

test("single device: DPR-exact capture, exact output dims, alignment checks pass", opts, () => {
  const out = path.join(dir, "phone.png");
  const res = runPlinth([baseUrl, "--device", "iphone-15-pro", "--out", out]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /capture is DPR-exact — ok \(1179×2556/);
  assert.match(res.out, /output matches device spec — ok/);
  assert.match(res.out, /frame alignment \(center pixel\) — ok/);

  const device = DEVICES["iphone-15-pro"];
  const size = frameSize(device);
  const dims = pngSize(readFileSync(out));
  assert.equal(dims.width, Math.round((size.width + 96) * device.dpr));
  assert.equal(dims.height, Math.round((size.height + 96) * device.dpr));

  // Hero red at screen center; frame body (near-black) just outside the screen.
  assert.ok(colorDistance(screenPixel(out, "iphone-15-pro", 0.5, 0.5), [225, 29, 72, 255]) <= 6);
});

test("--dark flips the page color scheme", opts, () => {
  const out = path.join(dir, "dark.png");
  const res = runPlinth([baseUrl, "--device", "iphone-15-pro", "--dark", "--out", out]);
  assert.equal(res.code, 0, res.out);
  assert.ok(
    colorDistance(screenPixel(out, "iphone-15-pro", 0.5, 0.5), [124, 58, 237, 255]) <= 6,
    "dark-mode hero should be purple #7c3aed",
  );
});

test("--hide removes the cookie banner before capture", opts, () => {
  const kept = runPlinth([baseUrl, "--device", "browser", "--out", path.join(dir, "banner.png")]);
  assert.equal(kept.code, 0, kept.out);
  const bannerPx = screenPixel(path.join(dir, "banner.png"), "browser", 0.5, 0.98);
  assert.ok(colorDistance(bannerPx, [250, 204, 21, 255]) <= 6, `banner should be visible, got ${bannerPx}`);

  const hidden = runPlinth([baseUrl, "--device", "browser", "--hide", "#cookie", "--out", path.join(dir, "nobanner.png")]);
  assert.equal(hidden.code, 0, hidden.out);
  const px = screenPixel(path.join(dir, "nobanner.png"), "browser", 0.5, 0.98);
  assert.ok(colorDistance(px, [225, 29, 72, 255]) <= 6, `banner should be hidden, got ${px}`);
});

test("multi-device row has deterministic @2x dimensions", opts, () => {
  const out = path.join(dir, "multi.png");
  const res = runPlinth([baseUrl, "--devices", "iphone-15-pro,macbook-14", "--out", out]);
  assert.equal(res.code, 0, res.out);
  const a = frameSize(DEVICES["iphone-15-pro"]);
  const b = frameSize(DEVICES["macbook-14"]);
  const GAP = 56, PAD = 48, DPR = 2;
  const dims = pngSize(readFileSync(out));
  assert.equal(dims.width, (PAD * 2 + a.width + GAP + b.width) * DPR);
  assert.equal(dims.height, (PAD * 2 + Math.max(a.height, b.height)) * DPR);
});

test("fractional DPR device (pixel-8 @2.625) is captured and verified", opts, () => {
  const res = runPlinth([baseUrl, "--device", "pixel-8", "--out", path.join(dir, "pixel.png")]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /capture is DPR-exact — ok/);
});

test("--scroll writes a playable mp4 of the full page", { skip: opts.skip || (hasFfmpeg ? false : "ffmpeg not installed") }, () => {
  const out = path.join(dir, "scroll.mp4");
  const res = runPlinth([baseUrl, "--device", "iphone-15-pro", "--scroll", "--out", out]);
  assert.equal(res.code, 0, res.out);
  assert.ok(existsSync(out));
  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", out,
  ], { encoding: "utf8" });
  const [w, h, frames] = probe.stdout.trim().split(",").map(Number);
  assert.ok(w > 800 && h > 1600, `unexpected video dims ${w}×${h}`);
  assert.ok(frames >= 60, `expected >=60 frames, got ${frames}`);
});

test("unknown device is a usage error listing devices", () => {
  const res = runPlinth(["http://localhost:1", "--device", "iphone-3g"]);
  assert.equal(res.code, 2);
  assert.match(res.out, /unknown device/);
  assert.match(res.out, /iphone-15-pro/);
});

test("png decoder round-trips Chromium output", opts, () => {
  const out = path.join(dir, "phone.png"); // written by the first test
  const img = decodePng(readFileSync(out));
  assert.equal(img.width, pngSize(readFileSync(out)).width);
  const px = getPixel(img, 0, 0);
  assert.equal(px.length, 4);
});
