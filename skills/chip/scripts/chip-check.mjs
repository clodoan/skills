#!/usr/bin/env node
/**
 * chip-check — fails loudly until the work is chipped into small steps.
 *
 * Inspects a git diff (working tree vs base, or an explicit range) and
 * compares it against budgets: lines changed, files touched, top-level
 * areas touched, and risky surfaces (lockfiles, migrations, public
 * API/exports, CI config). Exits non-zero with a split suggestion when
 * a budget is blown, unless an explicit override is present.
 *
 * Zero dependencies. Node >= 18.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const DEFAULTS = {
  // ~400 changed lines is where review effectiveness falls off a cliff
  // (SmartBear/Cisco code review study). Chip aims below the ceiling,
  // not at it.
  maxLines: 300,
  // A step you can hold in your head. Mechanical renames can override.
  maxFiles: 12,
  // A change plus its tests usually lives in <= 2 areas. Three or more
  // areas means several concerns are riding along.
  maxAreas: 2,
  // When a risky surface (lockfile, migration, CI config) is touched,
  // everything else in the diff must stay under this many lines so the
  // risky change ships (nearly) alone.
  riskyCompanionLines: 80,
  // Directories whose immediate children are treated as separate areas
  // (monorepo layouts).
  areaRoots: ["packages", "apps", "libs", "services", "crates", "skills"],
  // Glob patterns excluded from every count.
  ignore: [],
};

const RISKY_DEFAULTS = {
  lockfile: [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|deno\.lock|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json)$/,
  ],
  migration: [/(^|\/)migrations?\//i, /(^|\/)alembic\/versions\//],
  publicApi: [
    /(^|\/)index\.(js|jsx|ts|tsx|mjs|cjs)$/,
    /\.d\.ts$/,
    /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/,
  ],
  ci: [
    /^\.github\/workflows\//,
    /^\.gitlab-ci\.yml$/,
    /^Jenkinsfile/,
    /^\.circleci\//,
    /^\.buildkite\//,
    /^\.travis\.yml$/,
  ],
};

const RISKY_LABELS = {
  lockfile: "lockfile / dependency change",
  migration: "migration",
  publicApi: "public API / package manifest",
  ci: "CI config",
};

// Risky categories that must ship (nearly) alone. publicApi is
// report-only: touching an export surface alongside its implementation
// is a normal small step.
const SHIP_ALONE = ["lockfile", "migration", "ci"];

// Key at line start, any case; the reason must be on the same line.
const OVERRIDE_TRAILER = /^chip-override:[ \t]*(\S.*)$/im;

function usage() {
  return `Usage: chip-check [options]

Checks the current git diff against chip budgets and exits 1 with a
split suggestion when the change is too big to be one step.

Options:
  --base <ref>        Compare working tree + commits against merge-base
                      with <ref>. Default: auto-detect (origin/HEAD,
                      origin/main, origin/master, main, master).
  --range <a...b>     Check an explicit committed range instead of the
                      working tree (e.g. origin/main...HEAD in CI).
                      Must contain ".." or "...".
  --config <path>     Path to config JSON. Default: chip.config.json at
                      the repo root, if present.
  --override <reason> Explicit escape hatch. Reports violations but
                      exits 0. The reason is required and printed.
                      A "Chip-Override: <reason>" line in the newest
                      non-merge commit of the range works the same way.
  --cwd <dir>         Run as if started in <dir>.
  -h, --help          Show this help.

Exit codes: 0 within budget (or explicitly overridden), 1 over budget,
2 usage or environment error.`;
}

function parseArgs(argv) {
  const opts = { base: null, range: null, config: null, override: null, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--base": opts.base = next(); break;
      case "--range": opts.range = next(); break;
      case "--config": opts.config = next(); break;
      case "--override": {
        const reason = next().trim();
        if (!reason) throw new UsageError("--override requires a non-empty reason");
        opts.override = reason;
        break;
      }
      case "--cwd": opts.cwd = next(); break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(EXIT_PASS);
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return opts;
}

class UsageError extends Error {}
class GitError extends Error {}

// core.quotePath=false plus -z keeps non-ASCII and odd paths verbatim.
function git(cwd, args) {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = String(err.stderr ?? "").trim().split("\n")[0] || err.message;
    throw new GitError(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

// Diff flags that ignore user config (diff.renames, external diff, textconv).
const DIFF_FLAGS = ["--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];

function shallowHint(cwd) {
  return tryGit(cwd, ["rev-parse", "--is-shallow-repository"]) === "true"
    ? " This is a shallow clone; fetch full history (actions/checkout: fetch-depth: 0)."
    : "";
}

function globToRegExp(glob) {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) { out += "(?:.*/)?"; i += 3; }
    else if (glob.startsWith("**", i)) { out += ".*"; i += 2; }
    else if (glob[i] === "*") { out += "[^/]*"; i += 1; }
    else if (glob[i] === "?") { out += "[^/]"; i += 1; }
    else { out += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&"); i += 1; }
  }
  return new RegExp(`^${out}$`);
}

