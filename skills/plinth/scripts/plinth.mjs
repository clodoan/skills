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

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import {
  DEVICES, BACKGROUNDS, deviceList, frameSize, screenRect, contentRect,
  buildDeviceHtml,
} from "./devices.mjs";
import { withBrowser, capture } from "./capture.mjs";
import { pngSize, decodePng, getPixel, colorDistance } from "./png.mjs";

const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_CHECK = 1;
const EXIT_USAGE = 2;

const GAP = 56; // pt between frames in multi-device layouts
const MULTI_DPR = 2;

class UsageError extends Error {}

function usage() {
  return `Usage: plinth <url> [options]

Captures <url> at an exact device viewport (safe-area aware) and
composites it into a spec-accurate device frame with faithful chrome.

Options:
  --device <id>       Device frame (default: iphone-16-pro)
  --devices <a,b,c>   Multi-device row layout (composited at @2x)
  --mode <m>          Phone/tablet presentation: standalone (app-style,
                      status bar + home indicator, default) | safari
                      (mobile Safari with compact bottom bar) | bare
                      (full-bleed, content under everything)
  --status <s>        Status bar content: auto (from page luminance,
                      default) | light | dark
  --buttons           Draw side buttons on phone frames
  --out <file>        Output PNG (default: plinth-<device>.png)
  --bg <value>        Background: ${Object.keys(BACKGROUNDS).join(" | ")} or any CSS value
  --padding <px>      Padding around the frame (default 48)
  --no-shadow         Disable the drop shadow
  --dark              Dark color scheme for the page + dark background
  --frame <theme>     Frame theme: dark | light (default dark)
  --hide <sel,sel>    CSS selectors to hide before capture (cookie banners)
  --wait <ms>         Extra settle time after load (default 800)
  --scroll            Scrolled capture of the full page → mp4 (or .gif --out)
  -h, --help          Show this help

Devices:
${deviceList()}

Exit codes: 0 ok, 1 a verification check failed, 2 usage error.`;
}

