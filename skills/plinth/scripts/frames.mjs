/**
 * Real device frame art: manifest, cache, and alpha-mask analysis.
 *
 * Frames come from Apple's official Product Bezels (Apple Design
 * Resources, developer.apple.com/design/resources). Their license — the
 * App Store Marketing Artwork License Agreement shipped inside each
 * download — is a limited, NON-TRANSFERABLE license for App Store
 * marketing by Apple Developer Program members, with Apple remaining
 * exclusive owner. Redistribution is not permitted, so THESE IMAGES ARE
 * NEVER COMMITTED to the repo: `fetch-frames.mjs` downloads them from
 * Apple's CDN into a local cache after showing the license and asking
 * for acceptance, then verifies checksums. `--frame <path>` accepts any
 * PNG with a transparent screen cutout as an override.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { decodePng, getPixel, encodePng } from "./png.mjs";

export const APPLE_LICENSE_NOTE =
  "Apple 'App Store Marketing Artwork License Agreement' (shipped inside the download): " +
  "limited, non-exclusive, NON-TRANSFERABLE license to use the product images only in " +
  "connection with your applications available on the App Store, and only while you are " +
  "a member of the Apple Developer Program; Apple remains the exclusive owner of the " +
  "artwork. Redistribution is not permitted — plinth therefore never commits this art " +
  "and downloads it from Apple's own CDN to your local cache after you accept the license.";

/**
 * Pinned to the packages published on developer.apple.com/design/resources
 * as of 2026-09-25. Checksums are of the extracted PNG (primary) and the
 * .dmg (transport). holePx values are measured from the art's alpha
 * channel and double-checked against the device point spec × scale.
 */
export const FRAME_MANIFEST = {
  "iphone-16-pro": {
    dmgUrl: "https://devimages-cdn.apple.com/design/resources/download/Bezel-iPhone-16.dmg",
    dmgSha256: "215af02c6cb651f3f5dc57bcd01537b07356917d6caf2edfd418dbeb4a675512",
    pathInDmg: "Bezel-iPhone-16/PNG/iPhone 16 Pro/iPhone 16 Pro - Black Titanium - Portrait.png",
    pngSha256: "fc75b1ffbaa10108a7790fe571ae8eaf5e8a850f165278b03d416aa02443076a",
    scale: 3,
    attribution: "iPhone 16 Pro bezel © Apple Inc., Apple Design Resources (App Store Marketing Artwork License)",
  },
  "ipad-pro-11": {
    dmgUrl: "https://devimages-cdn.apple.com/design/resources/download/Bezel-iPad-Pro-(M5).dmg",
    dmgSha256: "ebde5f7249d416ad83d2d14881c31a0ae3ed8343643d26a0fbf61195aeb06f0f",
    pathInDmg: 'Bezel-iPad-Pro-(M5)/PNG/iPad Pro (M5) 11" - Space Black - Portrait.png',
    pngSha256: "7b7a8fb474f30d7076a48739b61b5f6d5a79fb1e7860471456d5d42fc6dfa670",
    scale: 2,
    attribution: 'iPad Pro (M5) 11" bezel © Apple Inc., Apple Design Resources (App Store Marketing Artwork License)',
  },
  "macbook-14": {
    dmgUrl: "https://devimages-cdn.apple.com/design/resources/download/Bezel-MacBook-Pro-M5.dmg",
    dmgSha256: "24023114c9d04e5e2f9fee50f37152520f36dcefc5695437e9c4b72e10316ba3",
    pathInDmg: "Bezel-MacBook-Pro-M5/PNG/MacBook Pro M5 14-inch Space Black.png",
    pngSha256: "1863c54dd9464f198ca5b83ff8c3d7b0168cebf8d7028d92b5e6d7d2298c6d57",
    scale: 2,
    attribution: "MacBook Pro M5 14\" bezel © Apple Inc., Apple Design Resources (App Store Marketing Artwork License)",
  },
};

export function framesCacheDir() {
  return process.env.PLINTH_FRAMES_DIR ?? path.join(homedir(), ".cache", "plinth", "frames");
}

export function cachedFramePath(deviceId) {
  return path.join(framesCacheDir(), `${deviceId}.png`);
}

