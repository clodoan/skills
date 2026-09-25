#!/usr/bin/env node
/**
 * ramble — a Mermaid flowchart of the screens and transitions that
 * actually exist in a codebase.
 *
 * Walks router conventions (Next.js app/ and pages/, React Router
 * config files) plus Link/href/navigate/redirect call sites, and emits
 * a flowchart of real routes: grouped by segment, dynamic params
 * labeled, redirect/middleware edges dashed. Unresolved or dynamic
 * navigations are reported, never silently dropped.
 *
 * Zero dependencies. Node >= 18.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, realpathSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const PAGE_RE = /^page\.(js|jsx|ts|tsx|mdx)$/;
const PAGES_EXT_RE = /\.(js|jsx|ts|tsx|mdx)$/;
const SOURCE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|mdx)$/;
const PRUNE_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", "dist", "build", "out",
  "coverage", ".vercel", "public", "static", ".storybook", "__tests__",
]);

class UsageError extends Error {}

function usage() {
  return `Usage: ramble <dir> [options]

Walks the router(s) in <dir> and writes a Mermaid flowchart of real
screens and transitions, plus a report of every navigation it did not
draw.

Options:
  --out <dir>         Output directory, relative to the current
                      directory (default: ramble-output)
  --include-shared    Draw links from non-route files (layouts, navbars)
                      from one "shared" node
  --max-label <n>     Truncate next.config edge labels (default 24)
  --thumbs            Also screenshot static routes via the plinth skill
                      (RAMBLE_PLINTH overrides its path)
  --base-url <url>    Running app URL for --thumbs (required with it)
  --thumb-cap <n>     Max screenshots (default 12)
  -h, --help          Show this help

Outputs: flow.md (diagram + report), flow.mmd (raw Mermaid), and with
--thumbs flow-visual.md + thumbs/r<i>-<slug>.png.

Exit codes: 0 ok, 1 unexpected error, 2 usage error.`;
}

function positiveInt(flag, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} needs a positive integer, got "${value}"`);
  return n;
}

function parseArgs(argv) {
  const opts = {
    root: null, out: "ramble-output", includeShared: false, maxLabel: 24,
    thumbs: false, baseUrl: null, thumbCap: 12,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--out": opts.out = next(); break;
      case "--include-shared": opts.includeShared = true; break;
      case "--max-label": opts.maxLabel = positiveInt(arg, next()); break;
      case "--thumbs": opts.thumbs = true; break;
      case "--base-url": opts.baseUrl = next(); break;
      case "--thumb-cap": opts.thumbCap = positiveInt(arg, next()); break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(EXIT_OK);
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
        if (opts.root) throw new UsageError("only one directory is supported");
        opts.root = arg;
    }
  }
  if (!opts.root) throw new UsageError("missing target directory");
  if (!existsSync(opts.root)) throw new UsageError(`directory not found: ${opts.root}`);
  if (opts.thumbs && !opts.baseUrl) throw new UsageError("--thumbs requires --base-url <running app>");
  return opts;
}

// ---------------------------------------------------------- thumbnails

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function basePathOf(project) {
  for (const name of NEXT_CONFIG_NAMES) {
    const m = project && readText(path.join(project, name)).match(/\bbasePath\s*:\s*(["'`])([^"'`]*)\1/);
    if (m) return m[2].replace(/\/$/, "");
  }
  return "";
}

/** Static routes through plinth; files are named by diagram node id (r<i>). */
function renderThumbs(routes, opts) {
  const plinth = process.env.RAMBLE_PLINTH
    ?? fileURLToPath(new URL("../../plinth/scripts/plinth.mjs", import.meta.url));
  if (!existsSync(plinth)) {
    throw new UsageError(
      "--thumbs needs the plinth skill next to ramble (skills/plinth); set RAMBLE_PLINTH to its scripts/plinth.mjs",
    );
  }
  const targets = routes.map((r, i) => ({ r, id: `r${i}` })).filter(({ r }) => !r.dynamic).slice(0, opts.thumbCap);
  const thumbsDir = path.join(opts.out, "thumbs");
  mkdirSync(thumbsDir, { recursive: true });
  const rows = [];
  for (const { r, id } of targets) {
    const slug = r.urlPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "home";
    const file = `${id}-${slug}.png`;
    const png = path.join(thumbsDir, file);
    const url = `${opts.baseUrl.replace(/\/$/, "")}${basePathOf(r.project)}${r.urlPath}`;
    const res = spawnSync(process.execPath, [
      plinth, url, "--device", "browser", "--padding", "16", "--no-shadow", "--bg", "none", "--out", png,
    ], { encoding: "utf8", timeout: 120000 });
    const ok = res.status === 0 && existsSync(png);
    const error = res.error?.message
      ?? `${res.stdout ?? ""}${res.stderr ?? ""}`.split("\n").find((l) => l.includes("plinth:"))
      ?? `capture failed (exit ${res.status})`;
    rows.push(ok ? { route: r.urlPath, img: `thumbs/${file}` } : { route: r.urlPath, error });
    console.log(`  thumb ${r.urlPath} — ${ok ? "ok" : "FAILED"}`);
  }
  const cells = rows.map((row) =>
    row.img
      ? `<td align="center"><img src="${escHtml(row.img)}" width="280"/><br/><code>${escHtml(row.route)}</code></td>`
      : `<td align="center">⚠️ <code>${escHtml(row.route)}</code><br/>${escHtml(row.error)}</td>`);
  const tableRows = [];
  for (let i = 0; i < cells.length; i += 3) tableRows.push(`<tr>${cells.slice(i, i + 3).join("")}</tr>`);
  writeFileSync(
    path.join(opts.out, "flow-visual.md"),
    `# Visual screen map\n\nStatic routes captured from ${escHtml(opts.baseUrl)} (cap ${opts.thumbCap}; dynamic routes need real params — see flow.md).\n\n<table>\n${tableRows.join("\n")}\n</table>\n`,
  );
  return rows;
}

