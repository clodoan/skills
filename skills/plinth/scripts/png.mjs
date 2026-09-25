/**
 * Minimal PNG reader for verification — dimensions + pixel sampling.
 * Supports 8-bit RGB / RGBA / grayscale, non-interlaced (what Chromium
 * screenshots produce). Uses node:zlib; no dependencies.
 */

import zlib from "node:zlib";

export function pngSize(buf) {
  if (buf.readUInt32BE(12) !== 0x49484452) throw new Error("not a PNG (no IHDR)");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function decodePng(buf) {
  const { width, height } = pngSize(buf);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += Math.floor((a + b) / 2); break;
        case 4: v += paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Returns [r, g, b, a] at integer (x, y); throws outside the image. */
export function getPixel(img, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new RangeError(`pixel (${x}, ${y}) outside ${img.width}×${img.height} image`);
  }
  const i = (y * img.width + x) * img.channels;
  const p = img.pixels;
  switch (img.channels) {
    case 1: return [p[i], p[i], p[i], 255];
    case 2: return [p[i], p[i], p[i], p[i + 1]];
    case 3: return [p[i], p[i + 1], p[i + 2], 255];
    case 4: return [p[i], p[i + 1], p[i + 2], p[i + 3]];
    default: throw new Error(`bad channel count ${img.channels}`);
  }
}

export function colorDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}
