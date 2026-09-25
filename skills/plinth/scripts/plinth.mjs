#!/usr/bin/env node
/**
 * plinth — DPR-correct screenshots composited into spec-accurate device
 * frames.
 *
 * Captures a URL at the device's *safe-area* viewport (so page content
 * never sits under the Dynamic Island, status bar, or home indicator),
 * draws faithful chrome (iOS status bar with 9:41/cellular/wifi/battery,
 * island, home indicator; Android status bar; macOS menu bar + notch;
 * Chromium-style browser window), and composites at the device's native
 * DPR. Verifies its own output: capture dimensions, output dimensions,
 * frame alignment, island blackness, and home-indicator presence — all
 * by decoding real pixels. Device geometry is cited in devices.mjs.
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEVICES, BACKGROUNDS, deviceList, frameSize, screenRect, contentRect,
  buildDeviceHtml,
} from "./devices.mjs";
import { withBrowser, capture } from "./capture.mjs";
import { pngSize, decodePng, getPixel } from "./png.mjs";
import {
  contentMismatch, chromePresence, expectedOutputSize, MAX_MISMATCH, MIN_CHROME,
} from "./verify.mjs";

const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_CHECK = 1;
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 3;

const GAP = 56; // pt between frames in multi-device layouts
const MULTI_DPR = 2;

export class UsageError extends Error {}

function usage() {
  return `Usage: plinth <url> [options]

Captures <url> at an exact device viewport (safe-area aware) and
composites it into a spec-accurate device frame with faithful chrome.

Options:
  --device <id>       Device frame (default: iphone-16-pro)
  --devices <a,b,c>   Multi-device row layout (composited at @2x)
  --mode <m>          Phone/tablet presentation: standalone (app-style,
                      status bar + home indicator, default) | safari
                      (iPhone only: mobile Safari with compact bottom
                      bar) | bare (phones/tablets: full-bleed, content
                      under everything)
  --status <s>        Status bar content: auto (from page luminance,
                      default) | light | dark
  --buttons           Draw side buttons on phone frames
  --out <file>        Output .png (default: plinth-<device>.png, or
                      plinth-multi.png); with --scroll .mp4 or .gif
                      (default: plinth-<device>-scroll.mp4)
  --bg <value>        Background: ${Object.keys(BACKGROUNDS).join(" | ")} or a CSS
                      color/gradient
  --padding <px>      Padding around the frame (default 48)
  --no-shadow         Disable the drop shadow
  --dark              Dark color scheme for the page + dark background
  --frame <theme>     Frame theme: dark | light (default dark)
  --hide <sel,sel>    CSS selectors to hide before capture (cookie banners)
  --wait <ms>         Extra settle time after load (default 800)
  --scroll            Scrolled capture of the full page → mp4/gif (ffmpeg)
  -h, --help          Show this help

Devices:
${deviceList()}

Exit codes: 0 ok, 1 a verification check failed, 2 usage error,
3 runtime error (navigation, browser, ffmpeg).`;
}

/** Scheme-less URLs: http for loopback dev servers, https otherwise. */
export function normalizeUrl(raw) {
  let url = raw;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) {
    const host = url.split(/[/?#]/)[0].replace(/:\d+$/, "").toLowerCase();
    const loopback = ["localhost", "0.0.0.0", "[::1]"].includes(host) || /^127(\.\d{1,3}){3}$/.test(host);
    url = `${loopback ? "http" : "https"}://${url}`;
  }
  try {
    return new URL(url).href;
  } catch {
    throw new UsageError(`not a valid URL: ${raw}`);
  }
}

function nonNegative(flag, value) {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a non-negative number`);
  return n;
}

export function parseArgs(argv) {
  const opts = {
    url: null, device: "iphone-16-pro", devices: null, out: null,
    mode: "standalone", status: "auto", buttons: false,
    bg: null, padding: 48, shadow: true, dark: false, frame: "dark",
    hide: [], wait: 800, scroll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--device": opts.device = next(); break;
      case "--devices": opts.devices = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--mode": opts.mode = next(); break;
      case "--status": opts.status = next(); break;
      case "--buttons": opts.buttons = true; break;
      case "--out": opts.out = next(); break;
      case "--bg": opts.bg = next(); break;
      case "--padding": opts.padding = nonNegative(arg, next()); break;
      case "--no-shadow": opts.shadow = false; break;
      case "--dark": opts.dark = true; break;
      case "--frame": opts.frame = next(); break;
      case "--hide": opts.hide = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--wait": opts.wait = nonNegative(arg, next()); break;
      case "--scroll": opts.scroll = true; break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(EXIT_OK);
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
        if (opts.url) throw new UsageError("only one URL is supported");
        opts.url = arg;
    }
  }
  if (!opts.url) throw new UsageError("missing URL");
  opts.url = normalizeUrl(opts.url);
  const ids = opts.devices ?? [opts.device];
  if (!["standalone", "safari", "bare"].includes(opts.mode)) {
    throw new UsageError("--mode must be standalone, safari, or bare");
  }
  for (const id of ids) {
    const d = DEVICES[id];
    if (!d) throw new UsageError(`unknown device "${id}"\n\nDevices:\n${deviceList()}`);
    if (opts.mode === "safari" && !(d.kind === "phone" && d.os === "ios")) {
      throw new UsageError(`--mode safari is iPhone-only (not ${id})`);
    }
    if (opts.mode === "bare" && d.kind !== "phone" && d.kind !== "tablet") {
      throw new UsageError(`--mode bare applies to phones and tablets (not ${id})`);
    }
  }
  opts.deviceIds = ids;
  if (opts.scroll && ids.length > 1) throw new UsageError("--scroll works with a single --device");
  const ext = opts.out === null ? null : path.extname(opts.out).toLowerCase();
  if (opts.scroll && ext !== null && ext !== ".mp4" && ext !== ".gif") throw new UsageError("--scroll output must be .mp4 or .gif");
  if (!opts.scroll && ext !== null && ext !== ".png") throw new UsageError("output must be .png (use --scroll for .mp4/.gif)");
  if (!["auto", "light", "dark"].includes(opts.status)) {
    throw new UsageError("--status must be auto, light, or dark");
  }
  if (!(opts.frame in { dark: 1, light: 1 })) throw new UsageError("--frame must be dark or light");
  if (opts.bg !== null && BG_UNSAFE.test(opts.bg)) throw new UsageError("--bg must be a preset or a CSS color/gradient");
  return opts;
}

function background(opts) {
  if (opts.bg) return BACKGROUNDS[opts.bg] ?? opts.bg;
  return opts.dark ? BACKGROUNDS["studio-dark"] : BACKGROUNDS.studio;
}

/** What browser chrome shows: host only — never credentials, path, or query. */
function displayHost(url) {
  const u = new URL(url);
  return u.host || u.pathname.split("/").pop() || u.protocol;
}

// --bg is pasted into a CSS declaration: reject anything that could end
// it, then (once a browser is up) anything the browser can't parse.
const BG_UNSAFE = /[<>{};\\]|\/\*/;
async function validateBackground(browser, opts) {
  if (!opts.bg || opts.bg in BACKGROUNDS) return;
  const page = await browser.newPage();
  try {
    if (await page.evaluate((v) => CSS.supports("background", v), opts.bg)) return;
  } finally {
    await page.close();
  }
  throw new UsageError(`--bg "${opts.bg}" is neither a preset (${Object.keys(BACKGROUNDS).join(", ")}) nor a CSS background`);
}

// Inter is embedded for the status bar / chrome text: SF Pro cannot be
// redistributed, and Inter is the closest freely-licensed metric match.
// Falls back to the system stack silently if @fontsource/inter is absent.
function fontFaces() {
  const faces = [];
  for (const weight of [400, 500, 600]) {
    try {
      const file = require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff2`);
      const b64 = readFileSync(file).toString("base64");
      faces.push(`@font-face { font-family: Inter; font-weight: ${weight};
        src: url(data:font/woff2;base64,${b64}) format("woff2"); }`);
    } catch {
      // documented fallback: system sans
    }
  }
  return faces.join("\n");
}

