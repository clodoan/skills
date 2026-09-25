/**
 * render3d — drives the three.js render page (scripts/three/) in the
 * same headless Chrome plinth already uses. Serves three from
 * node_modules plus in-memory screen textures over a loopback HTTP
 * server, assembles per-device geometry from the verified spec table,
 * and exports stills (canvas.toDataURL, alpha-exact) or a seamless
 * float/turntable mp4/gif through ffmpeg.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { frameSize, squirclePoints, bodyThickness, buildScreenHtml } from "./devices.mjs";

const require = createRequire(import.meta.url);
const PAGE_DIR = fileURLToPath(new URL("./three", import.meta.url));
// three's exports map hides subpaths (even package.json) from
// require.resolve; the bare specifier resolves into build/, so anchor
// there. three.module.js imports sibling files (three.core.js), so the
// whole build dir is served.
const THREE_BUILD_DIR = path.dirname(require.resolve("three"));
const THREE_ADDONS = path.join(THREE_BUILD_DIR, "..", "examples", "jsm");

function offsetPoints(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

function circlePoints(cx, cy, r, n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });
}

/** Geometry payload for one device, in outer-frame pt coordinates. */
export function deviceGeometry(device, { buttons = false } = {}) {
  const b = device.bezel;
  const pt = device.pt;
  switch (device.kind) {
    case "phone":
    case "tablet": {
      const size = frameSize(device);
      const outerR = device.screenRadius + b;
      const screenPts = offsetPoints(squirclePoints(pt.width, pt.height, device.screenRadius), b, b);
      const geo = {
        outer: { width: size.width, height: size.height, points: squirclePoints(size.width, size.height, outerR) },
        plate: {
          outerPoints: offsetPoints(squirclePoints(size.width - 5, size.height - 5, outerR - 2.5), 2.5, 2.5),
          innerPoints: screenPts,
        },
        screen: { points: screenPts },
        thickness: bodyThickness(device),
      };
      if (device.island) {
        const i = device.island;
        geo.island = {
          points: offsetPoints(
            squirclePoints(i.width, i.height, i.height / 2, 8),
            b + (pt.width - i.width) / 2, b + i.y,
          ),
        };
      } else if (device.punchHole) {
        geo.island = { points: circlePoints(b + pt.width / 2, b + device.punchHole.cy, device.punchHole.d / 2) };
      }
      if (buttons && device.kind === "phone") {
        geo.buttons = [
          { x: 0, y: 164, w: 4, h: 28 },
          { x: 0, y: 220, w: 4, h: 48 },
          { x: 0, y: 278, w: 4, h: 48 },
          { x: size.width, y: 245, w: 4, h: 74 },
        ];
      }
      return geo;
    }
    case "laptop": {
      const lidW = pt.width + 2 * b;
      const lidH = pt.height + 2 * b;
      const deckW = lidW + 2 * device.deck.overhang;
      return {
        // The 2D frame box includes the deck below the lid; flat view
        // must shift the lid up by half that extra height to keep the
        // screen at its spec position.
        frameHeight: frameSize(device).height,
        outer: { width: lidW, height: lidH, points: squirclePoints(lidW, lidH, 16) },
        plate: {
          outerPoints: offsetPoints(squirclePoints(lidW - 4, lidH - 4, 14), 2, 2),
          innerPoints: offsetPoints(squirclePoints(pt.width, pt.height, device.screenRadius), b, b),
        },
        screen: { points: offsetPoints(squirclePoints(pt.width, pt.height, device.screenRadius), b, b) },
        thickness: bodyThickness(device),
        deck: { width: deckW, depth: 230, thickness: 7, points: squirclePoints(deckW, 230, 16) },
      };
    }
    case "browser": {
      const size = frameSize(device);
      return {
        outer: { width: size.width, height: size.height, points: squirclePoints(size.width, size.height, device.outerRadius) },
        screen: { points: offsetPoints(squirclePoints(size.width - 2, size.height - 2, device.outerRadius - 1), 1, 1) },
        thickness: bodyThickness(device),
        screenZ: bodyThickness(device) / 2 + 0.2,
      };
    }
    default: {
      const exhaustive = device.kind;
      throw new Error(`unhandled device kind: ${exhaustive}`);
    }
  }
}

function startServer(config, textures, fonts) {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const send = (body, type) => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (url === "/" || url === "/render.html") {
        return send(readFileSync(path.join(PAGE_DIR, "render.html")), "text/html");
      }
      if (url === "/scene.mjs") return send(readFileSync(path.join(PAGE_DIR, "scene.mjs")), "text/javascript");
      if (url.startsWith("/vendor/build/")) {
        const rel = path.normalize(url.slice("/vendor/build/".length));
        if (rel.startsWith("..")) throw new Error("bad path");
        return send(readFileSync(path.join(THREE_BUILD_DIR, rel)), "text/javascript");
      }
      if (url.startsWith("/vendor/addons/")) {
        const rel = path.normalize(url.slice("/vendor/addons/".length));
        if (rel.startsWith("..")) throw new Error("bad path");
        return send(readFileSync(path.join(THREE_ADDONS, rel)), "text/javascript");
      }
      if (url === "/config.json") return send(JSON.stringify(config), "application/json");
      const tex = url.match(/^\/tex\/(\d+)\.png$/);
      if (tex) return send(textures[Number(tex[1])], "image/png");
      res.writeHead(404); res.end();
    } catch (err) {
      res.writeHead(500); res.end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function withScene(browser, config, textures, fn) {
  const { server, port } = await startServer(config, textures);
  const context = await browser.newContext({
    viewport: {
      width: Math.ceil(config.stage.width) + 20,
      height: Math.ceil(config.stage.height) + 20,
    },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/render.html`, { waitUntil: "load" });
    await page.waitForFunction("window.__ready === true", { timeout: 60000 }).catch(() => {
      throw new Error(`3D scene failed to initialize${errors.length ? `: ${errors[0]}` : ""}`);
    });
    return await fn(page);
  } finally {
    await context.close();
    server.close();
  }
}

export async function renderStill(browser, config, textures) {
  return withScene(browser, config, textures, async (page) => {
    const dataUrl = await page.evaluate(() => window.__plinth.renderStill());
    return Buffer.from(dataUrl.split(",")[1], "base64");
  });
}

export async function renderLoop(browser, config, textures, outFile, { seconds = 4, fps = 30 } = {}) {
  return withScene(browser, config, textures, async (page) => {
    const frames = Math.round(seconds * fps);
    const isGif = outFile.endsWith(".gif");
    const vf = isGif
      ? "scale=trunc(iw/4)*2:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse"
      : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    const args = [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps),
      "-i", "-", ...(isGif ? ["-filter_complex", vf] : ["-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "21"]),
      outFile,
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
    for (let i = 0; i < frames; i++) {
      const dataUrl = await page.evaluate((args2) => window.__plinth.renderFrame(args2.i, args2.n), { i, n: frames });
      const frame = Buffer.from(dataUrl.split(",")[1], "base64");
      if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await new Promise((resolve, reject) => {
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return frames;
  });
}