function loadConfig(opts, repoRoot) {
  let file = opts.config;
  if (!file) {
    const candidate = path.join(repoRoot, "chip.config.json");
    if (existsSync(candidate)) file = candidate;
  } else if (!existsSync(file)) {
    throw new UsageError(`config file not found: ${file}`);
  }
  const user = file ? JSON.parse(readFileSync(file, "utf8")) : {};

  const config = { ...DEFAULTS, ...user };
  config.areaRoots = user.areaRoots ?? DEFAULTS.areaRoots;
  config.ignoreRes = (user.ignore ?? DEFAULTS.ignore).map(globToRegExp);
  config.risky = {};
  for (const cat of Object.keys(RISKY_DEFAULTS)) {
    const extra = (user.risky?.[cat] ?? []).map(globToRegExp);
    config.risky[cat] = [...RISKY_DEFAULTS[cat], ...extra];
  }
  return config;
}

function detectBase(cwd) {
  const originHead = tryGit(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  const candidates = [originHead, "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const ref of candidates) {
    if (tryGit(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== null) return ref;
  }
  return null;
}

// `numstat -z` records: "added\tdeleted\tpath\0", or for a rename
// "added\tdeleted\t\0old\0new\0".
function parseNumstat(text) {
  const files = [];
  const tokens = text.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]) continue;
    const [added, deleted, ...rest] = tokens[i].split("\t");
    let filePath = rest.join("\t");
    let oldPath = null;
    if (filePath === "") {
      oldPath = tokens[++i];
      filePath = tokens[++i];
    }
    const binary = added === "-" || deleted === "-";
    files.push({ path: filePath, oldPath, lines: binary ? 0 : Number(added) + Number(deleted), binary });
  }
  return files;
}

function looksBinary(buf) {
  const slice = buf.subarray(0, 8000);
  return slice.includes(0);
}

// Run from the repo root: ls-files only lists files under its cwd.
function collectUntracked(repoRoot) {
  const out = git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  return out.split("\0").filter(Boolean).map((p) => {
    const full = path.join(repoRoot, p);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    // git diffs a symlink as one line: its target path.
    if (stat?.isSymbolicLink()) return { path: p, oldPath: null, lines: 1, binary: false };
    if (!stat?.isFile()) return { path: p, oldPath: null, lines: 0, binary: true };
    const buf = readFileSync(full);
    if (looksBinary(buf)) return { path: p, oldPath: null, lines: 0, binary: true };
    const text = buf.toString("utf8");
    const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { path: p, oldPath: null, lines, binary: false };
  });
}

