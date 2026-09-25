#!/usr/bin/env node
/**
 * chip — fails loudly until the work is chipped into a small, reviewable step.
 *
 * Inspects a git diff (working tree vs base, or an explicit range), measures
 * lines changed, files touched, top-level areas touched, and risky surfaces
 * (lockfiles, migrations, public API, CI config), and compares against budgets.
 *
 * Zero dependencies. Node >= 18. Exit codes: 0 pass/overridden, 1 over budget,
 * 2 usage or git error.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  base: null, // auto-detect: origin/main, origin/master, main, master
  budgets: {
    maxLines: 400,
    maxFiles: 15,
    maxAreas: 3,
    maxRiskySurfaces: 1,
  },
  // Top-level dirs whose *children* are the real areas (monorepo layouts).
  workspaceRoots: ["packages", "apps", "libs", "crates", "services", "modules"],
  // Globs excluded from the line budget (still counted as files / risky).
  ignoreLines: [],
  risky: {
    lockfiles: [
      "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock",
      "bun.lockb", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock",
      "go.sum", "composer.lock", "Pipfile.lock", "deno.lock",
    ],
    migrations: [
      "**/migrations/**", "**/migrate/**", "**/schema.prisma",
      "**/schema.rb", "**/structure.sql",
    ],
    ci: [
      ".github/workflows/**", ".gitlab-ci.yml", ".circleci/**",
      "Jenkinsfile", ".buildkite/**", "azure-pipelines.yml",
    ],
    publicApi: [
      "package.json", "pyproject.toml", "Cargo.toml", "src/index.*",
      "**/public-api.*", "**/*.d.ts", "openapi.{json,yaml,yml}",
    ],
  },
};

const RISKY_LABELS = {
  lockfiles: "lockfile",
  migrations: "migration",
  ci: "CI config",
  publicApi: "public API / exports",
};

function usage() {
  return `Usage: chip.mjs [options]

Checks the current git diff against size budgets and fails if the change
is not chipped into a small enough step.

Options:
  --base <ref>        Base ref to diff against (default: chip.config.json
                      "base", else origin/main, origin/master, main, master)
  --range <a..b>      Check an explicit commit range instead of the working
                      tree (e.g. origin/main..HEAD)
  --config <path>     Config file (default: chip.config.json at repo root)
  --override <reason> Explicit escape hatch: report but exit 0. Empty string
                      is ignored (safe to pass through from CI).
  --json              Machine-readable output
  -h, --help          Show this help

Escape hatch without a flag: add a commit trailer to any commit in the range:
  Chip-Override: <reason>
`;
}

function fail(msg) {
  process.stderr.write(`chip: error: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { base: null, range: null, config: null, override: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${a} requires a value`);
      return argv[++i];
    };
    if (a === "--base") args.base = next();
    else if (a === "--range") args.range = next();
    else if (a === "--config") args.config = next();
    else if (a === "--override") args.override = next();
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else fail(`unknown option ${a}\n\n${usage()}`);
  }
  if (args.override !== null && args.override.trim() === "") args.override = null;
  return args;
}