/** The cached frame for a device, or null when not fetched yet. */
export function findFrame(deviceId, override) {
  if (override) {
    if (!existsSync(override)) throw new Error(`--frame file not found: ${override}`);
    return override;
  }
  const cached = cachedFramePath(deviceId);
  return existsSync(cached) ? cached : null;
}

/**
 * Analyze a frame PNG: flood-fill the exterior transparency from the
 * borders; everything transparent that is NOT exterior is the screen
 * cutout. Returns the hole bbox, an alpha mask PNG cropped to the bbox
 * (255 = show content, honoring the art's own anti-aliased edge and
 * rounded corners/island), and the decoded art.
 */
export function analyzeFrame(file) {
  const buf = readFileSync(file);
  const img = decodePng(buf);
  const { width: W, height: H } = img;
  const exterior = new Uint8Array(W * H);
  const stack = [];
  const alphaAt = (x, y) => getPixel(img, x, y)[3];
  const push = (x, y) => {
    const i = y * W + x;
    if (!exterior[i] && alphaAt(x, y) < 250) {
      exterior[i] = 1;
      stack.push(x, y);
    }
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }

  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!exterior[y * W + x] && alphaAt(x, y) < 250) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`no screen cutout found in frame: ${file}`);
  const hole = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  // Device body bounds (opaque art) — the 3D body silhouette.
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -1, bMaxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x += 2) {
      if (alphaAt(x, y) > 250) {
        if (x < bMinX) bMinX = x;
        if (x > bMaxX) bMaxX = x;
        if (y < bMinY) bMinY = y;
        if (y > bMaxY) bMaxY = y;
      }
    }
  }
  const bodyBox = { x: bMinX, y: bMinY, width: bMaxX - bMinX + 1, height: bMaxY - bMinY + 1 };

  // True device edges via a cross-scan through the cutout center: the
  // alpha bbox above includes soft shadows and protruding buttons, which
  // would inflate the 3D silhouette.
  const cy = Math.round(hole.y + hole.height / 2);
  const cx = Math.round(hole.x + hole.width / 2);
  let left = 0, right = W - 1, top = 0, bottom = H - 1;
  while (left < W && alphaAt(left, cy) <= 250) left++;
  while (right > 0 && alphaAt(right, cy) <= 250) right--;
  while (top < H && alphaAt(cx, top) <= 250) top++;
  while (bottom > 0 && alphaAt(cx, bottom) <= 250) bottom--;
  const deviceBox = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };

  // Mask cropped to the hole: content shows where the art is transparent
  // (and not exterior); partial alpha at the cutout edge inverts so the
  // screenshot anti-aliases into the art's own corner curve.
  const mask = Buffer.alloc(hole.width * hole.height * 4);
  for (let y = 0; y < hole.height; y++) {
    for (let x = 0; x < hole.width; x++) {
      const gx = hole.x + x;
      const gy = hole.y + y;
      const i = (y * hole.width + x) * 4;
      const a = exterior[gy * W + gx] ? 255 : alphaAt(gx, gy);
      const show = 255 - a;
      mask[i] = 255; mask[i + 1] = 255; mask[i + 2] = 255; mask[i + 3] = show;
    }
  }
  // Outer silhouette of the opaque art (device incl. buttons), traced as
  // a row-scan polygon: left edge top→bottom, right edge bottom→top.
  // This is the 3D slab's outline, so it hugs the art's own corner
  // curves exactly (no wedges, no gaps).
  const step = 2;
  const leftEdge = [];
  const rightEdge = [];
  for (let y = bMinY; y <= bMaxY; y += step) {
    let l = -1, r = -1;
    for (let x = bMinX; x <= bMaxX; x++) {
      if (alphaAt(x, y) > 200) { l = x; break; }
    }
    for (let x = bMaxX; x >= bMinX; x--) {
      if (alphaAt(x, y) > 200) { r = x; break; }
    }
    if (l >= 0 && r > l) {
      leftEdge.push([l, y]);
      rightEdge.push([r, y]);
    }
  }
  const bodyOutline = [...rightEdge, ...leftEdge.reverse()];

  return { file, buf, img, hole, bodyBox, deviceBox, bodyOutline, maskPng: encodePng(hole.width, hole.height, mask) };
}
