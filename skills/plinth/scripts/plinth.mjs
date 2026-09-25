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
  buildDeviceHtml, buildScreenHtml,
} from "./devices.mjs";
import { withBrowser, capture } from "./capture.mjs";
import { pngSize, decodePng, getPixel, colorDistance } from "./png.mjs";
import { findFrame, analyzeFrame, FRAME_MANIFEST } from "./frames.mjs";
import { deviceGeometry, renderStill, renderLoop } from "./render3d.mjs";

const VIEWS = ["flat", "hero", "tilt-left", "tilt-right", "top-down", "fan", "combo"];

const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_CHECK = 1;
const EXIT_USAGE = 2;

const GAP = 56; // pt between frames in multi-device layouts
const MULTI_DPR = 2;

class UsageError extends Error {}

function usage() {
  return `Usage: plinth <url-or-screenshot.png> [options]

Captures <url> at an exact device viewport (safe-area aware), builds a
procedural three.js device from the cited spec table, and renders it —
flat (orthographic, pixel-exact) or floating in 3D. A .png path can be
given instead of a URL to frame an existing screenshot.

Options:
  --device <id>       Device frame (default: iphone-16-pro)
  --devices <a,b,c>   Several devices (2D row in flat view; fan/combo in 3D)
  --view <v>          flat (default) | hero | tilt-left | tilt-right |
                      top-down | fan | combo
  --float <pt>        Float height for 3D views (default 26)
  --transparent       Transparent background (PNG alpha)
  --scale <n>         Output pixel ratio for 3D views (default 2; flat
                      always renders at the device DPR)
  --size <WxH>        Canvas size for 3D views (default 1600x1200)
  --turntable         Seamless float/turntable loop → mp4/gif (ffmpeg)
  --mode <m>          Phone/tablet presentation: app|standalone (default:
                      status bar + home indicator, content in the safe
                      area) | safari (compact bottom bar) | bare
  --status <s>        Status bar content: auto (from page luminance,
                      default) | light | dark
  --buttons           Draw side buttons on phone frames
  --out <file>        Output PNG (default: plinth-<device>.png)
  --bg <value>        Background: ${Object.keys(BACKGROUNDS).join(" | ")} or any CSS value
  --padding <px>      Padding around the frame (default 48)
  --no-shadow         Disable the drop shadow
  --dark              Dark color scheme for the page + dark background
  --frame <path>      Composite into a real device frame PNG (any art
                      with a transparent screen cutout). Default: the
                      official Apple bezel from the fetch-frames cache,
                      falling back to the procedural frame (offline only)
  --frame-theme <t>   Procedural frame theme: dark | light (default dark)
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
    mode: "standalone", status: "auto", buttons: false, frame: null,
    view: "flat", float: 26, transparent: false, scale: 2,
    size: { width: 1600, height: 1200 }, turntable: false,
    bg: null, padding: 48, shadow: true, dark: false, frameTheme: "dark",
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
      case "--view": opts.view = next(); break;
      case "--float": opts.float = Number(next()); break;
      case "--transparent": opts.transparent = true; break;
      case "--scale": opts.scale = Number(next()); break;
      case "--size": {
        const m = next().match(/^(\d+)x(\d+)$/);
        if (!m) throw new UsageError("--size must look like 1600x1200");
        opts.size = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      case "--turntable": opts.turntable = true; break;
      case "--out": opts.out = next(); break;
      case "--bg": opts.bg = next(); break;
      case "--padding": opts.padding = Number(next()); break;
      case "--no-shadow": opts.shadow = false; break;
      case "--dark": opts.dark = true; break;
      case "--frame": opts.frame = next(); break;
      case "--frame-theme": opts.frameTheme = next(); break;
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
  if (!opts.url) throw new UsageError("missing URL or screenshot file");
  if (opts.url.endsWith(".png") && existsSync(opts.url)) {
    opts.inputFile = path.resolve(opts.url);
    opts.url = `file://${path.basename(opts.inputFile)}`;
  } else if (!/^[a-z]+:\/\//.test(opts.url)) {
    opts.url = `https://${opts.url}`;
  }
  const ids = opts.devices ?? [opts.device];
  for (const id of ids) {
    if (!DEVICES[id]) throw new UsageError(`unknown device "${id}"\n\nDevices:\n${deviceList()}`);
  }
  opts.deviceIds = ids;
  if (opts.mode === "app") opts.mode = "standalone";
  if (!["standalone", "safari", "bare"].includes(opts.mode)) {
    throw new UsageError("--mode must be app/standalone, safari, or bare");
  }
  if (!VIEWS.includes(opts.view)) {
    throw new UsageError(`--view must be one of: ${VIEWS.join(", ")}`);
  }
  if (opts.view === "fan" && opts.deviceIds.length === 1) {
    opts.deviceIds = [ids[0], ids[0], ids[0]]; // fan of three of the same device
  }
  if (!["auto", "light", "dark"].includes(opts.status)) {
    throw new UsageError("--status must be auto, light, or dark");
  }
  if (!(opts.frameTheme in { dark: 1, light: 1 })) throw new UsageError("--frame-theme must be dark or light");
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
    frameTheme: opts.frameTheme,
    buttons: opts.buttons,
    mode: opts.mode,
  });
}