// ------------------------------------------------------------ fs walking

// Sorted by code point so output is identical on APFS (sorted) and ext4
// (hash order). Unreadable directories are skipped, not fatal.
function readdirSorted(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** "dir" | "file" | null, following symlinks; broken links are null. */
function entryKind(full, entry) {
  if (!entry.isSymbolicLink()) return entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
  try {
    const st = statSync(full);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/** True the first time a directory's real path is seen (symlink-loop guard). */
function firstVisit(visited, dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  if (visited.has(real)) return false;
  visited.add(real);
  return true;
}

// Scans never follow directory symlinks; router walks do, with a guard.
function* walkDirs(dir) {
  yield dir;
  for (const entry of readdirSorted(dir)) {
    if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) continue;
    yield* walkDirs(path.join(dir, entry.name));
  }
}

function* walkFiles(dir) {
  for (const entry of readdirSorted(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!PRUNE_DIRS.has(entry.name)) yield* walkFiles(full);
    } else if (SOURCE_EXT_RE.test(entry.name) && entryKind(full, entry) === "file") {
      yield full;
    }
  }
}

const textCache = new Map();
function readText(file) {
  if (!textCache.has(file)) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // unreadable: treated as empty
    }
    textCache.set(file, text);
  }
  return textCache.get(file);
}

// ---------------------------------------------------------------- roots

function hasPageFileBelow(dir, depth = 0) {
  if (depth > 8) return false;
  for (const entry of readdirSorted(dir)) {
    if (entry.isFile() && PAGE_RE.test(entry.name)) return true;
    if (entry.isDirectory() && !PRUNE_DIRS.has(entry.name)) {
      if (hasPageFileBelow(path.join(dir, entry.name), depth + 1)) return true;
    }
  }
  return false;
}

const NEXT_CONFIG_NAMES = ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts", "next.config.mts"];

/** A Next router folder's project: its parent (or src/'s parent) holding package.json. */
function nextProjectFor(routerDir) {
  const parent = path.dirname(routerDir);
  const project = path.basename(parent) === "src" ? path.dirname(parent) : parent;
  return existsSync(path.join(project, "package.json")) ? project : null;
}

function dependsOnNext(project) {
  if (NEXT_CONFIG_NAMES.some((name) => existsSync(path.join(project, name)))) return true;
  try {
    const pkg = JSON.parse(readText(path.join(project, "package.json")));
    return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  } catch {
    return false;
  }
}

const RR_DEFINES_ROUTES = /createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|useRoutes\s*\(|<Routes[\s>]|<Route\s[^>]*\bpath=/;

/** Closest ancestor of `file` (within `root`) holding package.json; else root. */
function nearestProject(file, root) {
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (dir === root) break;
  }
  return root;
}

function detectRoots(root, files) {
  const roots = [];
  for (const dir of walkDirs(root)) {
    const base = path.basename(dir);
    if (base !== "app" && base !== "pages") continue;
    // app/ or pages/ inside a detected router is a route segment.
    if (roots.some((r) => dir.startsWith(r.dir + path.sep))) continue;
    // Real routers sit next to package.json (or in src/ next to one);
    // pages/ also needs Next itself — Vite apps keep components in src/pages.
    const project = nextProjectFor(dir);
    if (!project) continue;
    if (base === "app" && hasPageFileBelow(dir)) roots.push({ kind: "next-app", dir, project });
    if (base === "pages" && dependsOnNext(project)) roots.push({ kind: "next-pages", dir, project });
  }
  const rrFiles = files.filter((file) => RR_DEFINES_ROUTES.test(readText(file)));
  if (rrFiles.length) roots.push({ kind: "react-router", files: rrFiles });
  return roots;
}

// ------------------------------------------------------- next app router

function segmentToUrl(seg) {
  if (seg.startsWith("%5F")) return `_${seg.slice(3)}`; // Next's escape for a literal leading _
  if (/^\[\[\.\.\.(.+)\]\]$/.test(seg)) return `:${seg.slice(5, -2)}*?`;
  if (/^\[\.\.\.(.+)\]$/.test(seg)) return `:${seg.slice(4, -1)}*`;
  if (/^\[(.+)\]$/.test(seg)) return `:${seg.slice(1, -1)}`;
  return seg;
}

