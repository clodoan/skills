import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "chip.mjs");

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** Fresh repo on branch `main` with one base commit, plus a `feature` branch checked out. */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "chip-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "chip@test.local"]);
  git(dir, ["config", "user.name", "chip test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  return dir;
}

function write(dir, relPath, contents) {
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), contents);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

function runChip(dir, args = []) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const lines = (n, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n";

test("pass: small diff within all budgets", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/feature.js", lines(30));
  commitAll(dir, "small change");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /PASS/);
  assert.match(stdout, /✓ lines changed/);
});

test("pass: uncommitted working-tree changes are counted too", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/wip.js", lines(600)); // not committed

  const { code, stdout } = runChip(dir);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL/);
});

test("fail: big diff exceeds line budget and suggests a split", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/huge.js", lines(300));
  write(dir, "docs/huge.md", lines(300));
  commitAll(dir, "big change");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /✗ lines changed\s+600 \/ budget 400/);
  assert.match(stdout, /How to split:/);
  assert.match(stdout, /Split by area/);
  assert.match(stdout, /src\s+\(1 file, ~300 lines\)/);
  assert.match(stdout, /docs\s+\(1 file, ~300 lines\)/);
  assert.match(stdout, /Chip-Override/); // mentions the escape hatch
});

test("fail: single-area big diff suggests splitting by layer", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/only.js", lines(600));
  commitAll(dir, "one big file");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /Split by layer or by step/i);
});

test("fail: too many areas touched", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/a.js", lines(5));
  write(dir, "docs/b.md", lines(5));
  write(dir, "tools/c.sh", lines(5));
  write(dir, "web/d.ts", lines(5));
  commitAll(dir, "sprawl");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /✗ areas touched\s+4 \/ budget 3/);
  assert.match(stdout, /areas: docs, src, tools, web/);
});

test("areas: workspace roots count children as separate areas", (t) => {
  const dir = makeRepo(t);
  write(dir, "packages/ui/a.js", lines(5));
  write(dir, "packages/core/b.js", lines(5));
  commitAll(dir, "two packages");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /areas: packages\/core, packages\/ui/);
});

test("risky: lockfile + migration exceeds the risky-surface budget", (t) => {
  const dir = makeRepo(t);
  write(dir, "package-lock.json", lines(50));
  write(dir, "db/migrations/001_init.sql", "create table t (id int);\n");
  commitAll(dir, "risky pair");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /✗ risky surfaces\s+2 \/ budget 1/);
  assert.match(stdout, /risky \(lockfile\): package-lock\.json/);
  assert.match(stdout, /risky \(migration\): db\/migrations\/001_init\.sql/);
  assert.match(stdout, /Ship each risky surface as its own scoped PR/);
});

test("risky: a lone lockfile bump passes, and its lines don't hit the line budget", (t) => {
  const dir = makeRepo(t);
  write(dir, "pnpm-lock.yaml", lines(5000)); // generated churn
  commitAll(dir, "bump deps");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /✓ lines changed\s+0 \/ budget 400/);
  assert.match(stdout, /risky \(lockfile\): pnpm-lock\.yaml/);
});

test("risky: CI config and public API surfaces are detected", (t) => {
  const dir = makeRepo(t);
  write(dir, ".github/workflows/ci.yml", lines(5));
  write(dir, "package.json", "{}\n");
  commitAll(dir, "ci + api");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /risky \(CI config\): \.github\/workflows\/ci\.yml/);
  assert.match(stdout, /risky \(public API \/ exports\): package\.json/);
});

test("escape hatch: Chip-Override commit trailer lets an over-budget diff pass loudly", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/huge.js", lines(900));
  commitAll(dir, "big change\n\nChip-Override: atomic generated bootstrap, split not possible");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /OVERRIDDEN/);
  assert.match(stdout, /atomic generated bootstrap/);
  assert.match(stdout, /✗ lines changed/); // report still shows the breach
});

test("escape hatch: --override flag passes with a visible reason", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/huge.js", lines(900));
  commitAll(dir, "big change");

  const { code, stdout } = runChip(dir, ["--override", "PR label: chip-override"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /OVERRIDDEN/);
  assert.match(stdout, /PR label: chip-override/);
});

test("escape hatch: empty --override is ignored (safe CI pass-through)", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/huge.js", lines(900));
  commitAll(dir, "big change");

  const { code, stdout } = runChip(dir, ["--override", ""]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL/);
});

test("override on a passing diff does not print the banner", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/small.js", lines(10));
  commitAll(dir, "small\n\nChip-Override: not needed");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /PASS/);
  assert.doesNotMatch(stdout, /OVERRIDDEN/);
});

test("config: chip.config.json budgets override the defaults", (t) => {
  const dir = makeRepo(t);
  write(dir, "chip.config.json", JSON.stringify({ budgets: { maxLines: 10 } }) + "\n");
  write(dir, "src/a.js", lines(20));
  commitAll(dir, "config + change");

  const { code, stdout } = runChip(dir);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /✗ lines changed\s+21 \/ budget 10/);
});

test("range mode: checks an explicit commit range", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/big.js", lines(600));
  commitAll(dir, "big");
  write(dir, "src/small-after.js", lines(5)); // uncommitted; must be ignored in range mode

  const { code, stdout } = runChip(dir, ["--range", "main..HEAD"]);
  assert.equal(code, 1, stdout);
  assert.match(stdout, /✗ lines changed\s+600 \/ budget 400/);
  assert.doesNotMatch(stdout, /small-after/);
});

test("no changes: exits 0 with a notice", (t) => {
  const dir = makeRepo(t);
  const { code, stdout } = runChip(dir);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no changes/);
});

test("--json emits machine-readable verdict", (t) => {
  const dir = makeRepo(t);
  write(dir, "src/huge.js", lines(900));
  write(dir, "package-lock.json", lines(10));
  commitAll(dir, "big");

  const { code, stdout } = runChip(dir, ["--json"]);
  assert.equal(code, 1, stdout);
  const json = JSON.parse(stdout);
  assert.equal(json.pass, false);
  assert.equal(json.lines, 900);
  assert.equal(json.files, 2);
  assert.deepEqual(json.risky.lockfiles, ["package-lock.json"]);
  assert.ok(json.failed.includes("lines changed"));
});
