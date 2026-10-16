/**
 * Boolean-pile detection and reducer proposals.
 *
 * `scan` finds React components (and custom hooks) whose local state is
 * a pile of boolean useStates — the `isLoading && !error && …` shape —
 * with a cheap lexical pass (no typechecker; see README for limits).
 * `propose` turns one pile into a reducer whose only source of truth is
 * an explicit transition table: a transition that is not a row in the
 * table does not happen, so adding one requires editing the table where
 * review will see it.
 */

import fs from "node:fs";
import path from "node:path";

const DECL_RE =
  /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([\w$]+)\s*\(|const\s+([\w$]+)\s*(?::[^=\n]*)?=\s*(?:React\.)?(?:memo\s*\(|forwardRef\s*\()?\s*(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>))/g;

const USESTATE_RE =
  /const\s*\[\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\]\s*=\s*(?:React\.)?useState(?:<[^(\n]*?>)?\s*\(([^)]*)\)/g;

const USEREDUCER_RE = /(?:React\.)?useReducer\s*\(/;

const COMPONENTISH = (name) =>
  (/^[A-Z]/.test(name) && /[a-z]/.test(name)) || /^use[A-Z]/.test(name);

const BOOL_NAME_RE = /^(is|has|should|can|did|was|show|hide)[A-Z_]/;
const COMPANION_RE = /^(error|err|data|result|results|response)s?$/i;

export const BUCKETS = {
  loading: /load|fetch|submit|saving|updating|creating|deleting|refreshing|pending|progress|working|busy|processing|sending|uploading|downloading/i,
  success: /success|done|complete|loaded|saved|sent|finished/i,
  error: /error|fail|invalid/i,
  toggle: /open|show|visible|expand|collaps|hover|focus|active|select|edit|menu|modal|dialog|drawer|dropdown|tooltip|checked|enabled|disabled|dark|muted|pinned/i,
};

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** Scan one source string. Returns [{ name, line, booleans, companions, usesReducer }]. */
export function scanSource(source, file = "<source>") {
  const decls = [];
  for (const m of source.matchAll(DECL_RE)) {
    const name = m[1] || m[2];
    if (name && COMPONENTISH(name)) {
      decls.push({ name, index: m.index, line: lineOf(source, m.index + m[0].search(/\S/)) });
    }
  }
  if (decls.length === 0) return [];

  const owners = decls.map((d, i) => ({
    ...d,
    end: i + 1 < decls.length ? decls[i + 1].index : source.length,
    booleans: [],
    companions: [],
    usesReducer: false,
  }));
  const ownerAt = (index) => {
    let found = null;
    for (const o of owners) if (o.index <= index && index < o.end) found = o;
    return found;
  };

  for (const m of source.matchAll(USESTATE_RE)) {
    const owner = ownerAt(m.index);
    if (!owner) continue;
    const [, name, setter, rawInit] = m;
    const init = rawInit.trim();
    const entry = { name, setter: setter || null, init, line: lineOf(source, m.index) };
    if (init === "true" || init === "false") owner.booleans.push(entry);
    else if (BOOL_NAME_RE.test(name) && ["", "null", "undefined"].includes(init)) owner.booleans.push(entry);
    else if (COMPANION_RE.test(name)) owner.companions.push(entry);
  }

  for (const o of owners) {
    const body = source.slice(o.index, o.end);
    o.usesReducer = USEREDUCER_RE.test(body);
  }

  return owners
    .filter((o) => o.booleans.length > 0)
    .map(({ name, line, booleans, companions, usesReducer }) => ({
      file,
      name,
      line,
      booleans,
      companions,
      usesReducer,
    }));
}

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".next", ".git",
  "storybook-static", "__snapshots__", "vendor",
]);
const SKIP_FILE_RE = /\.(test|spec|stories)\.[jt]sx?$|\.d\.ts$/;
const SOURCE_FILE_RE = /\.[jt]sx?$/;

export function collectSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(path.join(dir, entry.name));
      } else if (SOURCE_FILE_RE.test(entry.name) && !SKIP_FILE_RE.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  walk(root);
  return files;
}