// Dotted names ending in a letter TLD (app.dub.co), not versions (v1.0)
// or file-like route handlers (feed.xml).
const HOST_DIR_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const NOT_A_TLD_RE = /\.(xml|txt|json|js|ts|html|ico|png|svg|jpg|webmanifest|rss|atom|md)$/i;

function walkAppRouter(appDir, appLabel) {
  const routes = [];
  const slots = [];
  const intercepts = [];
  let apiRoutes = 0;
  const visited = new Set();

  const recurse = (dir, urlSegs, groups, inSlot, host) => {
    if (!firstVisit(visited, dir)) return;
    for (const entry of readdirSorted(dir)) {
      const full = path.join(dir, entry.name);
      const kind = entryKind(full, entry);
      if (kind === "file") {
        if (PAGE_RE.test(entry.name)) {
          const urlPath = "/" + urlSegs.join("/");
          if (inSlot) {
            slots.push({ slot: inSlot, urlPath, file: full });
          } else {
            routes.push({
              urlPath: urlPath === "/" ? "/" : urlPath.replace(/\/$/, ""),
              file: full,
              groups: [...groups],
              app: host ? `${appLabel} · ${host}` : appLabel,
              dynamic: urlSegs.some((s) => s.startsWith(":")),
            });
          }
        } else if (/^route\.(js|jsx|ts|tsx)$/.test(entry.name)) {
          apiRoutes += 1;
        }
        continue;
      }
      // Inside a router every folder is a segment ("build", "public", …);
      // only node_modules is skipped.
      if (kind !== "dir" || entry.name === "node_modules") continue;
      const name = entry.name;
      if (name.startsWith("_")) continue; // private folder
      if (name.startsWith("@")) {
        recurse(full, urlSegs, groups, name, host);
        continue;
      }
      const interceptMatch = name.match(/^(\(\.{1,3}\)|\(\.\.\)\(\.\.\))(.+)$/);
      if (interceptMatch) {
        intercepts.push({
          from: "/" + urlSegs.join("/"),
          target: interceptMatch[2],
          marker: interceptMatch[1],
          dir: full,
        });
        continue; // intercepted content is a modal-in-place, not a screen URL
      }
      if (/^\(.+\)$/.test(name)) {
        recurse(full, urlSegs, [...groups, name.slice(1, -1)], inSlot, host);
        continue;
      }
      // Host-based top-level folders (dub-style multi-tenant: app/app.dub.co/…)
      // are routing domains, not URL segments.
      if (urlSegs.length === 0 && !host && HOST_DIR_RE.test(name) && !NOT_A_TLD_RE.test(name)) {
        recurse(full, urlSegs, groups, inSlot, name);
        continue;
      }
      recurse(full, [...urlSegs, segmentToUrl(name)], groups, inSlot, host);
    }
  };
  recurse(appDir, [], [], null, null);
  return { routes, slots, intercepts, apiRoutes };
}

// ----------------------------------------------------- next pages router

const PAGES_SPECIAL = new Set(["_app", "_document", "_error", "_middleware", "404", "500"]);