function stageHtml(frames, opts) {
  const shadow = opts.shadow
    ? "filter: drop-shadow(0 18px 38px rgba(0,0,0,0.28)) drop-shadow(0 4px 10px rgba(0,0,0,0.18));"
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fontFaces()}
    * { margin: 0; }
    #stage { display: inline-flex; align-items: center; gap: ${GAP}px;
             padding: ${opts.padding}px; background: ${background(opts)}; }
    #stage > .frame { ${shadow} flex: none; }
    img { image-rendering: -webkit-optimize-contrast; }
  </style></head><body><div id="stage">${frames.join("\n")}</div></body></html>`;
}

/**
 * Most common color of a horizontal strip (5-bit buckets, averaged within
 * the winner) + relative luminance. An average invents colors the page
 * never shows (black|white header → grey band).
 */
function stripStats(img, fromY, toY) {
  const buckets = new Map();
  const step = Math.max(1, Math.floor(img.width / 64));
  for (let y = fromY; y < toY; y++) {
    for (let x = 0; x < img.width; x += step) {
      const [r, g, b] = getPixel(img, x, y);
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b;
      buckets.set(key, bucket);
    }
  }
  let best = null;
  for (const bucket of buckets.values()) if (!best || bucket.n > best.n) best = bucket;
  const [r, g, b] = [best.r, best.g, best.b].map((v) => Math.round(v / best.n));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { color: `rgb(${r},${g},${b})`, rgb: [r, g, b, 255], lum };
}

/** Band colors from the capture's first `screenH` px rows (the viewport). */
function analyzeCapture(buffer, screenH) {
  const img = decodePng(buffer);
  const bottom = Math.min(img.height, screenH ?? img.height);
  const strip = Math.max(4, Math.round(bottom * 0.01));
  return {
    top: stripStats(img, 0, strip),
    bottom: stripStats(img, bottom - strip, bottom),
    img,
  };
}

function chromeColors(analysis, opts) {
  const statusColor =
    opts.status === "light" ? "#ffffff"
    : opts.status === "dark" ? "#000000"
    : analysis.top.lum < 0.5 ? "#ffffff" : "#000000";
  const indicatorColor = analysis.bottom.lum < 0.5 ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.85)";
  return { statusColor, indicatorColor };
}

function deviceHtmlFor(device, shot, analysis, opts, contentHtmlOverride) {
  const cr = contentRect(device, opts.mode);
  const { statusColor, indicatorColor } = chromeColors(analysis, opts);
  const contentHtml = contentHtmlOverride ??
    `<img src="data:image/png;base64,${shot.buffer.toString("base64")}"
      style="position:absolute;left:${cr.x}px;top:${cr.y}px;width:${cr.width}px;height:${cr.height}px;display:block" alt=""/>`;
  return buildDeviceHtml(device, {
    contentHtml,
    bandColor: analysis.top.color,
    bottomColor: analysis.bottom.color,
    statusColor,
    indicatorColor,
    domain: displayHost(opts.url),
    frameTheme: opts.frame,
    buttons: opts.buttons,
    mode: opts.mode,
  });
}

/** Loads stage HTML sized to fit; caller closes `context`. */
async function openStage(browser, html, dpr) {
  const context = await browser.newContext({ viewport: { width: 300, height: 300 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  const stage = page.locator("#stage");
  const box = await stage.boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width) + 10, height: Math.ceil(box.height) + 10 });
  return { context, page, stage };
}

async function composite(browser, html, dpr) {
  const { context, stage } = await openStage(browser, html, dpr);
  try {
    return await stage.screenshot({ type: "png", omitBackground: true });
  } finally {
    await context.close();
  }
}

function check(name, ok, detail) {
  console.log(`  check: ${name} — ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  return ok;
}