/**
 * Screenshot the screen layers alone (no clip, no frame) at the given
 * scale. The island/punch hole is excluded: real bezel art (or the 3D
 * island geometry) draws it.
 */
async function renderScreenTexture(browser, device, shot, analysis, opts, scale) {
  const { statusColor, indicatorColor } = chromeColors(analysis, opts);
  const cr = contentRect(device, opts.mode);
  const contentHtml = `<img src="data:image/png;base64,${shot.buffer.toString("base64")}"
    style="position:absolute;left:${cr.x}px;top:${cr.y}px;width:${cr.width}px;height:${cr.height}px;display:block" alt=""/>`;
  const screen = buildScreenHtml(device, {
    contentHtml,
    bandColor: analysis.top.color,
    bottomColor: analysis.bottom.color,
    statusColor,
    indicatorColor,
    url: opts.url,
    domain: opts.url.replace(/^(https?|file):\/\//, "").replace(/\/.*$/, ""),
    frameTheme: opts.frameTheme,
    mode: opts.mode,
    includeIsland: false,
  });
  const html = `<!doctype html><html><head><style>${fontFaces()} * { margin:0; }</style></head>
    <body><div id="stage" style="position:relative;width:${screen.width}px;height:${screen.height}px;background:${analysis.top.color};overflow:hidden">${screen.html}</div></body></html>`;
  const context = await browser.newContext({
    viewport: { width: screen.width + 10, height: screen.height + 10 },
    deviceScaleFactor: scale,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    return await page.locator("#stage").screenshot({ type: "png" });
  } finally {
    await context.close();
  }
}

// 3D background config from the 2D presets / CSS values.
const BG3D = {
  studio: { type: "gradient", a: "#f4f5f7", b: "#c9cdd6" },
  "studio-dark": { type: "gradient", a: "#1c1d22", b: "#0a0b0e" },
  sunset: { type: "gradient", a: "#fde5d0", b: "#c9c3ef" },
  ocean: { type: "gradient", a: "#d8ecf5", b: "#a9c3e8" },
  none: { type: "transparent" },
};

function bg3d(opts) {
  if (opts.transparent) return { type: "transparent" };
  if (opts.bg) return BG3D[opts.bg] ?? { type: "color", a: opts.bg };
  return opts.dark ? BG3D["studio-dark"] : BG3D.studio;
}

async function getShot(browser, device, opts) {
  const cr = contentRect(device, opts.mode);
  if (opts.inputFile) {
    const buffer = readFileSync(opts.inputFile);
    const dims = pngSize(buffer);
    return { buffer, pxWidth: dims.width, pxHeight: dims.height, fromFile: true };
  }
  return capture(browser, opts.url, {
    viewport: { width: cr.width, height: cr.height }, dpr: device.dpr,
    dark: opts.dark, hide: opts.hide, waitMs: opts.wait,
  });
}

async function render3dOutput(browser, opts, shots) {
  const flat = opts.view === "flat";
  const device0 = shots[0].device;
  const textures = [];
  const devices = [];
  for (const { device, shot, analysis } of shots) {
    textures.push(await renderScreenTexture(browser, device, shot, analysis, opts, device.dpr));
    devices.push({
      spec: { kind: device.kind },
      ...deviceGeometry(device, { buttons: opts.buttons }),
      texture: `/tex/${textures.length - 1}.png`,
    });
  }
  const stage = flat
    ? {
        width: frameSize(device0).width + 2 * opts.padding,
        height: frameSize(device0).height + 2 * opts.padding,
      }
    : opts.size;
  const config = {
    view: opts.view,
    devices,
    stage,
    scale: flat ? device0.dpr : opts.scale,
    bg: bg3d(opts),
    frameTheme: opts.frameTheme,
    float: opts.float,
    shadow: opts.shadow,
    rotate: {},
  };
  return { config, textures };
}

/**
 * Composite the screen texture into real device frame art. The
 * screenshot is scaled to exactly the frame's transparent screen cutout
 * and masked with the frame's own alpha (rounded corners, island), so
 * nothing bleeds and there is no gap; the art then covers the seam.
 */
async function frameFlatComposite(browser, { device, shot, analysis, opts, frame }) {
  const scale = frame.hole.width / device.pt.width;
  const texture = await renderScreenTexture(browser, device, shot, analysis, opts, scale);
  const padA = Math.round(opts.padding * scale);
  const stageW = frame.img.width + 2 * padA;
  const stageH = frame.img.height + 2 * padA;
  const shadow = opts.shadow
    ? "filter: drop-shadow(0 18px 38px rgba(0,0,0,0.28)) drop-shadow(0 4px 10px rgba(0,0,0,0.18));"
    : "";
  const html = `<!doctype html><html><head><style>
    * { margin: 0; }
    #stage { position: relative; width: ${stageW}px; height: ${stageH}px; background: ${background(opts)}; }
    .device { position: absolute; left: ${padA}px; top: ${padA}px; ${shadow} }
    .screen { position: absolute; left: ${frame.hole.x}px; top: ${frame.hole.y}px;
      width: ${frame.hole.width}px; height: ${frame.hole.height}px;
      mask-image: url(data:image/png;base64,${frame.maskPng.toString("base64")});
      mask-size: 100% 100%; mask-mode: alpha;
      -webkit-mask-image: url(data:image/png;base64,${frame.maskPng.toString("base64")});
      -webkit-mask-size: 100% 100%; }
    .screen img, .art { display: block; width: 100%; height: 100%; }
  </style></head><body><div id="stage">
    <div class="device" style="width:${frame.img.width}px;height:${frame.img.height}px">
      <div class="screen"><img src="data:image/png;base64,${texture.toString("base64")}" alt=""/></div>
      <img class="art" src="data:image/png;base64,${frame.buf.toString("base64")}" alt=""
        style="position:absolute;left:0;top:0"/>
    </div>
  </div></body></html>`;
  const { buffer } = await composite(browser, html, 1);
  return { buffer, scale, padA };
}

function verifyFrameFlat({ out, frame, device, opts, shot, analysis, scale, padA }) {
  const outImg = decodePng(out);
  const dims = pngSize(out);
  let ok = check(
    "output matches frame art size",
    Math.abs(dims.width - (frame.img.width + 2 * padA)) <= 1 &&
      Math.abs(dims.height - (frame.img.height + 2 * padA)) <= 1,
    `${dims.width}×${dims.height} vs frame ${frame.img.width}×${frame.img.height} + padding`,
  );

  // No bleed: at each hole-bbox corner the art is opaque (the screen's
  // rounded corner curve) — the output pixel must equal the art pixel,
  // i.e. no content escaped the mask.
  const corners = [
    [frame.hole.x + 2, frame.hole.y + 2],
    [frame.hole.x + frame.hole.width - 3, frame.hole.y + 2],
    [frame.hole.x + 2, frame.hole.y + frame.hole.height - 3],
    [frame.hole.x + frame.hole.width - 3, frame.hole.y + frame.hole.height - 3],
  ];
  let bleedOk = true;
  for (const [ax, ay] of corners) {
    const artPx = getPixel(frame.img, ax, ay);
    if (artPx[3] < 250) continue; // corner not covered by art in this frame
    const outPx = getPixel(outImg, padA + ax, padA + ay);
    if (colorDistance(outPx, artPx) > 10) bleedOk = false;
  }
  ok = check("no content bleed at the frame's screen corners", bleedOk) && ok;

  // Content alignment: patch-average at the hole center vs the capture.
  const patchAvg = (img, cx, cy) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const p = getPixel(img, cx + dx, cy + dy);
        r += p[0]; g += p[1]; b += p[2]; n++;
      }
    }
    return [r / n, g / n, b / n, 255];
  };
  const shotImg = decodePng(shot.buffer);
  const cr = contentRect(device, opts.mode);
  const contentCenterPt = [cr.x + cr.width / 2, cr.y + cr.height / 2];
  const got = patchAvg(outImg,
    Math.round(padA + frame.hole.x + contentCenterPt[0] * scale),
    Math.round(padA + frame.hole.y + contentCenterPt[1] * scale));
  const want = patchAvg(shotImg, Math.round(shot.pxWidth / 2), Math.round(shot.pxHeight / 2));
  ok = check(
    "frame alignment (content center patch)",
    colorDistance(got, want) <= 12,
    `output rgb(${got.map(Math.round).slice(0, 3)}) vs capture rgb(${want.map(Math.round).slice(0, 3)})`,
  ) && ok;

  if (device.island && opts.mode !== "bare") {
    // The island is part of the art in frame mode.
    const [ix, iy] = [
      Math.round(padA + frame.hole.x + (device.pt.width / 2) * scale),
      Math.round(padA + frame.hole.y + (device.island.y + device.island.height / 2) * scale),
    ];
    const px = getPixel(outImg, ix, iy);
    ok = check("island covered by frame art at spec position", colorDistance(px, [0, 0, 0, 255]) <= 24, `rgb(${px.slice(0, 3)})`) && ok;
  }

  if (device.homeIndicator && opts.mode !== "bare" && device.kind !== "laptop") {
    const hi = device.homeIndicator;
    const hiY = device.pt.height - hi.bottomGap - hi.height / 2;
    const hiPx = getPixel(outImg,
      Math.round(padA + frame.hole.x + (device.pt.width / 2) * scale),
      Math.round(padA + frame.hole.y + hiY * scale));
    const bandPx = getPixel(outImg,
      Math.round(padA + frame.hole.x + (device.pt.width / 2 - hi.width / 2 - 40) * scale),
      Math.round(padA + frame.hole.y + hiY * scale));
    ok = check("home indicator present at spec position", colorDistance(hiPx, bandPx) > 40,
      `indicator rgb(${hiPx.slice(0, 3)}) vs band rgb(${bandPx.slice(0, 3)})`) && ok;
  }
  return ok;
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
  let ok = true;
  if (shot.fromFile) {
    console.log(`  check: capture is DPR-exact — skipped (framing an existing file, ${shot.pxWidth}×${shot.pxHeight})`);
  } else {
    ok = check(
      "capture is DPR-exact (safe-area viewport)",
      shot.pxWidth === expectedShot.w && shot.pxHeight === expectedShot.h,
      `${shot.pxWidth}×${shot.pxHeight} vs spec ${expectedShot.w}×${expectedShot.h}`,
    );
  }

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

  // Content alignment: a small patch at the content-rect center must
  // average to the same color as the capture's center patch (a patch,
  // not one pixel: GPU texture sampling may shift by half a texel, which
  // on high-frequency content flips single pixels).
  const patchAvg = (img, cx, cy) => {
    let r = 0, g = 0, b2 = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const p = getPixel(img, cx + dx, cy + dy);
        r += p[0]; g += p[1]; b2 += p[2]; n++;
      }
    }
    return [r / n, g / n, b2 / n, 255];
  };
  const [ccx, ccy] = abs(cr.x + cr.width / 2, cr.y + cr.height / 2);
  const got = patchAvg(outImg, ccx, ccy);
  const shotImg = decodePng(shot.buffer);
  const want = patchAvg(shotImg, Math.round(shot.pxWidth / 2), Math.round(shot.pxHeight / 2));
  ok = check(
    "frame alignment (content center patch)",
    colorDistance(got, want) <= 12,
    `output rgb(${got.map(Math.round).slice(0, 3)}) vs capture rgb(${want.map(Math.round).slice(0, 3)})`,
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
    viewport: { width: cr.width, height: cr.height }, dpr: device.dpr,
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
      console.log(`plinth · ${opts.inputFile ? "framing" : "capturing"} ${opts.url} as ${id} (${cr.width}×${cr.height}pt @${device.dpr}x, mode ${device.kind === "phone" || device.kind === "tablet" ? opts.mode : "n/a"}, view ${opts.view})`);
      const shot = await getShot(browser, device, opts);
      shots.push({ id, device, shot, analysis: analyzeCapture(shot.buffer) });
    }

    // Real device frame art (fetched cache or --frame override) is the
    // primary flat single-device path; the procedural frame is an
    // offline fallback only and never a showcase.
    const frameFile = !multi && opts.view === "flat" ? findFrame(opts.deviceIds[0], opts.frame) : null;
    if (frameFile) {
      const frame = analyzeFrame(frameFile);
      console.log(`  frame art: ${frameFile} (${frame.img.width}×${frame.img.height}, screen cutout ${frame.hole.width}×${frame.hole.height} @ ${frame.hole.x},${frame.hole.y})`);
      const { device, shot, analysis } = shots[0];
      const { buffer, scale, padA } = await frameFlatComposite(browser, { device, shot, analysis, opts, frame });
      const outFile = opts.out ?? `plinth-${opts.deviceIds[0]}.png`;
      mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      writeFileSync(outFile, buffer);
      const dims = pngSize(buffer);
      console.log(`  wrote ${outFile} (${dims.width}×${dims.height}, real frame art)`);
      const ok = verifyFrameFlat({ out: buffer, frame, device, opts, shot, analysis, scale, padA });
      if (!ok) {
        console.error("plinth: verification failed — see checks above");
        process.exit(EXIT_CHECK);
      }
      return;
    }
    if (!multi && opts.view === "flat" && FRAME_MANIFEST[opts.deviceIds[0]]) {
      console.log("  note: procedural fallback frame (offline only) — fetch real device art with `node scripts/fetch-frames.mjs`");
    }


    // Legacy 2D row: several devices side by side in the flat view.
    if (multi && opts.view === "flat") {
      const frames = shots.map(({ device, shot, analysis }) =>
        deviceHtmlFor(device, shot, analysis, opts));
      const { buffer } = await composite(browser, stageHtml(frames, opts), MULTI_DPR);
      const outFile = opts.out ?? "plinth-multi.png";
      mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      writeFileSync(outFile, buffer);
      const dims = pngSize(buffer);
      console.log(`  wrote ${outFile} (${dims.width}×${dims.height})`);
      console.log(`  multi-device 2D row composited at @${MULTI_DPR}x`);
      return;
    }

    const { config, textures } = await render3dOutput(browser, opts, shots);

    if (opts.turntable) {
      const outFile = opts.out ?? `plinth-${opts.deviceIds[0]}-${opts.view}.mp4`;
      mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      const frames = await renderLoop(browser, config, textures, outFile);
      console.log(`  wrote ${outFile} (${frames} frames, seamless loop)`);
      return;
    }

    const buffer = await renderStill(browser, config, textures);
    const outFile = opts.out ?? `plinth-${multi ? opts.view : opts.deviceIds[0]}.png`;
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, buffer);
    const dims = pngSize(buffer);
    console.log(`  wrote ${outFile} (${dims.width}×${dims.height}, ${opts.view} view)`);

    if (opts.view === "flat" && !multi) {
      const ok = verifySingle({
        shot: shots[0].shot, out: buffer, device: shots[0].device, opts,
        analysis: shots[0].analysis,
      });
      if (!ok) {
        console.error("plinth: verification failed — see checks above");
        process.exit(EXIT_CHECK);
      }
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