function git(cliArgs, { allowFail = false } = {}) {
  try {
    return execFileSync("git", cliArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowFail) return null;
    fail(`git ${cliArgs.join(" ")} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

function loadConfig(explicitPath) {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const path = explicitPath ?? join(root, "chip.config.json");
  if (!existsSync(path)) {
    if (explicitPath) fail(`config file not found: ${path}`);
    return structuredClone(DEFAULTS);
  }
  let user;
  try {
    user = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`could not parse ${path}: ${err.message}`);
  }
  const cfg = structuredClone(DEFAULTS);
  if (user.base) cfg.base = user.base;
  Object.assign(cfg.budgets, user.budgets ?? {});
  if (user.workspaceRoots) cfg.workspaceRoots = user.workspaceRoots;
  if (user.ignoreLines) cfg.ignoreLines = user.ignoreLines;
  Object.assign(cfg.risky, user.risky ?? {});
  return cfg;
}

function detectBase() {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }) !== null) {
      return ref;
    }
  }
  fail("could not auto-detect a base ref; pass --base <ref> or set \"base\" in chip.config.json");
}

/** Minimal glob matcher: supports **, *, ?, {a,b}. No-slash patterns match basenames. */
function globToRegExp(glob) {
  const esc = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 3; }
      else { re += ".*"; i += 2; }
    } else if (c === "*") { re += "[^/]*"; i += 1; }
    else if (c === "?") { re += "[^/]"; i += 1; }
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) { re += esc(c); i += 1; }
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map(esc).join("|") + ")";
        i = end + 1;
      }
    } else { re += esc(c); i += 1; }
  }
  return new RegExp(`^${re}$`);
}

function matchesGlob(file, glob) {
  const target = glob.includes("/") ? file : file.split("/").pop();
  return globToRegExp(glob).test(target);
}

function matchesAny(file, globs) {
  return globs.some((g) => matchesGlob(file, g));
}

/** Line count for an untracked file; binary files (NUL in first 8 KiB) count 0. */
function countFileLines(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return 0;
  }
  if (buf.subarray(0, 8192).includes(0)) return 0;
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 10) n += 1;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/** Resolve rename notation from --numstat ("{old => new}/x" or "old => new"). */
function normalizePath(p) {
  const brace = /\{[^{}]* => ([^{}]*)\}/;
  if (brace.test(p)) return p.replace(brace, "$1").replace(/\/{2,}/g, "/").replace(/^\//, "");
  const arrow = p.indexOf(" => ");
  return arrow === -1 ? p : p.slice(arrow + 4);
}

function areaOf(file, workspaceRoots) {
  const parts = file.split("/");
  if (parts.length === 1) return "(root)";
  if (workspaceRoots.includes(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function collectDiff(args, cfg) {
  let mergeBase;
  let diffTarget = null; // null = working tree
  let headRef = "HEAD";
  if (args.range) {
    const m = args.range.match(/^(.+?)\.{2,3}(.+)$/);
    if (!m) fail(`--range must look like a..b, got: ${args.range}`);
    mergeBase = git(["merge-base", m[1], m[2]]).trim();
    diffTarget = m[2];
    headRef = m[2];
  } else {
    const base = args.base ?? cfg.base ?? detectBase();
    if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { allowFail: true }) === null) {
      fail(`base ref not found: ${base} (fetch it first, e.g. git fetch origin main)`);
    }
    mergeBase = git(["merge-base", base, "HEAD"]).trim();
  }

  const numstatArgs = ["diff", "--numstat", mergeBase];
  if (diffTarget) numstatArgs.push(diffTarget);
  const numstat = git(numstatArgs);

  const files = [];
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const path = normalizePath(rest.join("\t"));
    const binary = added === "-";
    files.push({
      path,
      lines: binary ? 0 : Number(added) + Number(deleted),
      binary,
    });
  }

  // In working-tree mode, untracked files are part of the change too.
  if (!diffTarget) {
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    for (const path of untracked.split("\n")) {
      if (!path.trim()) continue;
      files.push({ path, lines: countFileLines(path), binary: false });
    }
  }
  return { files, mergeBase, headRef };
}

function findTrailerOverride(mergeBase, headRef) {
  const log = git(["log", "--format=%B", `${mergeBase}..${headRef}`], { allowFail: true });
  if (!log) return null;
  const m = log.match(/^Chip-Override:[ \t]*(\S.*)$/m);
  return m ? m[1].trim() : null;
}

function analyze(files, cfg) {
  const ignoreLineGlobs = [...cfg.ignoreLines, ...cfg.risky.lockfiles];
  const areas = new Map();
  const risky = {};
  let totalLines = 0;

  for (const f of files) {
    const countsLines = !matchesAny(f.path, ignoreLineGlobs);
    const lines = countsLines ? f.lines : 0;
    totalLines += lines;

    const area = areaOf(f.path, cfg.workspaceRoots);
    const entry = areas.get(area) ?? { files: 0, lines: 0 };
    entry.files += 1;
    entry.lines += lines;
    areas.set(area, entry);

    for (const [category, globs] of Object.entries(cfg.risky)) {
      if (matchesAny(f.path, globs)) {
        (risky[category] ??= []).push(f.path);
        break; // one category per file, checked in config order
      }
    }
  }

  return {
    totalLines,
    totalFiles: files.length,
    areas,
    risky,
    riskySurfaceCount: Object.keys(risky).length,
  };
}

function buildVerdict(a, budgets) {
  const checks = [
    { name: "lines changed", value: a.totalLines, budget: budgets.maxLines },
    { name: "files touched", value: a.totalFiles, budget: budgets.maxFiles },
    { name: "areas touched", value: a.areas.size, budget: budgets.maxAreas },
    { name: "risky surfaces", value: a.riskySurfaceCount, budget: budgets.maxRiskySurfaces },
  ];
  return { checks, failed: checks.filter((c) => c.value > c.budget) };
}

function splitSuggestions(a, verdict, budgets) {
  const tips = [];
  const failedNames = new Set(verdict.failed.map((c) => c.name));

  if (failedNames.has("areas touched") || failedNames.has("lines changed") || failedNames.has("files touched")) {
    const sorted = [...a.areas.entries()].sort((x, y) => y[1].lines - x[1].lines);
    if (sorted.length > 1) {
      tips.push("Split by area — each of these could be its own PR:");
      for (const [area, { files, lines }] of sorted) {
        tips.push(`    ${area}  (${files} file${files === 1 ? "" : "s"}, ~${lines} lines)`);
      }
    } else if (a.totalLines > budgets.maxLines) {
      tips.push(
        "One area but a big diff. Split by layer or by step: e.g. types/schema first, " +
        "then logic, then call sites; or land a no-behavior-change refactor first, " +
        "then the small behavior change on top."
      );
    }
  }

  if (failedNames.has("risky surfaces")) {
    tips.push("Ship each risky surface as its own scoped PR:");
    for (const [category, files] of Object.entries(a.risky)) {
      tips.push(`    ${RISKY_LABELS[category] ?? category}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5} more)` : ""}`);
    }
    tips.push("    (e.g. dependency/lockfile bump alone, migration alone, then the code that uses them)");
  }

  tips.push(
    "If this genuinely cannot be split, say so explicitly: add a commit trailer " +
    "`Chip-Override: <reason>` (or the chip-override PR label in CI)."
  );
  return tips;
}

