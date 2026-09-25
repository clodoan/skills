#!/usr/bin/env node
/**
 * bezel — DPR-correct screenshots composited into clean device frames.
 *
 * Captures a URL at exact device viewports with Playwright (system
 * Chrome via playwright-core) and composites the shot into a generated
 * CSS device frame (phone / tablet / laptop / browser chrome). Verifies
 * its own output: capture dimensions, output dimensions, and frame
 * alignment via pixel sampling. Optional scrolled capture to mp4/gif
 * via ffmpeg.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { DEVICES, BACKGROUNDS, deviceList, frameSize, screenRect, frameHtml } from "./devices.mjs";
import { withBrowser, capture } from "./capture.mjs";
import { pngSize, decodePng, getPixel, colorDistance } from "./png.mjs";

const EXIT_OK = 0;
const EXIT_CHECK = 1;
const EXIT_USAGE = 2;

const GAP = 56; // CSS px between frames in multi-device layouts
const MULTI_DPR = 2;

class UsageError extends Error {}

function usage() {
  return `Usage: bezel <url> [options]

Captures <url> at an exact device viewport and composites it into a
generated device frame. Verifies dimensions and frame alignment.

Options:
  --device <id>       Device frame (default: iphone-15-pro)
  --devices <a,b,c>   Multi-device row layout (composited at @2x)
  --out <file>        Output PNG (default: bezel-<device>.png)
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
    url: null, device: "iphone-15-pro", devices: null, out: null,
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
  if (!(opts.frame in { dark: 1, light: 1 })) throw new UsageError("--frame must be dark or light");
  return opts;
}

function background(opts) {
  if (opts.bg) return BACKGROUNDS[opts.bg] ?? opts.bg;
  return opts.dark ? BACKGROUNDS["studio-dark"] : BACKGROUNDS.studio;
}

function stageHtml(frames, opts) {
  const shadow = opts.shadow
    ? "filter: drop-shadow(0 18px 38px rgba(0,0,0,0.28)) drop-shadow(0 4px 10px rgba(0,0,0,0.18));"
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; }
    #stage { display: inline-flex; align-items: center; gap: ${GAP}px;
             padding: ${opts.padding}px; background: ${background(opts)}; }
    #stage > .frame { ${shadow} flex: none; }
  </style></head><body>${frames.join("\n")}</body></html>`
    .replace("<body>", '<body><div id="stage">') + "</div></body></html>";
}

async function composite(browser, html, dpr) {
  const context = await browser.newContext({
    viewport: { width: 300, height: 300 },
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const stage = page.locator("#stage");
    const box = await stage.boundingBox();
    await page.setViewportSize({
      width: Math.ceil(box.width) + 10,
      height: Math.ceil(box.height) + 10,
    });
    const buffer = await stage.screenshot({ type: "png", omitBackground: true });
    return { buffer, cssWidth: box.width, cssHeight: box.height };
  } finally {
    await context.close();
  }
}

function check(name, ok, detail) {
  console.log(`  check: ${name} — ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  return ok;
}

function verifySingle({ shot, out, device, opts }) {
  const d = device;
  const expectedShot = {
    w: Math.round(d.viewport.width * d.dpr),
    h: Math.round(d.viewport.height * d.dpr),
  };
  let ok = check(
    "capture is DPR-exact",
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

  // Frame alignment: the center of the screen rect in the output must
  // show the same pixel as the center of the raw screenshot.
  const rect = screenRect(d);
  const cx = Math.round((opts.padding + rect.x + rect.width / 2) * d.dpr);
  const cy = Math.round((opts.padding + rect.y + rect.height / 2) * d.dpr);
  const outImg = decodePng(out);
  const shotImg = decodePng(shot.buffer);
  const got = getPixel(outImg, cx, cy);
  const want = getPixel(shotImg, Math.round(shot.pxWidth / 2), Math.round(shot.pxHeight / 2));
  ok = check(
    "frame alignment (center pixel)",
    colorDistance(got, want) <= 6,
    `output rgb(${got.slice(0, 3)}) vs capture rgb(${want.slice(0, 3)})`,
  ) && ok;
  return ok;
}

async function renderScroll(browser, opts, device, outFile) {
  const shot = await capture(browser, opts.url, {
    viewport: device.viewport, dpr: device.dpr, dark: opts.dark,
    hide: opts.hide, waitMs: opts.wait, fullPage: true,
  });
  const vhPx = Math.round(device.viewport.height * device.dpr);
  const scrollablePx = Math.max(0, shot.pxHeight - vhPx);
  const scrollableCss = scrollablePx / device.dpr;
  const fps = 30;
  const seconds = Math.min(8, Math.max(2, scrollableCss / 400));
  const steps = Math.round(fps * seconds);

  const src = `data:image/png;base64,${shot.buffer.toString("base64")}`;
  const fullCssH = shot.pxHeight / device.dpr;
  const framed = frameHtml(device, src, { frameTheme: opts.frame, url: opts.url })
    .replace(
      `height:${device.viewport.height}px;`,
      `height:${fullCssH}px;`,
    )
    .replace('<img src="', '<img id="shot" src="');
  // Wrap the tall image in a clipping window the size of the screen.
  const clipped = framed.replace(
    '<img id="shot"',
    `<div style="width:${device.viewport.width}px;height:${device.viewport.height}px;overflow:hidden;border-radius:${device.screenRadius}px"><img id="shot"`,
  ).replace("/>", "/></div>");

  const html = stageHtml([clipped], opts);
  const context = await browser.newContext({
    viewport: { width: 300, height: 300 }, deviceScaleFactor: device.dpr,
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
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
    const y = Math.round(ease(i / steps) * (fullCssH - device.viewport.height));
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
      const outFile = opts.out ?? `bezel-${opts.deviceIds[0]}-scroll.mp4`;
      mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      await renderScroll(browser, opts, device, outFile);
      return;
    }

    const shots = [];
    for (const id of opts.deviceIds) {
      const device = DEVICES[id];
      console.log(`bezel · capturing ${opts.url} as ${id} (${device.viewport.width}×${device.viewport.height} @${device.dpr}x)`);
      const shot = await capture(browser, opts.url, {
        viewport: device.viewport, dpr: device.dpr, dark: opts.dark,
        hide: opts.hide, waitMs: opts.wait,
      });
      shots.push({ id, device, shot });
    }

    const frames = shots.map(({ device, shot }) =>
      frameHtml(device, `data:image/png;base64,${shot.buffer.toString("base64")}`, {
        frameTheme: opts.frame, url: opts.url,
      }),
    );
    const dprOut = multi ? MULTI_DPR : shots[0].device.dpr;
    const { buffer } = await composite(browser, stageHtml(frames, opts), dprOut);

    const outFile = opts.out ?? `bezel-${multi ? "multi" : opts.deviceIds[0]}.png`;
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, buffer);
    const dims = pngSize(buffer);
    console.log(`  wrote ${outFile} (${dims.width}×${dims.height})`);

    if (!multi) {
      const ok = verifySingle({ shot: shots[0].shot, out: buffer, device: shots[0].device, opts });
      if (!ok) {
        console.error("bezel: verification failed — see checks above");
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
    console.error(`bezel: ${err.message}`);
    console.error("");
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  console.error(`bezel: ${err?.message ?? err}`);
  process.exit(EXIT_USAGE);
}
