#!/usr/bin/env node
/**
 * statesheet — contact sheets and transition tables for React component
 * state.
 *
 *   sheet    mount a component in every declared state (no Storybook)
 *            and render state × viewport × light/dark into one
 *            pixel-verified contact-sheet PNG
 *   scan     find components whose state is a pile of boolean useStates
 *   propose  generate a reducer with an explicit transition table for
 *            one of those piles
 *
 * Exit codes: 0 ok, 1 a verification check failed, 2 usage/runtime error.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { serve } from "./mount.mjs";
import { computeLayout, sheetHtml, renderSheet, verifySheet } from "./compose.mjs";
import { scan, propose, scanSource } from "./analyze.mjs";

const require = createRequire(import.meta.url);

const EXIT_CHECK = 1;
const EXIT_USAGE = 2;

function usage() {
  return `Usage:
  statesheet.mjs sheet <states-file> [options]
      --out <file.png>      output path (default <name>-statesheet.png)
      --viewports <list>    comma-separated widths (default 375,768,1280)
      --themes <list>       light,dark (default both)
      --states <list>       subset of states to render (default all)
      --scale <n>           display scale for captures (default 0.5)
      --max-height <px>     max capture height per cell (default 800)
      --wait <ms>           settle time after render (default 200)
      --alias <k=v>         bundler alias, repeatable (e.g. shared=./src/shared)
      --node-paths <list>   extra module roots, relative to the states file

  statesheet.mjs scan <dir|file> [--min <n>] [--json]
  statesheet.mjs propose <file> [--component <Name>] [--write]

Environment: STATESHEET_BROWSER=<path> to pick the Chrome/Chromium binary.`;
}

class UsageError extends Error {}

function parseList(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv, spec) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    const def = spec[arg];
    if (!def) throw new UsageError(`unknown option: ${arg}`);
    if (def === "flag") {
      opts[arg.slice(2)] = true;
    } else {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`missing value for ${arg}`);
      if (def === "multi") (opts[arg.slice(2)] ??= []).push(value);
      else opts[arg.slice(2)] = value;
    }
  }
  return opts;
}

// ---------------------------------------------------------------- browser

function launchOptions() {
  const args = [];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  const executablePath = process.env.STATESHEET_BROWSER || undefined;
  return executablePath ? { executablePath, args } : { channel: "chrome", args };
}

async function withBrowser(fn) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    throw new UsageError(
      "playwright-core is not installed. Run `npm install` in the statesheet skill directory (skills/statesheet).",
    );
  }
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
  } catch (err) {
    throw new UsageError(
      `could not launch Chrome (${err.message.split("\n")[0]}). ` +
        "Install Google Chrome/Chromium or point STATESHEET_BROWSER at a browser binary.",
    );
  }
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- sheet

async function readHarness(page, timeoutMs) {
  await page.waitForFunction(() => window.__statesheet && window.__statesheet.ready, null, {
    timeout: timeoutMs,
  });
  return page.evaluate(() => window.__statesheet);
}

export async function captureCells(browser, baseUrl, { states, viewports, themes, waitMs, maxHeight, minHeight }) {
  const sizes = new Map();
  const images = new Map();
  const bgs = new Map();
  const columns = [];
  for (const theme of themes) for (const viewport of viewports) columns.push({ viewport, theme });

  for (let j = 0; j < columns.length; j++) {
    const { viewport, theme } = columns[j];
    const context = await browser.newContext({
      viewport: { width: viewport, height: maxHeight },
      deviceScaleFactor: 2,
      colorScheme: theme,
      reducedMotion: "reduce",
      timezoneId: "UTC",
      locale: "en-US",
    });
    try {
      const page = await context.newPage();
      for (const state of states) {
        const url = `${baseUrl}/?state=${encodeURIComponent(state)}&theme=${theme}`;
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        const status = await readHarness(page, 15000);
        if (status.error) {
          throw new Error(`state "${state}" (${viewport}px, ${theme}) failed to render:\n${status.error}`);
        }
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await page.waitForTimeout(waitMs);
        const measured = await page.evaluate(() => {
          // Measure the rendered content, not the #root box: app global
          // styles often stretch #root to 100% height, which would turn
          // every cell into a full-viewport capture. Union the root's
          // children with any portals mounted directly on <body>.
          const root = document.getElementById("root");
          const pad = parseFloat(getComputedStyle(root).paddingBottom) || 0;
          let bottom = 0;
          const consider = (el) => {
            const r = el.getBoundingClientRect();
            if (r.height > 0) bottom = Math.max(bottom, r.bottom);
          };
          for (const child of root.children) consider(child);
          for (const child of document.body.children) {
            if (child !== root && child.tagName !== "SCRIPT" && child.tagName !== "STYLE") consider(child);
          }
          const height = bottom > 0 ? Math.ceil(bottom + pad) : Math.ceil(root.getBoundingClientRect().height);
          const bg = getComputedStyle(document.body).backgroundColor;
          return { height, bg };
        });
        const cssH = Math.max(minHeight, Math.min(maxHeight, measured.height));
        const buffer = await page.screenshot({
          type: "png",
          clip: { x: 0, y: 0, width: viewport, height: cssH },
        });
        const key = `${state}|${j}`;
        sizes.set(key, { cssW: viewport, cssH });
        images.set(key, buffer.toString("base64"));
        // "rgba(0, 0, 0, 0)" (no explicit bg) → let color-scheme defaults show.
        bgs.set(key, measured.bg === "rgba(0, 0, 0, 0)" ? (theme === "dark" ? "#121212" : "#ffffff") : measured.bg);
      }
    } finally {
      await context.close();
    }
  }
  return { columns, sizes, images, bgs };
}

async function cmdSheet(argv) {
  const opts = parseArgs(argv, {
    "--out": "value",
    "--viewports": "value",
    "--themes": "value",
    "--states": "value",
    "--scale": "value",
    "--max-height": "value",
    "--wait": "value",
    "--alias": "multi",
    "--node-paths": "value",
  });
  const statesFile = opts._[0];
  if (!statesFile) throw new UsageError("sheet: missing <states-file>");
  if (!fs.existsSync(statesFile)) throw new UsageError(`sheet: no such file: ${statesFile}`);

  const viewports = (opts.viewports ? parseList(opts.viewports) : ["375", "768", "1280"]).map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 200 || n > 4000) throw new UsageError(`sheet: bad viewport "${v}"`);
    return n;
  });
  const themes = opts.themes ? parseList(opts.themes) : ["light", "dark"];
  for (const t of themes) {
    if (t !== "light" && t !== "dark") throw new UsageError(`sheet: bad theme "${t}" (light|dark)`);
  }
  const scale = opts.scale ? Number(opts.scale) : 0.5;
  if (!(scale > 0.05 && scale <= 1)) throw new UsageError("sheet: --scale must be in (0.05, 1]");
  const maxHeight = opts["max-height"] ? Number(opts["max-height"]) : 800;
  if (!(maxHeight >= 120 && maxHeight <= 4000)) throw new UsageError("sheet: --max-height must be 120..4000");
  const waitMs = opts.wait ? Number(opts.wait) : 200;
  if (!(waitMs >= 0 && waitMs <= 60000)) throw new UsageError("sheet: --wait must be 0..60000");

  const alias = {};
  for (const pair of opts.alias ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`sheet: bad --alias "${pair}" (want key=path)`);
    alias[pair.slice(0, eq)] = path.resolve(path.dirname(path.resolve(statesFile)), pair.slice(eq + 1));
  }
  const nodePaths = opts["node-paths"] ? parseList(opts["node-paths"]) : undefined;

  console.log(`statesheet · bundling ${statesFile}`);
  const server = await serve(statesFile, { alias, nodePaths });
  try {
    return await withBrowser(async (browser) => {
      // Metadata pass: read state names and component name from the harness.
      const meta = await (async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(`${server.url}/`, { waitUntil: "load", timeout: 30000 });
          const status = await readHarness(page, 15000);
          if (status.error) throw new Error(`states file failed to load:\n${status.error}`);
          return status.config;
        } finally {
          await context.close();
        }
      })();

      let states = meta.states;
      if (states.length === 0) throw new UsageError("sheet: the states file declares no states");
      if (opts.states) {
        const want = parseList(opts.states);
        const unknown = want.filter((s) => !states.includes(s));
        if (unknown.length > 0) throw new UsageError(`sheet: unknown states: ${unknown.join(", ")} (have: ${states.join(", ")})`);
        states = want;
      }
      const name = meta.name || path.basename(statesFile).replace(/\.states\.[jt]sx?$/, "").replace(/\.[jt]sx?$/, "");
      const out = path.resolve(opts.out || `${name.toLowerCase()}-statesheet.png`);

      console.log(`statesheet · ${name}: ${states.length} states × ${viewports.join("/")}px × ${themes.join("+")}`);
      const { columns, sizes, images, bgs } = await captureCells(browser, server.url, {
        states,
        viewports,
        themes,
        waitMs,
        maxHeight,
        minHeight: 96,
      });

      const layout = computeLayout({ states, columns, sizes, scale });
      const subtitle = `${states.length} states · ${viewports.join(" / ")}px · ${themes.join(" + ")} · scale ${scale} · ${new Date().toISOString().slice(0, 10)}`;
      const html = sheetHtml({
        title: `${name} — statesheet`,
        subtitle,
        states,
        columns,
        cellImages: images,
        cellBg: bgs,
        layout,
      });
      const buffer = await renderSheet(browser, html, layout);

      const checks = verifySheet(buffer, layout);
      let failed = false;
      for (const check of checks) {
        console.log(`check: ${check.name} — ${check.ok ? "ok" : `FAIL (${check.detail})`}`);
        if (!check.ok) failed = true;
      }
      if (failed) {
        console.error("statesheet: verification failed — not writing the sheet");
        return EXIT_CHECK;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buffer);
      console.log(`statesheet · wrote ${out} (${layout.width * 2}×${layout.height * 2} px)`);
      return 0;
    });
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------- scan

function cmdScan(argv) {
  const opts = parseArgs(argv, { "--min": "value", "--json": "flag" });
  const root = opts._[0];
  if (!root) throw new UsageError("scan: missing <dir|file>");
  if (!fs.existsSync(root)) throw new UsageError(`scan: no such path: ${root}`);
  const min = opts.min ? Number(opts.min) : 2;
  if (!(Number.isInteger(min) && min >= 1)) throw new UsageError("scan: --min must be a positive integer");

  const { scanned, piles } = scan(root, { min });
  if (opts.json) {
    console.log(JSON.stringify({ scanned, piles }, null, 2));
    return 0;
  }
  console.log(`statesheet scan · ${scanned} files · ${piles.length} boolean pile(s) with ≥${min} booleans`);
  for (const pile of piles) {
    const rel = path.relative(process.cwd(), pile.file);
    const extra = [
      pile.companions.length > 0 ? `+${pile.companions.length} companion(s): ${pile.companions.map((b) => b.name).join(", ")}` : null,
      pile.usesReducer ? "already uses a reducer" : null,
    ].filter(Boolean).join("; ");
    console.log(
      `  ${rel}:${pile.line} ${pile.name} — ${pile.booleans.length} boolean useStates: ` +
        `${pile.booleans.map((b) => b.name).join(", ")} → ${2 ** pile.booleans.length} combos` +
        (extra ? ` (${extra})` : ""),
    );
  }
  if (piles.length > 0) {
    console.log(`Next: statesheet.mjs propose <file> --component <Name>`);
  }
  return 0;
}

// ---------------------------------------------------------------- propose

function cmdPropose(argv) {
  const opts = parseArgs(argv, { "--component": "value", "--write": "flag" });
  const file = opts._[0];
  if (!file) throw new UsageError("propose: missing <file>");
  if (!fs.existsSync(file)) throw new UsageError(`propose: no such file: ${file}`);

  const source = fs.readFileSync(file, "utf8");
  const hits = scanSource(source, file);
  if (hits.length === 0) throw new UsageError(`propose: no boolean useState piles found in ${file}`);
  let pile;
  if (opts.component) {
    pile = hits.find((h) => h.name === opts.component);
    if (!pile) {
      throw new UsageError(
        `propose: no component "${opts.component}" with boolean state in ${file} (found: ${hits.map((h) => h.name).join(", ")})`,
      );
    }
  } else {
    pile = hits.reduce((a, b) => (b.booleans.length > a.booleans.length ? b : a));
  }

  const proposal = propose(pile);
  console.log(`statesheet propose · ${proposal.summary}`);
  if (pile.usesReducer) console.log("note: this component already calls useReducer — fold the booleans into it instead of adding a second machine.");
  if (opts.write) {
    const outFile = path.join(path.dirname(file), `${proposal.component}.statesheet-reducer.ts`);
    fs.writeFileSync(outFile, proposal.code);
    console.log(`statesheet propose · wrote ${outFile}`);
  } else {
    console.log("");
    console.log(proposal.code);
  }
  return 0;
}

// ---------------------------------------------------------------- main

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "sheet":
      return await cmdSheet(rest);
    case "scan":
      return cmdScan(rest);
    case "propose":
      return cmdPropose(rest);
    case "-h":
    case "--help":
    case undefined:
      console.log(usage());
      return command === undefined ? EXIT_USAGE : 0;
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError) {
      console.error(`statesheet: ${err.message}`);
      console.error("");
      console.error(usage());
    } else {
      console.error(`statesheet: ${err?.message ?? err}`);
    }
    process.exit(EXIT_USAGE);
  },
);