/** Scan a file or directory tree. Returns { scanned, piles } with piles sorted by size. */
export function scan(root, { min = 2 } = {}) {
  const files = collectSourceFiles(root);
  const piles = [];
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const hit of scanSource(source, file)) {
      if (hit.booleans.length >= min) piles.push(hit);
    }
  }
  piles.sort((a, b) => b.booleans.length - a.booleans.length || a.file.localeCompare(b.file));
  return { scanned: files.length, piles };
}

export function classifyBooleans(booleans) {
  const buckets = { loading: [], success: [], error: [], toggle: [], other: [] };
  for (const b of booleans) {
    if (BUCKETS.loading.test(b.name)) buckets.loading.push(b);
    else if (BUCKETS.error.test(b.name)) buckets.error.push(b);
    else if (BUCKETS.success.test(b.name)) buckets.success.push(b);
    else if (BUCKETS.toggle.test(b.name)) buckets.toggle.push(b);
    else buckets.other.push(b);
  }
  return buckets;
}

const camel = (s) => s.replace(/^(is|has|should|can|did|was|show|hide)(?=[A-Z])/, "").replace(/^[A-Z]/, (c) => c.toLowerCase());

/**
 * Build the reducer proposal for one pile.
 * Returns { component, machine, flags, code, summary }.
 */
export function propose(pile) {
  const buckets = classifyBooleans(pile.booleans);
  const lifecycle = buckets.loading.length > 0 || (buckets.error.length > 0 && buckets.success.length > 0);

  let machine;
  let flags;
  if (lifecycle) {
    flags = [...buckets.toggle, ...buckets.other];
    machine = {
      kind: "lifecycle",
      statuses: ["idle", "loading", "success", "error"],
      events: ["START", "RESOLVE", "REJECT", "RESET"],
      table: {
        idle: { START: "loading" },
        loading: { RESOLVE: "success", REJECT: "error" },
        success: { START: "loading", RESET: "idle" },
        error: { START: "loading", RESET: "idle" },
      },
      covered: [...buckets.loading, ...buckets.success, ...buckets.error],
    };
  } else {
    // No async lifecycle detected: scaffold statuses from the boolean
    // names so a human (or agent) renames them and fills in the edges.
    // Toggles stay out as flags unless the whole pile is toggles (a pure
    // disclosure component), in which case they ARE the states.
    const nonToggle = [...buckets.success, ...buckets.error, ...buckets.other];
    const covered = nonToggle.length > 0 ? nonToggle : pile.booleans;
    flags = nonToggle.length > 0 ? buckets.toggle : [];
    const statuses = ["idle", ...covered.map((b) => camel(b.name))];
    const events = covered.map((b) => `ENTER_${camel(b.name).replace(/[^\w]/g, "_").toUpperCase()}`);
    const table = Object.fromEntries(statuses.map((s) => [s, {}]));
    statuses.slice(1).forEach((s, i) => {
      table.idle[events[i]] = s;
      table[s].RESET = "idle";
    });
    machine = { kind: "scaffold", statuses, events: [...events, "RESET"], table, covered };
  }

  const code = renderReducer(pile, machine, flags);
  const combos = 2 ** pile.booleans.length;
  const summary =
    `${pile.name} (${pile.file}:${pile.line}): ${pile.booleans.length} boolean useStates ` +
    `(${pile.booleans.map((b) => b.name).join(", ")}) → ${combos} representable combinations; ` +
    `proposing ${machine.statuses.length} explicit states (${machine.statuses.join(", ")})` +
    (flags.length > 0 ? `; kept as orthogonal flags: ${flags.map((b) => b.name).join(", ")}` : "");

  return { component: pile.name, machine, flags, code, summary };
}

