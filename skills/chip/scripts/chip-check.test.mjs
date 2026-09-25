import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./chip-check.mjs", import.meta.url));

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" });
}

function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "chip-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "chip@test.invalid"]);
  sh(dir, "git", ["config", "user.name", "chip test"]);
  write(dir, "README.md", "# fixture\n");
  commit(dir, "seed");
  return dir;
}

function write(repo, file, contents) {
  const full = path.join(repo, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function commit(repo, message) {
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", message]);
}

function runChip(repo, args = []) {
  const res = spawnSync(process.execPath, [CLI, "--base", "main", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

function lines(n, prefix = "line") {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";
}

test("small diff passes", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/button.ts", lines(20));
  const { code, out } = runChip(repo);
  assert.equal(code, 0, out);
  assert.match(out, /PASS/);
});

test("big diff fails with budget message and split suggestion", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/big.ts", lines(400));
  const { code, out } = runChip(repo);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL/);
  assert.match(out, /budget is 300/);
  assert.match(out, /Suggested split/);
});

test("too many areas fails and suggests per-area steps", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/a.ts", lines(30));
  write(repo, "docs/b.md", lines(30));
  write(repo, "infra/c.tf", lines(30));
  const { code, out } = runChip(repo);
  assert.equal(code, 1, out);
  assert.match(out, /3 areas touched/);
  assert.match(out, /1\. \S+: 1 file\(s\)/);
  assert.match(out, /2\. \S+: 1 file\(s\)/);
  assert.match(out, /3\. \S+: 1 file\(s\)/);
});

test("too many files fails even when lines are small", (t) => {
  const repo = makeRepo(t);
  for (let i = 0; i < 14; i++) write(repo, `src/f${i}.ts`, lines(2));
  const { code, out } = runChip(repo);
  assert.equal(code, 1, out);
  assert.match(out, /14 files touched — budget is 12/);
});

test("migration alongside real code fails, even under global budgets", (t) => {
  const repo = makeRepo(t);
  write(repo, "db/migrations/0001_add_users.sql", "create table users (id int);\n");
  write(repo, "src/users.ts", lines(120));
  const { code, out } = runChip(repo);
  assert.equal(code, 1, out);
  assert.match(out, /migration touched/);
  assert.match(out, /Ship the migration alone/);
});

test("lockfile bulk is excluded from line budget but must ship nearly alone", (t) => {
  const repo = makeRepo(t);
  write(repo, "pnpm-lock.yaml", lines(2000, "dep"));
  write(repo, "src/feature.ts", lines(120));
  const { code, out } = runChip(repo);
  assert.equal(code, 1, out);
  // 2000 lockfile lines must not trip the 300-line budget on their own.
  assert.doesNotMatch(out, /\d{4,} lines changed/);
  assert.match(out, /lockfile \/ dependency change touched/);
});

test("lockfile with small glue passes", (t) => {
  const repo = makeRepo(t);
  write(repo, "pnpm-lock.yaml", lines(2000, "dep"));
  write(repo, "package.json", '{"dependencies":{"left-pad":"^1.0.0"}}\n');
  const { code, out } = runChip(repo);
  assert.equal(code, 0, out);
  assert.match(out, /PASS/);
});

test("public API changes are reported but informational", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/index.ts", lines(20, "export"));
  const { code, out } = runChip(repo);
  assert.equal(code, 0, out);
  assert.match(out, /public API \/ package manifest/);
});

test("escape hatch: Chip-Override commit trailer turns fail into loud pass", (t) => {
  const repo = makeRepo(t);
  sh(repo, "git", ["checkout", "-q", "-b", "feature"]);
  write(repo, "src/big.ts", lines(500));
  commit(repo, "huge change\n\nChip-Override: scaffolding a new repo, split is not meaningful");
  const { code, out } = runChip(repo);
  assert.equal(code, 0, out);
  assert.match(out, /FAIL/); // violations still reported
  assert.match(out, /OVERRIDE ACTIVE/);
  assert.match(out, /scaffolding a new repo/);
});

test("escape hatch: --override flag with reason passes loudly", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/big.ts", lines(500));
  const { code, out } = runChip(repo, ["--override", "generated fixtures"]);
  assert.equal(code, 0, out);
  assert.match(out, /OVERRIDE ACTIVE/);
  assert.match(out, /generated fixtures/);
});

test("escape hatch: --override without a reason is a usage error", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/big.ts", lines(500));
  const { code, out } = runChip(repo, ["--override", "  "]);
  assert.equal(code, 2, out);
  assert.match(out, /non-empty reason/);
});

test("no override means a big diff really fails", (t) => {
  const repo = makeRepo(t);
  sh(repo, "git", ["checkout", "-q", "-b", "feature"]);
  write(repo, "src/big.ts", lines(500));
  commit(repo, "huge change with no trailer");
  const { code } = runChip(repo);
  assert.equal(code, 1);
});

test("chip.config.json overrides budgets", (t) => {
  const repo = makeRepo(t);
  write(repo, "chip.config.json", JSON.stringify({ maxLines: 10 }));
  commit(repo, "add config");
  write(repo, "src/small.ts", lines(20));
  const { code, out } = runChip(repo);
  assert.equal(code, 1, out);
  assert.match(out, /budget is 10/);
});

test("config ignore patterns exclude files from all counts", (t) => {
  const repo = makeRepo(t);
  write(repo, "chip.config.json", JSON.stringify({ ignore: ["**/*.snap"] }));
  commit(repo, "add config");
  write(repo, "src/tiny.ts", lines(5));
  write(repo, "src/__snapshots__/huge.snap", lines(5000, "snap"));
  const { code, out } = runChip(repo);
  assert.equal(code, 0, out);
  assert.match(out, /PASS/);
});

test("--range checks a committed range instead of the working tree", (t) => {
  const repo = makeRepo(t);
  sh(repo, "git", ["checkout", "-q", "-b", "feature"]);
  write(repo, "src/big.ts", lines(500));
  commit(repo, "big committed change");
  // dirty working tree noise should not be part of a --range check
  write(repo, "src/uncommitted.ts", lines(5));
  const res = spawnSync(process.execPath, [CLI, "--range", "main...HEAD"], {
    cwd: repo,
    encoding: "utf8",
  });
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 1, out);
  assert.match(out, /FAIL/);
  assert.doesNotMatch(out, /uncommitted\.ts/);
});

test("untracked files count toward the working-tree diff", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/new-big.ts", lines(400));
  // never staged, never committed
  const { code, out } = runChip(repo);
  assert.equal(code, 1, out);
  assert.match(out, /budget is 300/);
});

test("renamed files are normalized and counted once", (t) => {
  const repo = makeRepo(t);
  write(repo, "src/old-name.ts", lines(50));
  commit(repo, "add file on main");
  sh(repo, "git", ["checkout", "-q", "-b", "feature"]);
  sh(repo, "git", ["mv", "src/old-name.ts", "src/new-name.ts"]);
  commit(repo, "rename");
  const { code, out } = runChip(repo);
  assert.equal(code, 0, out);
  assert.match(out, /PASS/);
});