function renderReport({ analysisResult: a, verdict, cfg, override }) {
  const out = [];
  const pad = (s, n) => String(s).padEnd(n);
  out.push("chip — smallest responsible step check");
  out.push("");
  for (const c of verdict.checks) {
    const over = c.value > c.budget;
    out.push(`  ${over ? "✗" : "✓"} ${pad(c.name, 16)} ${c.value} / budget ${c.budget}`);
  }
  if (a.areas.size > 0) {
    out.push("");
    out.push("  areas: " + [...a.areas.keys()].join(", "));
  }
  for (const [category, files] of Object.entries(a.risky)) {
    out.push(`  risky (${RISKY_LABELS[category] ?? category}): ${files.join(", ")}`);
  }
  out.push("");

  if (verdict.failed.length === 0) {
    out.push("PASS — this change fits the budget. Ship it, then start the next step.");
  } else if (override) {
    out.push("╔══════════════════════════════════════════════════════════════╗");
    out.push("║  OVERRIDDEN — budgets exceeded but an explicit escape hatch  ║");
    out.push("║  was used. This is visible on purpose.                       ║");
    out.push("╚══════════════════════════════════════════════════════════════╝");
    out.push(`  reason: ${override}`);
  } else {
    out.push(`FAIL — over budget on: ${verdict.failed.map((c) => c.name).join(", ")}.`);
    out.push("");
    out.push("How to split:");
    for (const tip of splitSuggestions(a, verdict, cfg.budgets)) out.push("  " + tip);
  }
  return out.join("\n") + "\n";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Normalize to the repo root so diff paths, config lookup, and untracked-file
  // reads agree no matter which subdirectory the check is invoked from.
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());
  const cfg = loadConfig(args.config);
  const { files, mergeBase, headRef } = collectDiff(args, cfg);

  if (files.length === 0) {
    process.stdout.write("chip: no changes against base — nothing to check.\n");
    process.exit(0);
  }

  const analysisResult = analyze(files, cfg);
  const verdict = buildVerdict(analysisResult, cfg.budgets);
  const override = args.override ?? findTrailerOverride(mergeBase, headRef);
  const pass = verdict.failed.length === 0;
  const exitCode = pass || override ? 0 : 1;

  if (args.json) {
    process.stdout.write(JSON.stringify({
      pass,
      overridden: !pass && Boolean(override),
      overrideReason: !pass ? override ?? null : null,
      lines: analysisResult.totalLines,
      files: analysisResult.totalFiles,
      areas: Object.fromEntries(analysisResult.areas),
      risky: analysisResult.risky,
      budgets: cfg.budgets,
      failed: verdict.failed.map((c) => c.name),
    }, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport({ analysisResult, verdict, cfg, override: pass ? null : override }));
  }
  process.exit(exitCode);
}

main();