function parseArgs(argv) {
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
      case "--padding": opts.padding = Number(next()); break;
      case "--no-shadow": opts.shadow = false; break;
      case "--dark": opts.dark = true; break;
      case "--frame": opts.frame = next(); break;
      case "--hide": opts.hide = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--wait": opts.wait = Number(next()); break;
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
  if (!/^[a-z]+:\/\//.test(opts.url)) opts.url = `https://${opts.url}`;
  const ids = opts.devices ?? [opts.device];
  for (const id of ids) {
    if (!DEVICES[id]) throw new UsageError(`unknown device "${id}"\n\nDevices:\n${deviceList()}`);
  }
  opts.deviceIds = ids;
  if (!["standalone", "safari", "bare"].includes(opts.mode)) {
    throw new UsageError("--mode must be standalone, safari, or bare");
  }
  if (!["auto", "light", "dark"].includes(opts.status)) {
    throw new UsageError("--status must be auto, light, or dark");
  }
  if (!(opts.frame in { dark: 1, light: 1 })) throw new UsageError("--frame must be dark or light");
  return opts;
}

function background(opts) {
  if (opts.bg) return BACKGROUNDS[opts.bg] ?? opts.bg;
  return opts.dark ? BACKGROUNDS["studio-dark"] : BACKGROUNDS.studio;
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

/** Average color + relative luminance of a horizontal strip of a capture. */
function stripStats(img, fromY, toY) {
  let r = 0, g = 0, b = 0, count = 0;
  const step = Math.max(1, Math.floor(img.width / 64));
  for (let y = fromY; y < toY; y++) {
    for (let x = 0; x < img.width; x += step) {
      const p = getPixel(img, x, y);
      r += p[0]; g += p[1]; b += p[2]; count++;
    }
  }
  r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { color: `rgb(${r},${g},${b})`, rgb: [r, g, b, 255], lum };
}

function analyzeCapture(buffer) {
  const img = decodePng(buffer);
  const strip = Math.max(4, Math.round(img.height * 0.01));
  return {
    top: stripStats(img, 0, strip),
    bottom: stripStats(img, img.height - strip, img.height),
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
    url: opts.url,
    domain: opts.url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    frameTheme: opts.frame,
    buttons: opts.buttons,
    mode: opts.mode,
  });
}

async function composite(browser, html, dpr) {
  const context = await browser.newContext({
    viewport: { width: 300, height: 300 },
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    const stage = page.locator("#stage");
    const box = await stage.boundingBox();
    await page.setViewportSize({
      width: Math.ceil(box.width) + 10,
      height: Math.ceil(box.height) + 10,
    });
    const buffer = await stage.screenshot({ type: "png", omitBackground: true });
    return { buffer };
  } finally {
    await context.close();
  }
}

function check(name, ok, detail) {
  console.log(`  check: ${name} — ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  return ok;
}

function verifySingle({ shot, out, device, opts, analysis }) {
  const d = device;
  const cr = contentRect(d, opts.mode);
  const expectedShot = { w: Math.round(cr.width * d.dpr), h: Math.round(cr.height * d.dpr) };
  let ok = check(
    "capture is DPR-exact (safe-area viewport)",
    shot.pxWidth === expectedShot.w && shot.pxHeight === expectedShot.h,
    `${shot.pxWidth}×${shot.pxHeight} vs spec ${expectedShot.w}×${expectedShot.h}`,
  );

  const size = frameSize(d);
  const expected = {
    w: Math.round((size.width + 2 * opts.padding) * d.dpr),
    h: Math.round((size.height + 2 * opts.padding) * d.dpr),
  };
  const actual = pngSize(out);
  ok = check(
    "output matches device spec",
    Math.abs(actual.width - expected.w) <= 1 && Math.abs(actual.height - expected.h) <= 1,
    `${actual.width}×${actual.height} vs expected ${expected.w}×${expected.h}`,
  ) && ok;

  const outImg = decodePng(out);
  const sr = screenRect(d);
  const abs = (ptX, ptY) => [
    Math.round((opts.padding + sr.x + ptX) * d.dpr),
    Math.round((opts.padding + sr.y + ptY) * d.dpr),
  ];

  // Content alignment: capture center must land at the content-rect center.
  const [ccx, ccy] = abs(cr.x + cr.width / 2, cr.y + cr.height / 2);
  const got = getPixel(outImg, ccx, ccy);
  const shotImg = decodePng(shot.buffer);
  const want = getPixel(shotImg, Math.round(shot.pxWidth / 2), Math.round(shot.pxHeight / 2));
  ok = check(
    "frame alignment (content center pixel)",
    colorDistance(got, want) <= 6,
    `output rgb(${got.slice(0, 3)}) vs capture rgb(${want.slice(0, 3)})`,
  ) && ok;

  if (d.kind === "phone" && d.island && opts.mode !== "bare") {
    const island = d.island;
    const samples = [
      abs(d.pt.width / 2, island.y + island.height / 2),
      abs(d.pt.width / 2 - island.width / 2 + 8, island.y + island.height / 2),
      abs(d.pt.width / 2 + island.width / 2 - 8, island.y + island.height / 2),
    ];
    const black = samples.every(([x, y]) => colorDistance(getPixel(outImg, x, y), [0, 0, 0, 255]) <= 10);
    ok = check("Dynamic Island is solid black at spec position", black) && ok;
  }

  if ((d.kind === "phone" || d.kind === "tablet") && d.homeIndicator && opts.mode !== "bare") {
    const hi = d.homeIndicator;
    const [hx, hy] = abs(d.pt.width / 2, d.pt.height - hi.bottomGap - hi.height / 2);
    const px = getPixel(outImg, hx, hy);
    const { indicatorColor } = chromeColors(analysis, opts);
    const wantDark = indicatorColor.startsWith("rgba(0");
    const lum = (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255;
    ok = check(
      "home indicator present at spec position",
      wantDark ? lum < 0.45 : lum > 0.55,
      `pixel rgb(${px.slice(0, 3)})`,
    ) && ok;
  }
  return ok;
}

async function renderScroll(browser, opts, device, outFile) {
  const cr = contentRect(device, opts.mode);
  const shot = await capture(browser, opts.url, {
    device, viewport: { width: cr.width, height: cr.height }, dpr: device.dpr,
    dark: opts.dark, hide: opts.hide, waitMs: opts.wait, fullPage: true,
  });
  const analysis = analyzeCapture(shot.buffer);
  const fullCssH = shot.pxHeight / device.dpr;
  const fps = 30;
  const seconds = Math.min(8, Math.max(2, (fullCssH - cr.height) / 400));
  const steps = Math.round(fps * seconds);

  const src = `data:image/png;base64,${shot.buffer.toString("base64")}`;
  const contentHtml = `<div style="position:absolute;left:${cr.x}px;top:${cr.y}px;width:${cr.width}px;height:${cr.height}px;overflow:hidden">
      <img id="shot" src="${src}" style="display:block;width:${cr.width}px;height:${fullCssH}px" alt=""/>
    </div>`;
  const html = stageHtml([deviceHtmlFor(device, shot, analysis, opts, contentHtml)], opts);

  const context = await browser.newContext({
    viewport: { width: 300, height: 300 }, deviceScaleFactor: device.dpr,
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  const stage = page.locator("#stage");
  const box = await stage.boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width) + 10, height: Math.ceil(box.height) + 10 });

  const isGif = outFile.endsWith(".gif");
  const vf = isGif
    ? "scale=trunc(iw/4)*2:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse"
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const args = [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps),
    "-i", "-", ...(isGif ? ["-filter_complex", vf] : ["-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22"]),
    outFile,
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  for (let i = 0; i <= steps; i++) {
    const y = Math.round(ease(i / steps) * Math.max(0, fullCssH - cr.height));
    await page.evaluate((off) => {
      document.getElementById("shot").style.transform = `translateY(-${off}px)`;
    }, y);
    const frame = await stage.screenshot({ type: "png" });
    if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((resolve, reject) => {
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  await context.close();
  console.log(`  wrote ${outFile} (${steps + 1} frames, ${seconds.toFixed(1)}s scroll)`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const multi = opts.deviceIds.length > 1;

  await withBrowser(async (browser) => {
    if (opts.scroll) {
      if (multi) throw new UsageError("--scroll works with a single --device");
      const device = DEVICES[opts.deviceIds[0]];
      const outFile = opts.out ?? `plinth-${opts.deviceIds[0]}-scroll.mp4`;
      mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      await renderScroll(browser, opts, device, outFile);
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
    const { buffer } = await composite(browser, stageHtml(frames, opts), dprOut);

    const outFile = opts.out ?? `plinth-${multi ? "multi" : opts.deviceIds[0]}.png`;
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, buffer);
    const dims = pngSize(buffer);
    console.log(`  wrote ${outFile} (${dims.width}×${dims.height})`);

    if (!multi) {
      const ok = verifySingle({
        shot: shots[0].shot, out: buffer, device: shots[0].device, opts,
        analysis: shots[0].analysis,
      });
      if (!ok) {
        console.error("plinth: verification failed — see checks above");
        process.exit(EXIT_CHECK);
      }
    } else {
      console.log(`  multi-device layout composited at @${MULTI_DPR}x (single-device runs are 1:1 native)`);
    }
  });
}

try {
  await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`plinth: ${err.message}`);
    console.error("");
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  console.error(`plinth: ${err?.message ?? err}`);
  process.exit(EXIT_USAGE);
}