function renderReducer(pile, machine, flags) {
  const C = pile.name.replace(/^use(?=[A-Z])/, "");
  const statusType = `${C}Status`;
  const stateType = `${C}State`;
  const eventType = `${C}Event`;
  const statuses = machine.statuses;
  const events = machine.events;

  const tableRows = statuses
    .map((s) => {
      const row = machine.table[s];
      const entries = Object.entries(row).map(([ev, next]) => `${ev}: "${next}"`).join(", ");
      const todo = machine.kind === "scaffold" && Object.keys(row).length === 0 ? " // TODO: which events leave this state?" : "";
      return `  ${s}: {${entries ? ` ${entries} ` : ""}},${todo}`;
    })
    .join("\n");

  const stateVariants = statuses
    .map((s) => {
      if (s === "error") return `  | { status: "error"; error: string }`;
      if (s === "success") return `  | { status: "success"; data: unknown /* TODO: type the payload */ }`;
      return `  | { status: "${s}" }`;
    })
    .join("\n");

  const eventVariants = events
    .map((ev) => {
      if (ev === "RESOLVE") return `  | { type: "RESOLVE"; data: unknown }`;
      if (ev === "REJECT") return `  | { type: "REJECT"; error: string }`;
      return `  | { type: "${ev}" }`;
    })
    .join("\n");

  const caseLines = statuses
    .map((s) => {
      if (s === "error") return `    case "error":\n      return { status: "error", error: event.type === "REJECT" ? event.error : "unknown" };`;
      if (s === "success") return `    case "success":\n      return { status: "success", data: event.type === "RESOLVE" ? event.data : undefined };`;
      return `    case "${s}":\n      return { status: "${s}" };`;
    })
    .join("\n");

  const flagNote =
    flags.length > 0
      ? `\n// Orthogonal UI flags NOT folded into the machine (they can legally\n// combine with any status): ${flags.map((b) => b.name).join(", ")}.\n// Keep them as separate useStates or lift them next to the reducer.`
      : "";

  const booleans = pile.booleans.map((b) => b.name).join(", ");

  return `// Proposed by statesheet for ${pile.name} (${pile.file}:${pile.line}).
// Replaces ${pile.booleans.length} boolean useStates (${booleans}) — ${2 ** pile.booleans.length} representable
// combinations, most of them impossible states — with one machine.
//
// The reducer consults ONLY the \`transitions\` table below. A transition
// that is not a row in the table does not happen: to allow a new one,
// the table itself must be edited, where review will see it.
${flagNote}

export type ${statusType} = ${statuses.map((s) => `"${s}"`).join(" | ")};

export type ${stateType} =
${stateVariants};

export type ${eventType} =
${eventVariants};

export const transitions = {
${tableRows}
} as const satisfies Record<${statusType}, Partial<Record<${eventType}["type"], ${statusType}>>>;

export function reducer(state: ${stateType}, event: ${eventType}): ${stateType} {
  const row: Partial<Record<${eventType}["type"], ${statusType}>> = transitions[state.status];
  const next = row[event.type];
  if (next === undefined) {
    // Not in the table → not a legal transition. Loud in dev, inert in prod.
    const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
    if (env !== "production") {
      throw new Error(\`illegal transition: \${state.status} + \${event.type} — add a row to \\\`transitions\\\` if this should exist\`);
    }
    return state;
  }
  switch (next) {
${caseLines}
    default: {
      const exhaustive: never = next;
      return exhaustive;
    }
  }
}

/* Wire-up sketch:
 *   const [state, dispatch] = useReducer(reducer, { status: "idle" });
 *   ${machine.kind === "lifecycle" ? `was \`${booleans}\` → now \`state.status === "loading"\` etc.` : "rename the scaffold statuses to match your domain, then fill the table."}
 *
 * Statesheet states file for the contact sheet:
 *   export default {
 *     component: ${C},
 *     states: {
${statuses.map((s) => ` *       ${s}: { },`).join("\n")}
 *     },
 *   };
 */
`;
}