/**
 * Prints check lines; true when all pass. `capture` is the decoded page
 * capture (taller than the content rect for scroll frame 0).
 */
function verifyOutput({ output, capture, device, opts, analysis }) {
  const want = expectedOutputSize(device, opts.padding);
  let ok = check(
    "output matches device spec",
    Math.abs(output.width - want.width) <= 1 && Math.abs(output.height - want.height) <= 1,
    `${output.width}×${output.height} vs expected ${want.width}×${want.height}`,
  );
  const content = contentMismatch(output, capture, device, opts.mode, opts.padding);
  ok = check(
    "content matches the capture pixel-for-pixel",
    content.fraction <= MAX_MISMATCH,
    `${content.bad}/${content.total} samples differ`,
  ) && ok;
  const bands = { top: analysis.top.rgb, bottom: analysis.bottom.rgb };
  for (const region of chromePresence(output, device, opts.mode, opts.padding, bands)) {
    ok = check(
      `${region.name} drawn`,
      region.fraction >= MIN_CHROME,
      `${(region.fraction * 100).toFixed(1)}% of samples unlike the band`,
    ) && ok;
  }
  return ok;
}

function verifySingle({ shot, out, device, opts, analysis }) {
  const cr = contentRect(device, opts.mode);
  const w = Math.round(cr.width * device.dpr), h = Math.round(cr.height * device.dpr);
  const ok = check(
    "capture is DPR-exact (safe-area viewport)",
    shot.pxWidth === w && shot.pxHeight === h,
    `${shot.pxWidth}×${shot.pxHeight} vs spec ${w}×${h}`,
  );
  return verifyOutput({ output: decodePng(out), capture: analysis.img, device, opts, analysis }) && ok;
}

