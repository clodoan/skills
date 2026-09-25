#!/usr/bin/env node
/**
 * spec-overlay — draw the cited device geometry over a plinth output PNG
 * so alignment can be reviewed visually: status bar, Dynamic Island,
 * content (safe-area) bounds, and home indicator, each as a labeled
 * translucent region at the coordinates from devices.mjs.
 *
 * A real iOS Simulator screenshot is not obtainable in a Linux
 * environment, so this overlay validates the render against the numeric
 * spec (which is itself cited to Apple-derived sources in devices.mjs).
 *
 *   node spec-overlay.mjs <plinth-output.png> <device-id> <out.png> [padding] [mode]
 */

import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEVICES, frameSize, screenRect, contentRect } from "./devices.mjs";
import { withBrowser } from "./capture.mjs";
import { pngSize } from "./png.mjs";

/** Labeled spec rects in output px for a plinth render in `mode`. */
export function overlayRects(device, mode, padding, dpr) {
  const sr = screenRect(device);
  const cr = contentRect(device, mode);
  const rects = [];
  const add = (label, x, y, w, h, color) =>
    rects.push({ label, x: (padding + sr.x + x) * dpr, y: (padding + sr.y + y) * dpr, w: w * dpr, h: h * dpr, color });
  if (device.statusBar) add(`status bar ${device.statusBar}pt`, 0, 0, device.pt.width, device.statusBar, "#00e5ff");
  if (device.island) {
    const i = device.island;
    add(`island ${i.width}×${i.height} @y${i.y}`, (device.pt.width - i.width) / 2, i.y, i.width, i.height, "#ff9100");
  }
  add(`content (${mode}) y=${cr.y}`, cr.x, cr.y, cr.width, cr.height, "#76ff03");
  if (device.homeIndicator) {
    const hi = device.homeIndicator;
    add(`home indicator ${hi.width}×${hi.height} gap ${hi.bottomGap}`,
      (device.pt.width - hi.width) / 2, device.pt.height - hi.bottomGap - hi.height, hi.width, hi.height, "#ff4081");
  }
  return rects;
}

async function main() {
  const [, , inputFile, deviceId, outFile, paddingArg = "48", mode = "standalone"] = process.argv;
  const device = DEVICES[deviceId];
  const padding = Number(paddingArg);
  if (!inputFile || !device || !outFile || !Number.isFinite(padding) || padding < 0 || !["standalone", "safari", "bare"].includes(mode)) {
    console.error("usage: spec-overlay <plinth-output.png> <device-id> <out.png> [padding=48] [standalone|safari|bare]");
    process.exit(2);
  }

  const buf = readFileSync(inputFile);
  const dims = pngSize(buf);
  const dpr = dims.width / (frameSize(device).width + 2 * padding);
  const rects = overlayRects(device, mode, padding, dpr);

  const boxes = rects.map((r) => `
    <div style="position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;
      border:2px dashed ${r.color};background:${r.color}22;box-sizing:border-box">
      <span style="position:absolute;left:4px;top:-22px;font:600 14px Inter,monospace;color:${r.color};
        background:rgba(0,0,0,0.72);padding:2px 6px;border-radius:4px;white-space:nowrap">${r.label}</span>
    </div>`).join("");

  const html = `<!doctype html><html><body style="margin:0">
    <div id="stage" style="position:relative;display:inline-block">
      <img src="data:image/png;base64,${buf.toString("base64")}" style="display:block;width:${dims.width}px;height:${dims.height}px"/>
      ${boxes}
    </div></body></html>`;

  await withBrowser(async (browser) => {
    const context = await browser.newContext({
      viewport: { width: Math.ceil(dims.width) + 10, height: Math.ceil(dims.height) + 10 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const shot = await page.locator("#stage").screenshot({ type: "png" });
    writeFileSync(outFile, shot);
    console.log(`spec overlay → ${outFile}`);
    await context.close();
  });
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