function areaOf(filePath, areaRoots) {
  const parts = filePath.split("/");
  if (parts.length === 1) return "(root)";
  if (areaRoots.includes(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function fileLabel(f) {
  return f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
}

function categorize(filePath, risky) {
  const cats = [];
  for (const [cat, patterns] of Object.entries(risky)) {
    if (patterns.some((re) => re.test(filePath))) cats.push(cat);
  }
  return cats;
}

function analyze(files, config) {
  const kept = files.filter((f) => !config.ignoreRes.some((re) => re.test(f.path)));
  for (const f of kept) {
    // A rename touches both sides: categorize and area-count the old path too.
    f.categories = [...new Set([f.path, f.oldPath].filter(Boolean).flatMap((p) => categorize(p, config.risky)))];
    f.area = areaOf(f.path, config.areaRoots);
    f.oldArea = f.oldPath ? areaOf(f.oldPath, config.areaRoots) : null;
    // Lockfiles are generated; their bulk should not eat the line budget.
    f.countedLines = f.categories.includes("lockfile") ? 0 : f.lines;
  }

  const totalLines = kept.reduce((sum, f) => sum + f.countedLines, 0);
  const areas = new Map();
  for (const f of kept) {
    if (!areas.has(f.area)) areas.set(f.area, { files: 0, lines: 0 });
    const a = areas.get(f.area);
    a.files += 1;
    a.lines += f.countedLines;
    if (f.oldArea && f.oldArea !== f.area) {
      if (!areas.has(f.oldArea)) areas.set(f.oldArea, { files: 0, lines: 0 });
      areas.get(f.oldArea).files += 1;
    }
  }

  const riskyTouched = {};
  for (const cat of Object.keys(RISKY_DEFAULTS)) {
    const touched = kept.filter((f) => f.categories.includes(cat));
    if (touched.length > 0) riskyTouched[cat] = touched;
  }

  return { files: kept, totalLines, areas, riskyTouched };
}

function evaluate(analysis, config) {
  const violations = [];
  const { files, totalLines, areas, riskyTouched } = analysis;

  if (totalLines > config.maxLines) {
    violations.push({
      kind: "lines",
      message: `${totalLines} lines changed — budget is ${config.maxLines}. Too much to review as one step.`,
    });
  }
  if (files.length > config.maxFiles) {
    violations.push({
      kind: "files",
      message: `${files.length} files touched — budget is ${config.maxFiles}.`,
    });
  }
  if (areas.size > config.maxAreas) {
    violations.push({
      kind: "areas",
      message: `${areas.size} areas touched (${[...areas.keys()].join(", ")}) — budget is ${config.maxAreas}. Several concerns are riding in one change.`,
    });
  }
  for (const cat of SHIP_ALONE) {
    if (!riskyTouched[cat]) continue;
    const companionLines = files
      .filter((f) => !f.categories.includes(cat))
      .reduce((sum, f) => sum + f.countedLines, 0);
    if (companionLines > config.riskyCompanionLines) {
      violations.push({
        kind: `risky:${cat}`,
        message: `${RISKY_LABELS[cat]} touched (${riskyTouched[cat].map(fileLabel).join(", ")}) alongside ${companionLines} other lines — budget is ${config.riskyCompanionLines}. Risky surfaces ship (nearly) alone so they can be reverted alone.`,
      });
    }
  }
  return violations;
}

// Only the newest non-merge commit can waive the check, so an override for
// one commit does not silently cover everything pushed after it. In CI the
// checkout is a merge ref, and the newest non-merge commit is the PR head.
function findTrailerOverrides(cwd, logRange) {
  const result = { honored: null, ignored: [] };
  const out = tryGit(cwd, ["log", "--topo-order", "--format=%h%x1f%p%x1f%s%x1f%B%x1e", logRange]);
  if (!out) return result;
  let seenNonMerge = false;
  for (const record of out.split("\x1e")) {
    const [sha, parents, subject, body] = record.replace(/^\n/, "").split("\x1f");
    if (!sha || body === undefined) continue;
    const isMerge = parents.trim().includes(" ");
    const isNewest = !isMerge && !seenNonMerge;
    if (!isMerge) seenNonMerge = true;
    const m = body.match(OVERRIDE_TRAILER);
    if (!m) continue;
    const entry = { sha, subject, reason: m[1].trim() };
    if (isNewest) result.honored = entry;
    else result.ignored.push(entry);
  }
  return result;
}

function suggestSplit(analysis, violations, config) {
  const lines = [];
  let step = 1;
  const claimed = new Set();

  for (const cat of SHIP_ALONE) {
    if (!violations.some((v) => v.kind === `risky:${cat}`)) continue;
    const touched = analysis.riskyTouched[cat];
    lines.push(`  ${step}. Ship the ${RISKY_LABELS[cat]} alone: ${touched.map(fileLabel).join(", ")}`);
    touched.forEach((f) => claimed.add(f.path));
    step += 1;
  }

  const byArea = [...analysis.areas.keys()]
    .map((area) => {
      const files = analysis.files.filter((f) => f.area === area && !claimed.has(f.path));
      return { area, files, lines: files.reduce((s, f) => s + f.countedLines, 0) };
    })
    .filter((a) => a.files.length > 0)
    .sort((a, b) => b.lines - a.lines);

  if (byArea.length > 1) {
    for (const a of byArea) {
      const note = a.lines > config.maxLines ? " (still over budget — split by feature within the area)" : "";
      lines.push(`  ${step}. ${a.area}: ${a.files.length} file(s), ~${a.lines} lines${note}`);
      step += 1;
    }
  } else if (byArea.length === 1) {
    lines.push(
      `  ${step}. ${byArea[0].area} alone is over budget. Split by concern: refactor-only step first (no behavior change), then the behavior change; or one feature slice at a time.`,
    );
  }

  lines.push("");
  lines.push("Each step should pass chip-check on its own and be revertable on its own.");
  lines.push('If this genuinely cannot be split (rare), override explicitly: add a "Chip-Override: <reason>" line to the newest commit message or pass --override "<reason>". Overrides are loud on purpose.');
  return lines.join("\n");
}

function formatReport(analysis, config, sourceLabel) {
  const out = [];
  const over = (n, budget) => (n > budget ? `${n} ! (budget ${budget})` : `${n} (budget ${budget})`);
  out.push(`chip-check · ${sourceLabel}`);
  out.push(
    `  lines changed: ${over(analysis.totalLines, config.maxLines)} · files: ${over(analysis.files.length, config.maxFiles)} · areas: ${over(analysis.areas.size, config.maxAreas)}`,
  );

  if (analysis.areas.size > 0) {
    out.push("  areas:");
    for (const [area, stats] of [...analysis.areas.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
      out.push(`    ${area.padEnd(24)} ${String(stats.files).padStart(3)} file(s) ${String(stats.lines).padStart(6)} lines`);
    }
  }

  const riskyCats = Object.keys(analysis.riskyTouched);
  if (riskyCats.length > 0) {
    out.push("  risky surfaces:");
    for (const cat of riskyCats) {
      out.push(`    ${RISKY_LABELS[cat]}: ${analysis.riskyTouched[cat].map(fileLabel).join(", ")}`);
    }
    if (analysis.riskyTouched.publicApi) {
      out.push("    note: public API / manifest files change your contract with callers — name this in the step's blast radius.");
    }
  }
  return out.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = tryGit(path.resolve(opts.cwd), ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) throw new UsageError(`not a git repository: ${opts.cwd}`);
  // Every git call runs from the root so paths are root-relative.
  const cwd = repoRoot;

  const config = loadConfig(opts, repoRoot);

  let numstatArgs;
  let logRange;
  let sourceLabel;
  let includeUntracked = false;

  if (opts.range) {
    if (!opts.range.includes("..")) {
      throw new UsageError(`--range needs <a>..<b> or <a>...<b>, got "${opts.range}"; use --base for a single ref`);
    }
    numstatArgs = ["diff", ...DIFF_FLAGS, opts.range];
    logRange = opts.range.replace("...", "..");
    sourceLabel = `range ${opts.range}`;
  } else {
    const base = opts.base ?? detectBase(cwd);
    if (!base) {
      throw new UsageError("could not detect a base branch; pass --base <ref> or --range <a...b>");
    }
    if (tryGit(cwd, ["rev-parse", "--verify", "-q", `${base}^{commit}`]) === null) {
      throw new UsageError(`unknown base ref: ${base}`);
    }
    const mergeBase = tryGit(cwd, ["merge-base", base, "HEAD"]);
    if (!mergeBase) throw new GitError(`no merge base between ${base} and HEAD.${shallowHint(cwd)}`);
    numstatArgs = ["diff", ...DIFF_FLAGS, mergeBase];
    logRange = `${mergeBase}..HEAD`;
    sourceLabel = `working tree vs ${base}`;
    includeUntracked = true;
  }

  let numstat;
  try {
    numstat = git(cwd, numstatArgs);
  } catch (err) {
    if (err instanceof GitError) err.message += shallowHint(cwd);
    throw err;
  }
  const files = parseNumstat(numstat);
  if (includeUntracked) files.push(...collectUntracked(repoRoot));

  const analysis = analyze(files, config);
  const violations = evaluate(analysis, config);

  console.log(formatReport(analysis, config, sourceLabel));
  console.log("");

  if (violations.length === 0) {
    console.log("PASS: within budget. This looks like one responsible step.");
    process.exit(EXIT_PASS);
  }

  console.log("FAIL: this change is not chipped.");
  for (const v of violations) console.log(`  - ${v.message}`);
  console.log("");
  console.log("Suggested split:");
  console.log(suggestSplit(analysis, violations, config));

  const trailers = findTrailerOverrides(cwd, logRange);
  if (trailers.ignored.length > 0) console.log("");
  for (const t of trailers.ignored) {
    console.log(`Ignored Chip-Override on ${t.sha} "${t.subject}" (not on the newest commit).`);
  }
  const override = opts.override
    ? { reason: opts.override, source: "--override flag" }
    : trailers.honored && { reason: trailers.honored.reason, source: `commit ${trailers.honored.sha} "${trailers.honored.subject}"` };
  if (override) {
    console.log("");
    console.log("=".repeat(64));
    console.log(`OVERRIDE ACTIVE — budgets exceeded but explicitly waived.`);
    console.log(`Reason: ${override.reason}`);
    console.log(`Source: ${override.source}`);
    console.log("This is visible on purpose. Reviewers: treat with extra care.");
    console.log("=".repeat(64));
    process.exit(EXIT_PASS);
  }

  process.exit(EXIT_FAIL);
}

try {
  main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`chip-check: ${err.message}`);
    console.error("");
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  if (err instanceof GitError) {
    console.error(`chip-check: ${err.message}`);
    process.exit(EXIT_USAGE);
  }
  console.error(`chip-check: unexpected error: ${err?.stack ?? err}`);
  process.exit(EXIT_USAGE);
}