/**
 * Moves the temp output into place: `out` when checks passed, otherwise
 * `<name>.failed<ext>` beside it so a failed image is never mistaken for
 * a good one. Returns the final path.
 */
export function finalizeOutput(tmp, out, ok) {
  const ext = path.extname(out);
  const dest = ok ? out : `${out.slice(0, out.length - ext.length)}.failed${ext}`;
  renameSync(tmp, dest);
  return dest;
}

/** Streams PNG frames into ffmpeg; rejects (never crashes) if it fails. */
async function encode(frames, outFile, fps) {
  const vf = path.extname(outFile) === ".gif"
    ? ["-filter_complex", "scale=trunc(iw/4)*2:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse"]
    : ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22"];
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", ...vf, outFile], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let failure = null;
  ff.stderr.on("data", (chunk) => { stderr += chunk; });
  ff.stdin.on("error", (err) => { failure ??= err; });
  const done = new Promise((resolve) => {
    ff.on("error", (err) => { failure ??= err; resolve(); });
    ff.on("close", (code) => { if (code !== 0) failure ??= new Error(`exited ${code}`); resolve(); });
  });
  try {
    for await (const frame of frames) {
      if (failure) break;
      if (!ff.stdin.write(frame)) await Promise.race([once(ff.stdin, "drain"), done]);
    }
  } finally {
    ff.stdin.end();
  }
  await done;
  if (failure) throw new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() || failure.message}`);
}

/**
 * Full-page capture scrolled inside the frame → mp4/gif. The page is
 * captured once and slid upward, so sticky/fixed elements scroll with
 * the content (they are not re-pinned per frame). Frame 0 is verified.
 */
async function renderScroll(browser, opts, device, outFile) {
  const cr = contentRect(device, opts.mode);
  console.log(`plinth · capturing ${opts.url} as ${device.label} full page (scroll)`);
  const shot = await capture(browser, opts.url, {
    device, viewport: { width: cr.width, height: cr.height }, dpr: device.dpr,
    dark: opts.dark, hide: opts.hide, waitMs: opts.wait, fullPage: true,
  });
  // Bands come from the first screen: that is what frame 0 shows.
  const analysis = analyzeCapture(shot.buffer, Math.round(cr.height * device.dpr));
  const fullCssH = shot.pxHeight / device.dpr;
  const fps = 30;
  const seconds = Math.min(8, Math.max(2, (fullCssH - cr.height) / 400));
  const steps = Math.round(fps * seconds);

  const src = `data:image/png;base64,${shot.buffer.toString("base64")}`;
  const contentHtml = `<div style="position:absolute;left:${cr.x}px;top:${cr.y}px;width:${cr.width}px;height:${cr.height}px;overflow:hidden">
      <img id="shot" src="${src}" style="display:block;width:${cr.width}px;height:${fullCssH}px" alt=""/>
    </div>`;
  const html = stageHtml([deviceHtmlFor(device, shot, analysis, opts, contentHtml)], opts);
  const { context, page, stage } = await openStage(browser, html, device.dpr);

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  let ok = true;
  async function* frames() {
    for (let i = 0; i <= steps; i++) {
      const y = Math.round(ease(i / steps) * Math.max(0, fullCssH - cr.height));
      await page.evaluate((off) => {
        document.getElementById("shot").style.transform = `translateY(-${off}px)`;
      }, y);
      const frame = await stage.screenshot({ type: "png" });
      if (i === 0) ok = verifyOutput({ output: decodePng(frame), capture: analysis.img, device, opts, analysis });
      yield frame;
    }
  }
  const ext = path.extname(outFile).toLowerCase();
  const tmp = `${outFile}.tmp-${process.pid}${ext}`;
  try {
    await encode(frames(), tmp, fps);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  } finally {
    await context.close();
  }
  const dest = finalizeOutput(tmp, outFile, ok);
  console.log(`  wrote ${dest} (${steps + 1} frames, ${seconds.toFixed(1)}s scroll; frame 0 checked)`);
  return { ok, dest };
}

function requireFfmpeg() {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) throw new Error("--scroll needs ffmpeg on PATH (brew/apt install ffmpeg)");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.scroll) requireFfmpeg();
  const multi = opts.deviceIds.length > 1;

  await withBrowser(async (browser) => {
    await validateBackground(browser, opts);
    if (opts.scroll) {
      const device = DEVICES[opts.deviceIds[0]];
      const outFile = opts.out ?? `plinth-${opts.deviceIds[0]}-scroll.mp4`;
      mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      const { ok, dest } = await renderScroll(browser, opts, device, outFile);
      if (!ok) {
        console.error(`plinth: verification failed — see checks above; video kept at ${dest}`);
        process.exitCode = EXIT_CHECK;
      }
      return;
    }

    const shots = [];
    for (const id of opts.deviceIds) {
      const device = DEVICES[id];
      const cr = contentRect(device, opts.mode);
      console.log(`plinth · capturing ${opts.url} as ${id} (${cr.width}×${cr.height}pt @${device.dpr}x, mode ${device.kind === "phone" || device.kind === "tablet" ? opts.mode : "n/a"})`);
      const shot = await capture(browser, opts.url, {
        device, viewport: { width: cr.width, height: cr.height }, dpr: device.dpr,
        dark: opts.dark, hide: opts.hide, waitMs: opts.wait,
      });
      shots.push({ id, device, shot, analysis: analyzeCapture(shot.buffer) });
    }

    const frames = shots.map(({ device, shot, analysis }) =>
      deviceHtmlFor(device, shot, analysis, opts));
    const dprOut = multi ? MULTI_DPR : shots[0].device.dpr;
    const buffer = await composite(browser, stageHtml(frames, opts), dprOut);

    const outFile = opts.out ?? `plinth-${multi ? "multi" : opts.deviceIds[0]}.png`;
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    const tmp = `${outFile}.tmp-${process.pid}.png`;
    writeFileSync(tmp, buffer);
    const dims = pngSize(buffer);
    const ok = multi || verifySingle({
      shot: shots[0].shot, out: buffer, device: shots[0].device, opts,
      analysis: shots[0].analysis,
    });
    const dest = finalizeOutput(tmp, outFile, ok);
    console.log(`  wrote ${dest} (${dims.width}×${dims.height})`);
    if (multi) console.log(`  multi-device layout composited at @${MULTI_DPR}x (no checks; single-device runs are 1:1 native and verified)`);
    if (!ok) {
      console.error(`plinth: verification failed — see checks above; image kept at ${dest}`);
      process.exitCode = EXIT_CHECK;
    }
  });
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main();
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`plinth: ${err.message}`);
      console.error("");
      console.error(usage());
      process.exit(EXIT_USAGE);
    }
    // Playwright appends a multi-line call log; the first line says it.
    console.error(`plinth: ${String(err?.message ?? err).split("\n")[0]}`);
    process.exit(EXIT_RUNTIME);
  }
}
