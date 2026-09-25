/**
 * Playwright capture at exact device viewports, DPR-correct.
 * Uses playwright-core driving an installed Chrome/Chromium — no
 * browser download. Install: `cd skills/plinth && npm install`.
 */

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  throw new Error(
    "playwright-core is not installed. Run `npm install` in the plinth skill directory (skills/plinth).",
  );
}

function launchOptions() {
  // SwiftShader keeps WebGL available (and deterministic) on machines
  // without a GPU — required by the 3D renderer.
  const args = ["--enable-unsafe-swiftshader"];
  // Chrome refuses to sandbox as root (CI containers, cloud VMs).
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  const executablePath = process.env.PLINTH_BROWSER || undefined;
  return executablePath ? { executablePath, args } : { channel: "chrome", args };
}

export async function withBrowser(fn) {
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
  } catch (err) {
    throw new Error(
      `could not launch Chrome (${err.message.split("\n")[0]}). ` +
        "Install Google Chrome/Chromium or point PLINTH_BROWSER at a browser binary.",
    );
  }
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/**
 * Capture one screenshot. Returns { buffer, pxWidth, pxHeight }.
 * options: { viewport, dpr, dark, hide[], waitMs, fullPage, media }
 */
export async function capture(browser, url, opts) {
  const context = await browser.newContext({
    viewport: opts.viewport,
    deviceScaleFactor: opts.dpr,
    colorScheme: opts.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});

    if (opts.hide?.length) {
      await page.addStyleTag({
        content: `${opts.hide.join(",")} { display: none !important; visibility: hidden !important; }`,
      });
    }

    if (opts.fullPage) {
      // Walk the page so lazy images load before a tall capture.
      await page.evaluate(async () => {
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      }).catch(() => {});
    }

    await page.waitForTimeout(opts.waitMs ?? 800);
    const buffer = await page.screenshot({ type: "png", fullPage: Boolean(opts.fullPage) });
    return {
      buffer,
      pxWidth: buffer.readUInt32BE(16),
      pxHeight: buffer.readUInt32BE(20),
    };
  } finally {
    await context.close();
  }
}
