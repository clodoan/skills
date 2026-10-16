import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanSource, scan, classifyBooleans, propose } from "./analyze.mjs";
import { computeLayout, SHEET } from "./compose.mjs";
import { decodePng, pngSize, encodePng, getPixel } from "./png.mjs";

const CLI = fileURLToPath(new URL("./statesheet.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

const hasChrome =
  spawnSync("google-chrome", ["--version"], { stdio: "ignore" }).status === 0 ||
  spawnSync("google-chrome-stable", ["--version"], { stdio: "ignore" }).status === 0 ||
  Boolean(process.env.STATESHEET_BROWSER);
// CI sets STATESHEET_REQUIRE_BROWSER=1 so a runner losing Chrome fails
// loudly instead of silently skipping the integration tests.
const browserSkip = hasChrome || process.env.STATESHEET_REQUIRE_BROWSER ? false : "Chrome not installed";

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
}

// ------------------------------------------------------------- analyze

test("scanSource finds the boolean pile and its companions", () => {
  const source = readFileSync(path.join(FIXTURES, "save-button.tsx"), "utf8");
  const hits = scanSource(source, "save-button.tsx");
  assert.equal(hits.length, 1);
  const [hit] = hits;
  assert.equal(hit.name, "SaveButton");
  assert.deepEqual(
    hit.booleans.map((b) => b.name),
    ["isSaving", "isSaved", "hasError", "showTooltip"],
  );
  assert.deepEqual(hit.companions.map((b) => b.name), ["error"]);
  assert.equal(hit.usesReducer, false);
});

test("scanSource attributes useStates to the right component", () => {
  const source = `
export function Quiet() { return null; }
export function Busy() {
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  return null;
}
const PAGE_SIZE = 10;
function useThing() {
  const [hasData, setHasData] = useState(false);
  return hasData;
}
`;
  const hits = scanSource(source);
  assert.deepEqual(hits.map((h) => h.name), ["Busy", "useThing"]);
  assert.deepEqual(hits[0].booleans.map((b) => b.name), ["isLoading", "isOpen"]);
  assert.deepEqual(hits[1].booleans.map((b) => b.name), ["hasData"]);
});

test("scanSource treats typed and React-qualified useState, and flags useReducer", () => {
  const source = `
const Widget = () => {
  const [open, setOpen] = React.useState<boolean>(false);
  const [state, dispatch] = useReducer(reducer, init);
  return null;
};
`;
  const hits = scanSource(source);
  assert.equal(hits[0].name, "Widget");
  assert.deepEqual(hits[0].booleans.map((b) => b.name), ["open"]);
  assert.equal(hits[0].usesReducer, true);
});

test("scan walks a tree, honors --min, and skips tests/node_modules", () => {
  const { scanned, piles } = scan(FIXTURES, { min: 2 });
  assert.ok(scanned >= 2);
  assert.deepEqual(piles.map((p) => p.name), ["SaveButton"]);
  assert.equal(piles[0].booleans.length, 4);
});

test("classifyBooleans buckets lifecycle vs toggle flags", () => {
  const buckets = classifyBooleans([
    { name: "isSaving" },
    { name: "hasError" },
    { name: "isSaved" },
    { name: "showTooltip" },
  ]);
  assert.deepEqual(buckets.loading.map((b) => b.name), ["isSaving"]);
  assert.deepEqual(buckets.error.map((b) => b.name), ["hasError"]);
  assert.deepEqual(buckets.success.map((b) => b.name), ["isSaved"]);
  assert.deepEqual(buckets.toggle.map((b) => b.name), ["showTooltip"]);
});

test("propose emits a lifecycle machine driven only by the table", () => {
  const source = readFileSync(path.join(FIXTURES, "save-button.tsx"), "utf8");
  const [pile] = scanSource(source, "fixtures/save-button.tsx");
  const proposal = propose(pile);

  assert.equal(proposal.machine.kind, "lifecycle");
  assert.deepEqual(proposal.machine.statuses, ["idle", "loading", "success", "error"]);
  // The tooltip toggle must stay out of the machine.
  assert.deepEqual(proposal.flags.map((b) => b.name), ["showTooltip"]);

  const { code } = proposal;
  assert.match(code, /idle: \{ START: "loading" \}/);
  assert.match(code, /loading: \{ RESOLVE: "success", REJECT: "error" \}/);
  assert.match(code, /as const satisfies Record<SaveButtonStatus/);
  assert.match(code, /illegal transition/);
  assert.match(code, /const exhaustive: never = next/);
  // The reducer must read transitions from the table, not hardcode them.
  assert.match(code, /transitions\[state\.status\]/);
});

test("propose models async booleans as lifecycle and keeps toggles out (jira_clone Comment shape)", () => {
  const hits = scanSource(`
const Comment = ({ comment }) => {
  const [isFormOpen, setFormOpen] = useState(false);
  const [isUpdating, setUpdating] = useState(false);
  return null;
};
`);
  const proposal = propose(hits[0]);
  assert.equal(proposal.machine.kind, "lifecycle");
  assert.deepEqual(proposal.machine.covered.map((b) => b.name), ["isUpdating"]);
  assert.deepEqual(proposal.flags.map((b) => b.name), ["isFormOpen"]);
  // A flag must never double as a machine status.
  assert.ok(!proposal.machine.statuses.includes("formOpen"));
});

test("propose scaffolds statuses from names when there is no lifecycle", () => {
  const hits = scanSource(`
function Disclosure() {
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  return null;
}
`);
  const proposal = propose(hits[0]);
  assert.equal(proposal.machine.kind, "scaffold");
  assert.deepEqual(proposal.machine.statuses, ["idle", "open", "pinned"]);
  assert.match(proposal.code, /ENTER_OPEN: "open"/);
});

// ------------------------------------------------------------- layout

function fakeSizes(states, columns, cssH = 300) {
  const sizes = new Map();
  states.forEach((s) => columns.forEach((c, j) => sizes.set(`${s}|${j}`, { cssW: c.viewport, cssH })));
  return sizes;
}

test("computeLayout produces an even grid with exact positions", () => {
  const states = ["loading", "error"];
  const columns = [
    { viewport: 375, theme: "light" },
    { viewport: 768, theme: "light" },
    { viewport: 375, theme: "dark" },
    { viewport: 768, theme: "dark" },
  ];
  const layout = computeLayout({ states, columns, sizes: fakeSizes(states, columns), scale: 0.5 });

  assert.deepEqual(layout.colW, [188, 384, 188, 384]);
  // Even gaps inside a theme group, groupGap across the theme boundary.
  assert.equal(layout.colX[1] - (layout.colX[0] + layout.colW[0]), SHEET.gap);
  assert.equal(layout.colX[2] - (layout.colX[1] + layout.colW[1]), SHEET.groupGap);
  assert.equal(layout.colX[3] - (layout.colX[2] + layout.colW[2]), SHEET.gap);
  // Sheet closes with the same padding it opened with.
  assert.equal(layout.width, layout.colX[3] + layout.colW[3] + SHEET.pad);
  // Rows: uniform height (same capture height), even gap.
  assert.deepEqual(layout.rowH, [150, 150]);
  assert.equal(layout.rowY[1] - layout.rowY[0], 150 + SHEET.gap);
  assert.equal(layout.height, layout.rowY[1] + layout.rowH[1] + SHEET.pad);
  assert.equal(layout.cells.length, states.length * columns.length);
  // Two theme groups spanning their two columns each.
  assert.deepEqual(layout.groups.map((g) => g.theme), ["light", "dark"]);
  assert.equal(layout.groups[0].w, layout.colX[1] + layout.colW[1] - layout.colX[0]);
});

test("computeLayout uses the tallest capture per row and fails on a missing cell", () => {
  const states = ["a"];
  const columns = [
    { viewport: 375, theme: "light" },
    { viewport: 768, theme: "light" },
  ];
  const sizes = new Map([
    ["a|0", { cssW: 375, cssH: 600 }],
    ["a|1", { cssW: 768, cssH: 200 }],
  ]);
  const layout = computeLayout({ states, columns, sizes, scale: 0.5 });
  assert.deepEqual(layout.rowH, [300]);
  const short = layout.cells.find((c) => c.col === 1);
  assert.equal(short.h, 100);
  assert.equal(short.boxH, 300);

  assert.throws(
    () => computeLayout({ states: ["a", "b"], columns, sizes, scale: 0.5 }),
    /missing capture for b/,
  );
});

// ------------------------------------------------------------- png

test("png round-trip: encode then decode and sample", () => {
  const w = 4, h = 2;
  const pixels = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) pixels.set([200, 100, 50, 255], i * 4);
  const buf = encodePng(w, h, pixels);
  assert.deepEqual(pngSize(buf), { width: w, height: h });
  const img = decodePng(buf);
  assert.deepEqual(getPixel(img, 3, 1), [200, 100, 50, 255]);
});

