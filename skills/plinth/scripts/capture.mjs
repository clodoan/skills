/**
 * Playwright capture at exact device viewports, DPR-correct.
 * Uses playwright-core driving an installed Chrome/Chromium — no
 * browser download. Install: `cd skills/plinth && npm install`.
 */

import { createRequire } from "node:module";
import process from "node:process";

import { pngSize } from "./png.mjs";

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

// Headless Chrome advertises "HeadlessChrome" in its UA, which bot walls
// (e.g. Cloudflare on x.ai) block outright. Present the UA of the device
// being framed instead; Chrome versions come from the running browser.
// iOS 18 matches the chrome plinth draws. iPadOS Safari requests desktop
// sites by default, so the iPad sends the Mac Safari UA (plus touch).
const IOS = "18_0";
const SAFARI = "18.0";

function userAgent(browser, device) {
  const chrome = `Chrome/${browser.version().split(".")[0]}.0.0.0`;
  if (device.os === "ios" && device.kind === "phone") {
    return `Mozilla/5.0 (iPhone; CPU iPhone OS ${IOS} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${SAFARI} Mobile/15E148 Safari/604.1`;
  }
  if (device.os === "ios") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${SAFARI} Safari/605.1.15`;
  }
  if (device.os === "android") {
    return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Mobile Safari/537.36`;
  }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
}

/**
 * Capture one screenshot. Returns { buffer, pxWidth, pxHeight }.
 * options: { device, viewport, dpr, dark, hide[], waitMs, fullPage }
 *
 * Phones and tablets get touch input (coarse pointer, touch points) but
 * not Playwright's isMobile: isMobile honors <meta viewport>, and a page
 * without one lays out at 980px and zooms out, which breaks DPR-exact
 * capture (one row short) and full-page scroll captures (2.4× wide).
 * Pages therefore always lay out at the device width.
 */
export async function capture(browser, url, opts) {
  const context = await browser.newContext({
    viewport: opts.viewport,
    deviceScaleFactor: opts.dpr,
    colorScheme: opts.dark ? "dark" : "light",
    reducedMotion: "reduce",
    userAgent: userAgent(browser, opts.device),
    hasTouch: opts.device.kind === "phone" || opts.device.kind === "tablet",
    // --hide injects a <style>; strict style-src CSPs would block it.
    bypassCSP: true,
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
    const { width, height } = pngSize(buffer);
    return { buffer, pxWidth: width, pxHeight: height };
  } finally {
    await context.close();
  }
}
