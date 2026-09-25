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
  const args = [];
  // Chrome refuses to sandbox as root (CI containers, cloud VMs).
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  const executablePath = process.env.PLINTH_BROWSER || undefined;
  return executablePath ? { executablePath, args } : { channel: "chrome", args };
}

/** True when the browser the CLI would use can be launched. */
export async function browserAvailable() {
  try {
    await (await chromium.launch(launchOptions())).close();
    return true;
  } catch {
    return false;
  }
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
// Headless Chrome advertises "HeadlessChrome" in its UA, which bot walls
// (e.g. Cloudflare on x.ai) block outright. Present the equivalent
// stable-Chrome UA instead — same engine, honest version.
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export async function capture(browser, url, opts) {
  const context = await browser.newContext({
    viewport: opts.viewport,
    deviceScaleFactor: opts.dpr,
    colorScheme: opts.dark ? "dark" : "light",
    reducedMotion: "reduce",
    userAgent: CHROME_UA,
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