function walkPagesRouter(pagesDir, appLabel) {
  const routes = [];
  const visited = new Set();
  const recurse = (dir, urlSegs) => {
    if (!firstVisit(visited, dir)) return;
    for (const entry of readdirSorted(dir)) {
      const full = path.join(dir, entry.name);
      const kind = entryKind(full, entry);
      if (kind === "dir") {
        // Only the top-level pages/api is API; pages/docs/api/ is a page.
        const isApi = urlSegs.length === 0 && entry.name === "api";
        if (entry.name !== "node_modules" && !isApi) {
          recurse(full, [...urlSegs, segmentToUrl(entry.name)]);
        }
        continue;
      }
      if (kind !== "file" || !PAGES_EXT_RE.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      const base = entry.name.replace(PAGES_EXT_RE, "");
      if (PAGES_SPECIAL.has(base)) continue;
      const segs = base === "index" ? urlSegs : [...urlSegs, segmentToUrl(base)];
      const urlPath = "/" + segs.join("/");
      routes.push({
        urlPath: urlPath === "/" ? "/" : urlPath.replace(/\/$/, ""),
        file: full,
        groups: [],
        app: appLabel,
        dynamic: segs.some((s) => s.startsWith(":")),
      });
    }
  };
  recurse(pagesDir, []);
  return routes;
}

// ---------------------------------------------------------- react router

/**
 * Extract a balanced { … } object literal starting at text[start] === "{",
 * skipping string/template contents.
 */
function extractObjectLiteral(text, start) {
  let depth = 0;
  let i = start;
  let quote = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Within an object literal, find `key:`'s value at depth 1. */
function objectValue(objText, key) {
  let depth = 0;
  let quote = null;
  const keyRe = new RegExp(`^${key}\\s*:`);
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") { depth++; continue; }
    if (ch === "}") { depth--; continue; }
    if (depth !== 1) continue;
    const rest = objText.slice(i);
    const m = rest.match(keyRe);
    if (m && /[,{\s]/.test(objText[i - 1] ?? "{")) {
      const after = objText.slice(i + m[0].length).trimStart();
      if (after.startsWith("{")) return extractObjectLiteral(after, 0);
      const lit = after.match(/^(["'`])((?:(?!\1).)*)\1/);
      return lit ? lit[2] : null;
    }
  }
  return null;
}

/**
 * Resolve an identifier chain like `paths.app.discussions.path` against a
 * config object literal defined anywhere in the scanned files (the
 * bulletproof-react central-paths pattern).
 */
function makeChainResolver(allFiles) {
  const configCache = new Map();
  const findConfig = (ident) => {
    if (configCache.has(ident)) return configCache.get(ident);
    let found = null;
    for (const file of allFiles) {
      const text = readText(file);
      const m = text.match(new RegExp(`(?:export\\s+)?const\\s+${ident.replace(/\$/g, "\\$")}\\s*(?:=|:[^=]*=)\\s*`));
      if (!m) continue;
      const braceIdx = text.indexOf("{", m.index + m[0].length - 1);
      if (braceIdx === -1) continue;
      const obj = extractObjectLiteral(text, braceIdx);
      if (obj) { found = obj; break; }
    }
    configCache.set(ident, found);
    return found;
  };
  return (chain) => {
    const [root, ...keys] = chain.split(".");
    let node = findConfig(root);
    for (const key of keys) {
      if (typeof node !== "string" || !node.startsWith("{")) return null;
      node = objectValue(node, key);
      if (node === null) return null;
    }
    return typeof node === "string" && !node.startsWith("{") ? node : null;
  };
}

/** Scan a `<Route …>` tag from its `<` to its closing `>`, skipping {…} and strings. */
function scanJsxTag(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && ch === ">") {
      return { end: i + 1, selfClosing: text[i - 1] === "/", attrs: text.slice(start, i + 1) };
    }
  }
  return { end: text.length, selfClosing: true, attrs: text.slice(start) };
}

function resolveModule(dir, spec) {
  const base = path.resolve(dir, spec);
  const exts = [".tsx", ".ts", ".jsx", ".js", ".mjs"];
  const candidates = [base, ...exts.map((e) => base + e), ...exts.map((e) => path.join(base, `index${e}`))];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Component name → file, for default/named/lazy imports from relative paths. */
function relativeImports(file) {
  const text = readText(file);
  const map = new Map();
  const add = (name, spec) => {
    if (!spec.startsWith(".")) return;
    const target = resolveModule(path.dirname(file), spec);
    if (target && !map.has(name)) map.set(name, target);
  };
  for (const m of text.matchAll(/import\s+([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    if (m[1]) add(m[1], m[3]);
    for (const part of (m[2] ?? "").split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig) add((alias ?? orig).trim(), m[3]);
    }
  }
  for (const m of text.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']/g)) {
    add(m[1], m[2]);
  }
  return map;
}

const joinUrl = (parent, child) => {
  const url = (child.startsWith("/") ? child : `${parent}/${child}`).replace(/\/+/g, "/").replace(/\/\*$/, "/:rest*");
  return url !== "/" ? url.replace(/\/$/, "") : url;
};

/**
 * Best-effort, regex-based (no AST). Object configs: `path:` values
 * (literals or identifier chains through a central paths config) nest by
 * brace depth. JSX: `<Route path>` nests by open/close tags. A route's
 * `element` (or `Component`) that is a plain identifier imported from a
 * relative file becomes the route's source file for edges; an index
 * route's element maps to its parent route.
 */
function parseReactRouter(files, appOf, resolveChain) {
  const routes = [];
  const byUrl = new Map();
  const unresolvedPaths = [];
  const token = /\{|\}|<Route\b|<\/Route\s*>|\bpath\s*:\s*(?:(["'`])((?:(?!\1).)*)\1|([\w$][\w$.]+))|\bindex\s*:\s*true|\b(?:element\s*:\s*<|Component\s*:\s*)([A-Z][\w$]*)/g;
  for (const file of files) {
    const text = readText(file);
    const imports = relativeImports(file);
    const lineAt = (i) => text.slice(0, i).split("\n").length;
    const owner = appOf(file);
    const addRoute = (urlPath) => {
      const key = `${owner.app}:${urlPath}`;
      if (!byUrl.has(key)) {
        const route = { urlPath, file, sourceFile: null, groups: [], ...owner, dynamic: urlPath.includes(":") };
        byUrl.set(key, route);
        routes.push(route);
      }
      return byUrl.get(key);
    };
    const mapElement = (route, name) => {
      const target = name && imports.get(name);
      if (route && target && !route.sourceFile) route.sourceFile = target;
    };
    const rawPath = (literal, chain, index) => {
      if (literal !== undefined) return literal;
      const resolved = resolveChain(chain);
      if (resolved === null) unresolvedPaths.push({ value: chain, file, line: lineAt(index) });
      return resolved;
    };

    let depth = 0;
    const pathStack = []; // object configs: { depth, url, route }
    const frames = []; // object literals: { depth, route, element, index }
    const jsx = []; // open <Route> tags: { url, route }
    token.lastIndex = 0;
    let m;
    while ((m = token.exec(text))) {
      const t = m[0];
      if (t === "{") {
        depth++;
        frames.push({ depth, route: null, element: null, index: false });
      } else if (t === "}") {
        const frame = frames.pop();
        depth--;
        while (pathStack.length && pathStack.at(-1).depth > depth) pathStack.pop();
        if (frame?.route) mapElement(frame.route, frame.element);
        else if (frame?.index) mapElement(pathStack.at(-1)?.route, frame.element);
      } else if (t.startsWith("<Route")) {
        const tag = scanJsxTag(text, m.index);
        token.lastIndex = tag.end;
        const a = tag.attrs;
        const pm = a.match(/\spath=(?:(["'])(.*?)\1|\{\s*(["'`])(.*?)\3\s*\}|\{\s*([\w$][\w$.]+)\s*\})/);
        const parent = jsx.at(-1) ?? { url: "", route: null };
        const raw = pm ? rawPath(pm[2] ?? pm[4], pm[5], m.index) : null;
        const element = a.match(/\selement=\{\s*<([A-Z][\w$]*)|\sComponent=\{\s*([A-Z][\w$]*)\s*\}/);
        let node = parent;
        if (raw !== null && raw !== undefined) {
          const route = addRoute(joinUrl(parent.url, raw));
          node = { url: route.urlPath, route };
          mapElement(route, element?.[1] ?? element?.[2]);
        } else if (/\sindex(?=[\s/>=])(?!=\{false\})/.test(a)) {
          mapElement(parent.route, element?.[1] ?? element?.[2]);
        }
        if (!tag.selfClosing) jsx.push(node);
      } else if (t.startsWith("</Route")) {
        jsx.pop();
      } else if (t.startsWith("index")) {
        if (frames.length) frames.at(-1).index = true;
      } else if (m[4]) {
        if (frames.length) frames.at(-1).element = m[4];
      } else {
        const raw = rawPath(m[2], m[3], m.index);
        if (raw === null) continue;
        while (pathStack.length && pathStack.at(-1).depth >= depth) pathStack.pop();
        const route = addRoute(joinUrl(pathStack.at(-1)?.url ?? "", raw));
        pathStack.push({ depth, url: route.urlPath, route });
        if (frames.length) frames.at(-1).route = route;
      }
    }
  }
  return { routes, unresolvedPaths };
}

// ----------------------------------------------------------------- edges

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Blank out comments (newlines kept, so line numbers hold). A quote never spans a line. */
function stripComments(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === quote || (ch === "\n" && quote !== "`")) quote = null;
      continue;
    }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const close = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const stop = close === -1 ? text.length : text[i + 1] === "/" ? close : close + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

/** Text from `start` up to a top-level char in `closers`, skipping nesting and strings. */
function scanArg(text, start, closers) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (depth === 0 && closers.includes(ch)) return text.slice(start, i);
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth < 0) return text.slice(start, i);
  }
  return null;
}

/** JSX attribute value after `href=`: a quoted literal or the {expression}. */
function attrValue(text, at) {
  const q = text[at];
  if (q === '"' || q === "'") {
    const end = text.indexOf(q, at + 1);
    return end === -1 ? null : text.slice(at, end + 1);
  }
  return q === "{" ? scanArg(text, at + 1, "}") : null;
}

const NAV_SITES = [
  { re: /(?<![\w$.:-])(?:href|to)=/g, kind: "link", attr: true },
  { re: /\brouter\.(?:push|replace)\(/g, kind: "link" },
  { re: /(?<![\w$.])navigate\(/g, kind: "link" },
  { re: /(?<![\w$.])(?:permanentRedirect|redirect)\(/g, kind: "redirect" },
  { re: /\bNextResponse\.redirect\(/g, kind: "redirect" },
];

/** A statically known target string, or null for an expression. */
function literalValue(arg) {
  const a = arg.trim();
  let m = a.match(/^(["'])((?:\\.|(?!\1).)*)\1$/);
  if (m) return m[2];
  m = a.match(/^`([^`]*)`$/);
  if (m) return m[1].startsWith("${") ? null : m[1];
  m = a.match(/^new\s+URL\(\s*(["'`])((?:(?!\1).)*)\1/); // NextResponse.redirect(new URL("/x", req.url))
  if (m) return m[2].startsWith("${") ? null : m[2];
  if (a.startsWith("{")) { // href={{ pathname: "/x" }}, router.push({ pathname })
    const pathname = objectValue(a, "pathname");
    if (typeof pathname === "string" && !pathname.startsWith("{")) return pathname;
  }
  return null;
}

function normalizeTarget(raw) {
  const t0 = raw.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(t0) || t0.startsWith("//")) {
    const web = t0.match(/^(?:https?:)?\/\/([^/?#]+)/i);
    return { category: "external", host: web ? web[1] : null };
  }
  if (t0.startsWith("#")) return { category: "anchor" };
  // ${expr} and [param] placeholders match dynamic segments.
  let t = t0.replace(/\$\{[^}]*\}/g, ":x").replace(/\[\[?(?:\.\.\.)?[^\]]+\]\]?/g, ":x").split(/[?#]/)[0];
  if (!t.startsWith("/")) return { category: "relative" };
  if (t !== "/") t = t.replace(/\/$/, "");
  return { value: t };
}

// static < :param < :param* < :param*? — the most specific route wins.
const segRank = (seg) => (!seg.startsWith(":") ? 0 : seg.endsWith("*?") ? 3 : seg.endsWith("*") ? 2 : 1);

function compareSpecificity(a, b) {
  const sa = a.urlPath.split("/").slice(1);
  const sb = b.urlPath.split("/").slice(1);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const d = segRank(sa[i]) - segRank(sb[i]);
    if (d) return d;
  }
  return sb.length - sa.length;
}

function routeMatcher(route) {
  if (route.urlPath === "/") return /^\/$/;
  const parts = route.urlPath.split("/").slice(1).map((seg) =>
    ["/" + seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "/[^/]+", "/.+", "(?:/.*)?"][segRank(seg)]);
  return new RegExp(`^${parts.join("")}$`);
}

function routeTable(routes) {
  const exact = new Map();
  for (const r of routes) if (!exact.has(r.urlPath)) exact.set(r.urlPath, r);
  const matchers = [...routes].sort(compareSpecificity).map((r) => ({ r, re: routeMatcher(r) }));
  return (value) => exact.get(value) ?? matchers.find(({ re }) => re.test(value))?.r ?? null;
}

/** Resolve within the source's app, then its project; only project-less files see every route. */
function makeResolver(routes) {
  const tables = new Map();
  const tableFor = (key, pick) => {
    if (!tables.has(key)) tables.set(key, routeTable(routes.filter(pick)));
    return tables.get(key);
  };
  return (value, { app, project }) => {
    if (app) {
      const hit = tableFor(`app:${app}`, (r) => r.app === app)(value);
      if (hit) return hit;
    }
    if (project) return tableFor(`project:${project}`, (r) => r.project === project)(value);
    return tableFor("all", () => true)(value);
  };
}

function makeSpecials(rootDir, nextProjects) {
  const specials = new Map();
  return (kind, project) => {
    const key = `${kind}:${project ?? ""}`;
    if (!specials.has(key)) {
      const rel = project ? path.relative(rootDir, project) || "." : "";
      const label = nextProjects.length > 1 && project ? `${kind} · ${rel}` : kind;
      specials.set(key, { special: true, key, label });
    }
    return specials.get(key);
  };
}

/** "middleware" | "proxy" for a Next middleware file at a project root or its src/. */
function middlewareKind(file, nextProjects) {
  const m = path.basename(file).match(/^(middleware|proxy)\.(js|ts|mjs)$/);
  if (!m) return null;
  const dir = path.dirname(file);
  const project = path.basename(dir) === "src" ? path.dirname(dir) : dir;
  return nextProjects.includes(project) ? { kind: m[1], project } : null;
}

/**
 * Every navigation call site becomes an edge or a `dropped` entry with a
 * category — never neither. Sources are page files (app router), route
 * files (pages router), and element component files (React Router);
 * anything else is "shared".
 */
function collectEdges({ rootDir, files, routes, includeShared, nextProjects, resolve, special }) {
  const sourceByFile = new Map();
  for (const r of routes) {
    const src = "sourceFile" in r ? r.sourceFile : r.file;
    if (src && !sourceByFile.has(src)) sourceByFile.set(src, r);
  }
  const projects = [...new Set(routes.map((r) => r.project))].sort((a, b) => b.length - a.length);
  const projectOf = (file) => projects.find((p) => file.startsWith(p + path.sep)) ?? null;

  const edges = [];
  const dropped = [];
  const external = new Set();
  const seen = new Set();
  for (const file of files) {
    const raw = readText(file);
    if (!raw) continue;
    const text = file.endsWith(".mdx") ? raw : stripComments(raw);
    const owner = sourceByFile.get(file) ?? null;
    const mw = middlewareKind(file, nextProjects);
    const scope = { app: owner?.app ?? null, project: mw?.project ?? owner?.project ?? projectOf(file) };
    for (const site of NAV_SITES) {
      site.re.lastIndex = 0;
      let m;
      while ((m = site.re.exec(text))) {
        const at = m.index + m[0].length;
        const arg = site.attr ? attrValue(text, at) : scanArg(text, at, ",)");
        if (arg === null || !arg.trim()) continue;
        const drop = (category, value) => dropped.push({
          category, value: value.trim().replace(/\s+/g, " ").slice(0, 80), file: path.relative(rootDir, file), line: lineOf(text, m.index),
        });
        if (/^-?\d+$/.test(arg.trim())) { drop("history", arg); continue; }
        const lit = literalValue(arg);
        if (lit === null) { drop("expression", arg); continue; }
        const target = normalizeTarget(lit);
        if (target.host) external.add(target.host);
        if (target.category) { drop(target.category, lit); continue; }
        const resolved = resolve(target.value, scope);
        if (!resolved) { drop("unmatched", lit); continue; }
        let source = mw ? special(mw.kind, mw.project) : owner;
        if (!source) {
          if (!includeShared) { drop("shared", lit); continue; }
          source = special("shared");
        }
        const kind = mw ? "middleware" : site.kind;
        const key = `${source.key ?? `${source.app}\0${source.urlPath}`}→${resolved.app}\0${resolved.urlPath}:${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source, target: resolved, kind });
      }
    }
  }
  return { edges, dropped, external: [...external] };
}

function enclosingBrace(text, index) {
  let depth = 0;
  for (let j = index - 1; j >= 0; j--) {
    if (text[j] === "}") depth++;
    else if (text[j] === "{" && depth-- === 0) return j;
  }
  return -1;
}

/** next.config redirects() and rewrites(), per Next project. */
function collectConfigEdges({ rootDir, nextProjects, resolve, special }) {
  const edges = [];
  const dropped = [];
  for (const project of nextProjects) {
    for (const name of NEXT_CONFIG_NAMES) {
      const file = path.join(project, name);
      const text = existsSync(file) ? stripComments(readText(file)) : "";
      if (!text) continue;
      const starts = (fn) => [...text.matchAll(new RegExp(`\\b${fn}\\s*[(:]`, "g"))].map((x) => x.index);
      const redirectsAt = starts("redirects");
      const rewritesAt = starts("rewrites");
      const lastBefore = (list, i) => Math.max(-1, ...list.filter((x) => x < i));
      for (const m of text.matchAll(/\bsource\s*:/g)) {
        const open = enclosingBrace(text, m.index);
        const obj = open === -1 ? null : extractObjectLiteral(text, open);
        const from = obj && objectValue(obj, "source");
        const to = obj && objectValue(obj, "destination");
        if (typeof from !== "string" || typeof to !== "string") continue;
        const kind = lastBefore(rewritesAt, m.index) > lastBefore(redirectsAt, m.index) ? "rewrite" : "redirect";
        const target = normalizeTarget(to);
        const resolved = target.value ? resolve(target.value, { project }) : null;
        if (!resolved) {
          dropped.push({ category: target.category ?? "unmatched", value: `${kind} ${from} → ${to}`, file: path.relative(rootDir, file), line: lineOf(text, m.index) });
          continue;
        }
        edges.push({ source: special("next.config", project), target: resolved, kind, label: `${kind} ${from}` });
      }
    }
  }
  return { edges, dropped };
}

// --------------------------------------------------------------- mermaid

const esc = (s) => String(s).replace(/"/g, "#quot;");

function emitMermaid({ routes, edges, maxLabel }) {
  const ids = new Map(routes.map((r, i) => [r, `r${i}`]));
  const lines = ["flowchart TD"];
  const apps = [...new Set(routes.map((r) => r.app))];
  let groupId = 0;
  apps.forEach((app, appId) => {
    const groups = new Map();
    for (const r of routes.filter((x) => x.app === app)) {
      const seg = r.urlPath === "/" ? "/" : `/${r.urlPath.split("/")[1]}`;
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg).push(r);
    }
    const indent = apps.length > 1 ? "    " : "  ";
    if (apps.length > 1) lines.push(`  subgraph a${appId}["${esc(app)}"]`);
    for (const [seg, rs] of groups) {
      const many = rs.length > 1;
      if (many) lines.push(`${indent}subgraph g${groupId++}["${esc(seg)}"]`);
      for (const r of rs) lines.push(`${indent}${many ? "  " : ""}${ids.get(r)}["${esc(r.urlPath)}"]`);
      if (many) lines.push(`${indent}end`);
    }
    if (apps.length > 1) lines.push("  end");
  });

  const specials = [...new Set(edges.map((e) => e.source).filter((s) => s.special))];
  specials.forEach((s, i) => {
    ids.set(s, `s${i}`);
    lines.push(`  s${i}{{"${esc(s.label)}"}}`);
  });
  for (const e of edges) {
    const arrow = e.kind === "link" ? "-->"
      : e.label ? `-.->|"${esc(e.label.slice(0, maxLabel))}"|` : `-. ${e.kind} .->`;
    lines.push(`  ${ids.get(e.source)} ${arrow} ${ids.get(e.target)}`);
  }
  return lines.join("\n");
}

// ----------------------------------------------------------------- main

const NEEDS_EYES = ["unmatched", "expression", "relative"];
const BY_DESIGN = {
  shared: "resolved, in non-route files (--include-shared draws them)",
  external: "external URLs",
  anchor: "in-page #anchors",
  history: "history steps (navigate(-1))",
};

const siteLine = (u) => `  - \`${u.value.replace(/`/g, "'")}\` at ${u.file}:${u.line}`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(opts.root);

  const files = [...walkFiles(rootDir)];
  const roots = detectRoots(rootDir, files);
  if (roots.length === 0) {
    throw new UsageError(
      "no routers found (looked for Next.js app/ and pages/ directories and React Router route definitions)",
    );
  }

  const routes = [];
  const unresolvedRoutePaths = [];
  let slots = [];
  let intercepts = [];
  let apiRoutes = 0;
  for (const r of roots) {
    if (r.kind === "next-app") {
      const label = path.relative(rootDir, r.dir) || "app";
      const res = walkAppRouter(r.dir, label);
      routes.push(...res.routes.map((route) => ({ ...route, project: r.project })));
      slots = slots.concat(res.slots);
      intercepts = intercepts.concat(res.intercepts);
      apiRoutes += res.apiRoutes;
    } else if (r.kind === "next-pages") {
      const pages = walkPagesRouter(r.dir, path.relative(rootDir, r.dir) || "pages")
        .map((route) => ({ ...route, project: r.project }));
      if (pages.length === 0) r.empty = true; // e.g. only pages/api
      routes.push(...pages);
    } else if (r.kind === "react-router") {
      const projects = [...new Set(r.files.map((f) => nearestProject(f, rootDir)))];
      const appOf = (file) => {
        const project = nearestProject(file, rootDir);
        const rel = path.relative(rootDir, project) || ".";
        return { project, app: projects.length > 1 ? `${rel} · react-router` : "react-router" };
      };
      const res = parseReactRouter(r.files, appOf, makeChainResolver(files));
      routes.push(...res.routes);
      unresolvedRoutePaths.push(...res.unresolvedPaths.map((u) => ({
        ...u,
        file: path.relative(rootDir, u.file),
      })));
    }
  }

  // Deduplicate same URL within one app (e.g. parallel group variants).
  const dedup = new Map();
  for (const r of routes) {
    const key = `${r.app}:${r.urlPath}`;
    if (!dedup.has(key)) dedup.set(key, r);
  }
  const appOrder = [...new Set(routes.map((r) => r.app))];
  const finalRoutes = [...dedup.values()].sort((a, b) =>
    appOrder.indexOf(a.app) - appOrder.indexOf(b.app) || (a.urlPath < b.urlPath ? -1 : a.urlPath > b.urlPath ? 1 : 0));

  const nextProjects = [...new Set(roots.filter((r) => r.project).map((r) => r.project))];
  const resolve = makeResolver(finalRoutes);
  const special = makeSpecials(rootDir, nextProjects);
  const nav = collectEdges({
    rootDir, files, routes: finalRoutes, includeShared: opts.includeShared, nextProjects, resolve, special,
  });
  const config = collectConfigEdges({ rootDir, nextProjects, resolve, special });
  const edges = [...nav.edges, ...config.edges];
  const dropped = [...nav.dropped, ...config.dropped];

  const mermaid = emitMermaid({ routes: finalRoutes, edges, maxLabel: opts.maxLabel });

  const count = (cat) => dropped.filter((u) => u.category === cat).length;
  const needsEyes = dropped.filter((u) => NEEDS_EYES.includes(u.category));
  const byDesign = Object.keys(BY_DESIGN).filter(count);
  const unresolvedLine = `- **Unresolved navigations (need eyes):** ${needsEyes.length} (${NEEDS_EYES.map((c) => `${count(c)} ${c}`).join(", ")})`;
  const notDrawnLine = `- **Not drawn by design:** ${byDesign.length ? byDesign.map((c) => `${count(c)} ${c}`).join(", ") : "none"}`;
  const report = `## Ramble report

- **Routers:** ${roots.filter((r) => !r.empty).map((r) => r.kind + (r.dir ? ` (${path.relative(rootDir, r.dir)})` : "")).join(", ")}
- **Screens:** ${finalRoutes.length} (${finalRoutes.filter((r) => r.dynamic).length} dynamic)${routes.length !== finalRoutes.length ? ` — ${routes.length - finalRoutes.length} duplicate URL(s) merged` : ""}
- **Edges:** ${edges.length} (${edges.filter((e) => e.kind !== "link").length} redirect/rewrite/middleware)
- **API route handlers (not screens):** ${apiRoutes}
- **Parallel route slots (render inside a screen, not URLs):** ${slots.length}${slots.length ? " — " + [...new Set(slots.map((s) => s.slot))].join(", ") : ""}
- **Intercepting routes (modals-in-place):** ${intercepts.length}${intercepts.length ? "\n" + intercepts.map((i) => `  - ${i.marker}${i.target} under ${i.from || "/"}`).join("\n") : ""}
- **External link hosts:** ${nav.external.length ? nav.external.join(", ") : "none"}
- **Unresolved route path expressions:** ${unresolvedRoutePaths.length}${unresolvedRoutePaths.map((u) => `\n${siteLine(u)}`).join("")}
${unresolvedLine}${NEEDS_EYES.flatMap((c) => dropped.filter((u) => u.category === c)).map((u) => `\n${siteLine(u)} (${u.category})`).join("")}
${notDrawnLine}${byDesign.map((c) => `\n\n<details><summary>${count(c)} ${c}: ${BY_DESIGN[c]}</summary>\n\n${dropped.filter((u) => u.category === c).map(siteLine).join("\n")}\n\n</details>`).join("")}`;

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(path.join(opts.out, "flow.mmd"), mermaid + "\n");
  writeFileSync(
    path.join(opts.out, "flow.md"),
    `# Screen map\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n${report}\n`,
  );

  console.log(`ramble · ${finalRoutes.length} screens, ${edges.length} edges → ${path.join(opts.out, "flow.md")}`);
  console.log(report.split("\n").filter((l) => /^- \*\*(Routers|Screens|Edges|Unresolved route)/.test(l)).join("\n"));
  console.log(`${unresolvedLine}\n${notDrawnLine}`);
  if (opts.thumbs) renderThumbs(finalRoutes, opts);
}

try {
  main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`ramble: ${err.message}`);
    console.error("");
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  console.error(`ramble: unexpected error: ${err?.stack ?? err}`);
  process.exit(EXIT_ERROR);
}