// ------------------------------------------------------------- CLI

test("CLI validates arguments and exits 2", () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(["bogus"]).status, 2);
  assert.equal(runCli(["sheet"]).status, 2);
  assert.equal(runCli(["sheet", "nope.states.tsx"]).status, 2);
  assert.equal(runCli(["scan"]).status, 2);
  assert.equal(runCli(["propose", "nope.tsx"]).status, 2);
  const badTheme = runCli(["sheet", path.join(FIXTURES, "async-panel.states.tsx"), "--themes", "sepia"]);
  assert.equal(badTheme.status, 2);
  assert.match(badTheme.stderr, /bad theme/);
});

test("CLI scan reports the fixture pile", () => {
  const res = runCli(["scan", FIXTURES, "--json"]);
  assert.equal(res.status, 0);
  const { piles } = JSON.parse(res.stdout);
  assert.equal(piles[0].name, "SaveButton");
  assert.equal(piles[0].booleans.length, 4);
});

test("CLI propose prints the reducer and respects --component", () => {
  const res = runCli(["propose", path.join(FIXTURES, "save-button.tsx"), "--component", "SaveButton"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /16 representable/);
  assert.match(res.stdout, /export const transitions/);

  const miss = runCli(["propose", path.join(FIXTURES, "save-button.tsx"), "--component", "Nope"]);
  assert.equal(miss.status, 2);
  assert.match(miss.stderr, /no component "Nope"/);
});

// ------------------------------------------------- sheet (needs Chrome)

test("sheet renders the fixture, passes its own checks, and writes a verified PNG", { skip: browserSkip, timeout: 120000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "statesheet-test-"));
  try {
    const out = path.join(dir, "sheet.png");
    const res = runCli([
      "sheet",
      path.join(FIXTURES, "async-panel.states.tsx"),
      "--out", out,
      "--states", "loading,error",
      "--viewports", "375,768",
      "--wait", "50",
    ]);
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const checkLines = res.stdout.split("\n").filter((l) => l.startsWith("check:"));
    assert.equal(checkLines.length, 4, res.stdout);
    for (const line of checkLines) assert.match(line, /— ok$/);

    assert.ok(existsSync(out));
    const { width, height } = pngSize(readFileSync(out));
    // 2 states × (2 viewports × 2 themes); dimensions must match the
    // computed layout exactly — re-derive the width from the constants.
    const colW = [188, 384, 188, 384];
    const labelW = Math.max(96, Math.min(220, 24 + Math.ceil(7.4 * "loading".length)));
    const expectedW =
      SHEET.pad + labelW + SHEET.gap +
      colW[0] + SHEET.gap + colW[1] + SHEET.groupGap + colW[2] + SHEET.gap + colW[3] +
      SHEET.pad;
    assert.equal(width, expectedW * 2);
    assert.ok(height > 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sheet fails loudly when a state cannot render", { skip: browserSkip, timeout: 120000 }, () => {
  const res = runCli([
    "sheet",
    path.join(FIXTURES, "async-panel.states.tsx"),
    "--states", "loading,missing-state",
  ]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown states: missing-state/);
});
