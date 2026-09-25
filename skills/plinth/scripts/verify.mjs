/**
 * Output verification by decoding real pixels. Single-device output is
 * 1:1 with the capture, so every sampled content pixel must match the
 * capture, and every chrome region must show drawn chrome rather than
 * the flat safe-area band. Both fail on offsets, overlapping frames, and
 * missing chrome — which dimension checks alone cannot see.
 */

import { contentRect, frameSize, screenRect } from "./devices.mjs";
import { getPixel, colorDistance } from "./png.mjs";

const STEP = 4; // pt between content samples
const EDGE = 2; // pt kept clear of the screen edge (frame stroke)
const TOLERANCE = 8; // per channel, beyond the capture's 3×3 neighborhood
export const MAX_MISMATCH = 0.002; // fraction of content samples
export const MIN_CHROME = 0.005; // fraction of chrome samples unlike the band

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function ticks(length, margin, step) {
  const out = [];
  for (let v = margin; v < length - margin; v += step) out.push(v);
  out.push(length - margin);
  return out;
}

/** Output px for a frame-relative pt coordinate. */
function outPx(img, device, padding, x, y) {
  return getPixel(
    img,
    clamp(Math.round((padding + x) * device.dpr), 0, img.width - 1),
    clamp(Math.round((padding + y) * device.dpr), 0, img.height - 1),
  );
}

/** Corner squares of the rounded screen/window, which clip content. */
function inCorner(device, sx, sy) {
  const r = Math.max(device.screenRadius, device.outerRadius ?? 0);
  return (sx < r || sx > device.pt.width - r) && (sy < r || sy > device.pt.height - r);
}

/**
 * Sampled-grid comparison of the content rect. A sample matches when the
 * output pixel lies within the per-channel range of the capture's 3×3
 * neighborhood (± TOLERANCE), which absorbs fractional-DPR resampling.
 * `capture` may be taller than the content rect (scroll frame 0).
 */
export function contentMismatch(output, capture, device, mode, padding) {
  const cr = contentRect(device, mode);
  const sr = screenRect(device);
  const { dpr } = device;
  let total = 0, bad = 0;
  for (const v of ticks(cr.height, EDGE, STEP)) {
    for (const u of ticks(cr.width, EDGE, STEP)) {
      const sx = cr.x + u, sy = cr.y + v;
      if (inCorner(device, sx, sy)) continue;
      // bare: status bar, island and home indicator sit on the content.
      if (mode === "bare" && (sy < device.statusBar || sy > device.pt.height - device.safeBottom)) continue;
      total++;
      const o = outPx(output, device, padding, sr.x + sx, sr.y + sy);
      const cx = Math.round(u * dpr), cy = Math.round(v * dpr);
      const lo = [255, 255, 255], hi = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const p = getPixel(capture, clamp(cx + dx, 0, capture.width - 1), clamp(cy + dy, 0, capture.height - 1));
          for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]); }
        }
      }
      if ([0, 1, 2].some((c) => o[c] < lo[c] - TOLERANCE || o[c] > hi[c] + TOLERANCE)) bad++;
    }
  }
  return { total, bad, fraction: total ? bad / total : 0 };
}

/**
 * Chrome regions (frame-relative pt rects) and the band color each sits
 * on: status bar and home-indicator strips on phones/tablets, the menu
 * bar on the laptop, the tab strip + toolbar on the browser. None in
 * bare mode, where the chrome overlays page content.
 */
function chromeRegions(device, mode, bands) {
  const sr = screenRect(device);
  const cr = contentRect(device, mode);
  const { width, height } = device.pt;
  switch (device.kind) {
    case "phone":
    case "tablet":
      if (mode === "bare") return [];
      return [
        { name: "status bar", x: sr.x, y: sr.y, w: width, h: cr.y, band: bands.top },
        { name: "bottom chrome", x: sr.x, y: sr.y + cr.y + cr.height, w: width, h: height - cr.y - cr.height, band: bands.bottom },
      ];
    case "laptop":
      return [{ name: "menu bar", x: sr.x, y: sr.y, w: width, h: device.menuBar, band: bands.top }];
    case "browser":
      return [{ name: "window chrome", x: 1, y: 1, w: width, h: device.tabStrip + device.toolbar, band: bands.top }];
    default:
      return [];
  }
}

/** Per chrome region: fraction of 1pt samples that differ from its band. */
export function chromePresence(output, device, mode, padding, bands) {
  const sr = screenRect(device);
  return chromeRegions(device, mode, bands).map((region) => {
    let total = 0, distinct = 0;
    // Skip EDGE pt around the region: the frame's inner stroke lies there.
    for (let y = region.y + EDGE + 0.5; y < region.y + region.h - EDGE; y++) {
      for (let x = region.x + EDGE + 0.5; x < region.x + region.w - EDGE; x++) {
        const [sx, sy] = device.kind === "browser" ? [x - 1, 0] : [x - sr.x, y - sr.y];
        if (device.kind !== "browser" && inCorner(device, sx, sy)) continue;
        if (device.kind === "browser" && (sx < device.outerRadius || sx > device.pt.width - device.outerRadius) && y < device.outerRadius) continue;
        total++;
        if (colorDistance(outPx(output, device, padding, x, y), region.band) > 48) distinct++;
      }
    }
    return { name: region.name, fraction: total ? distinct / total : 0 };
  });
}

/** Expected single-device output size in px. */
export function expectedOutputSize(device, padding) {
  const size = frameSize(device);
  return {
    width: Math.round((size.width + 2 * padding) * device.dpr),
    height: Math.round((size.height + 2 * padding) * device.dpr),
  };
}
