import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter, parseSkill, hashSkillDir } from "./lib/parse.mjs";
import { discover, where, jaccard, tokenSet } from "./lib/discover.mjs";
import { writeLock, readLock, diffAgainstLock, sectionDiff, changeParagraph, pin } from "./lib/lockfile.mjs";

const CLI = fileURLToPath(new URL("./typecase.mjs", import.meta.url));

let home;
let proj;

function writeSkill(base, rel, name, { description, body = "", extraFiles = {} } = {}) {
  const dir = path.join(base, rel, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---
name: ${name}
description: >-
  ${description}
---

# ${name}

${body}
`);
  for (const [file, contents] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  }
  return dir;
}

before(() => {
  home = mkdtempSync(path.join(tmpdir(), "typecase-home-"));
  proj = mkdtempSync(path.join(tmpdir(), "typecase-proj-"));
  process.env.TYPECASE_HOME = home;
  process.env.TYPECASE_SNAPSHOTS = path.join(home, "snapshots");
  process.on("exit", () => {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  // One skill per tool layout, per the documented paths.
  writeSkill(home, ".grok/skills", "deploy-widgets", {
    description: "Deploy the widget service. Use when the user asks to ship widgets.",
    body: "## Steps\n\nRun `kubectl apply -f widgets.yml`.\n\n## When not to use\n\nDo not use for database migrations.",
  });
  writeSkill(home, ".cursor/skills", "review-pr", {
    description: "Review a pull request for correctness. Use when asked to review code.",
    body: "## Checklist\n\nRead the diff. See [checklist](references/checklist.md).\n\n```bash\ngit diff main...HEAD\n```",
    extraFiles: { "references/checklist.md": "- tests?\n- naming?" },
  });
  // Cursor plugin-cache layout (observed marketplace cache shape).
  writeSkill(home, ".cursor/plugins/cache/public/42/abc123/skills", "plugin-skill", {
    description: "A marketplace plugin skill. Use for plugin things.",
  });
  writeSkill(home, ".claude/skills", "review-pr", {
    description: "Review a pull request for correctness. Use when asked to review code.",
    body: "## Checklist\n\nRead the diff. See [checklist](references/checklist.md).\n\n```bash\ngit diff main...HEAD\n```",
    extraFiles: { "references/checklist.md": "- tests?\n- naming?" },
  });
  // Codex user skills are scanned recursively per docs.
  writeSkill(home, ".codex/skills/nested/group", "release-notes", {
    description: "Write release notes from commits. Use when cutting a release.",
    body: "## How\n\nRun `git log` and `curl https://api.example.com/releases` then write notes.",
  });
  // Overlap pair: different names, same claimed job.
  writeSkill(home, ".agents/skills", "code-review-helper", {
    description: "Review a pull request for correctness and style. Use when asked to review code changes.",
  });
  // Project-scoped skill.
  writeSkill(proj, ".grok/skills", "project-local", {
    description: "Project-only helper. Use inside this repo for local chores.",
  });
});

test("frontmatter parser handles folded blocks and plain scalars", () => {
  const { frontmatter } = parseFrontmatter("---\nname: x\ndescription: >-\n  line one\n  line two\n---\nbody");
  assert.equal(frontmatter.name, "x");
  assert.equal(frontmatter.description, "line one line two");
});

test("discovery finds skills in every documented layout", () => {
  const data = discover({ cwd: proj });
  const names = data.skills.map((s) => `${s.tool}:${s.name}`).sort();
  assert.ok(names.includes("grok:deploy-widgets"), names.join());
  assert.ok(names.includes("grok:project-local"));
  assert.ok(names.includes("cursor:review-pr"));
  assert.ok(names.includes("cursor:plugin-skill"), "cursor plugin cache layout missed");
  assert.ok(names.includes("claude:review-pr"));
  assert.ok(names.includes("codex:release-notes"), "codex recursive scan missed");
  assert.ok(names.includes("shared:code-review-helper"));

  const plugin = data.skills.find((s) => s.name === "plugin-skill");
  assert.equal(plugin.scope, "plugin");
  const local = data.skills.find((s) => s.name === "project-local");
  assert.equal(local.scope, "project");
});

test("parser extracts triggers, when-not, files, commands, risky tools, tokens", () => {
  const data = discover({ cwd: proj });
  const deploy = data.skills.find((s) => s.name === "deploy-widgets");
  assert.match(deploy.triggers, /ship widgets/);
  assert.match(deploy.whenNot, /database migrations/i);
  assert.ok(deploy.commands.includes("kubectl"));
  assert.ok(deploy.tokens > 20);

  const review = data.skills.find((s) => s.name === "review-pr" && s.tool === "cursor");
  assert.deepEqual(review.files, ["references/checklist.md"]);
  assert.ok(review.commands.includes("git"));

  const release = data.skills.find((s) => s.name === "release-notes");
  assert.ok(release.riskyTools.includes("network"), `risky: ${release.riskyTools}`);
});

test("duplicates: same name in two tools, flagged identical when hashes match", () => {
  const data = discover({ cwd: proj });
  const dup = data.duplicates.find((d) => d.name === "review-pr");
  assert.ok(dup, "review-pr duplicate not flagged");
  assert.equal(dup.installs.length, 2);
  assert.equal(dup.identical, true);
});

test("overlaps: different names claiming the same job are flagged", () => {
  const data = discover({ cwd: proj });
  const hit = data.overlaps.find(
    (o) => [o.a.name, o.b.name].sort().join() === "code-review-helper,review-pr",
  );
  assert.ok(hit, `overlap not flagged: ${JSON.stringify(data.overlaps)}`);
  assert.ok(hit.score >= 0.35);
});

test("where ranks the right skill first with its path", () => {
  const data = discover({ cwd: proj });
  const results = where(data, "ship the widget service");
  assert.equal(results[0].skill.name, "deploy-widgets");
  assert.ok(results[0].skill.path.endsWith("SKILL.md"));
});

test("lock → edit → diff produces a section-level change and a readable paragraph", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "typecase-lock-"));
  const lockPath = path.join(cwd, "skills.lock");
  const data = discover({ cwd: proj });
  writeLock(data, lockPath);
  const lock = readLock(lockPath);
  assert.ok(Object.keys(lock.skills).length >= 7);

  // Change a trigger + add a section + a risky command.
  const deployDir = path.join(home, ".grok/skills/deploy-widgets");
  writeFileSync(path.join(deployDir, "SKILL.md"), `---
name: deploy-widgets
description: >-
  Deploy the widget service. Use when the user asks to ship widgets or roll back a deploy.
---

# deploy-widgets

## Steps

Run \`kubectl apply -f widgets.yml\`.

## Rollback

Run \`kubectl rollout undo\` and then \`rm -rf ./cache\`.
`);

  const entries = diffAgainstLock(lock, discover({ cwd: proj }));
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.status, "changed");
  const kinds = e.changes.map((x) => x.kind);
  assert.ok(kinds.includes("section-added"), kinds.join());
  assert.ok(kinds.includes("triggers"));
  assert.ok(kinds.includes("risky-tools"));
  assert.match(e.paragraph, /deploy-widgets/);
  assert.match(e.paragraph, /Rollback/);
  assert.match(e.paragraph, /trigger/i);
});

test("removed and added skills get plain-language paragraphs", () => {
  assert.match(
    changeParagraph({ name: "x", status: "added", description: "Formats SQL.", triggers: "use when formatting sql" }),
    /newly installed/,
  );
  assert.match(changeParagraph({ name: "x", status: "removed", triggers: "sql" }), /no longer loads/);
});

test("pin restores the locked folder and snapshots the current one", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "typecase-pin-"));
  const lockPath = path.join(cwd, "skills.lock");
  const dir = writeSkill(home, ".grok/skills", "pinme", { description: "Original. Use when pinning." });
  const original = hashSkillDir(dir);
  const dataBefore = discover({ cwd: proj });
  writeLock(dataBefore, lockPath);

  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: pinme\ndescription: Mutated.\n---\n\n# pinme\n");
  const mutated = hashSkillDir(dir);
  assert.notEqual(original, mutated);

  const results = pin(readLock(lockPath), discover({ cwd: proj }), "pinme");
  assert.equal(results[0].restored, original.slice(0, 12));
  assert.equal(hashSkillDir(dir), original);
  assert.ok(existsSync(path.join(process.env.TYPECASE_SNAPSHOTS, mutated)), "mutated version not snapshotted");
});

test("CLI: ls/where/show/diff round-trip with exit codes", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "typecase-cli-"));
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env } });

  const ls = run(["ls", "--json"]);
  assert.equal(ls.status, 0, ls.stderr);
  const parsed = JSON.parse(ls.stdout);
  assert.ok(parsed.skills.length >= 6);
  assert.ok(parsed.roots.some((r) => r.tool === "codex"));

  const wh = run(["where", "review", "a", "pull", "request"]);
  assert.equal(wh.status, 0);
  assert.match(wh.stdout, /review-pr/);

  const show = run(["show", "release-notes"]);
  assert.equal(show.status, 0);
  assert.match(show.stdout, /risky/);
  assert.match(show.stdout, /network/);

  const lock = run(["lock"]);
  assert.equal(lock.status, 0, lock.stderr);
  const diffClean = run(["diff"]);
  assert.equal(diffClean.status, 0, diffClean.stdout + diffClean.stderr);

  writeSkill(home, ".grok/skills", "brand-new", { description: "Brand new skill. Use for novelty." });
  const diffDirty = run(["diff"]);
  assert.equal(diffDirty.status, 1, "diff should exit 1 when changes exist");
  assert.match(diffDirty.stdout, /brand-new/);
  assert.match(diffDirty.stdout, /newly installed/);
  rmSync(path.join(home, ".grok/skills/brand-new"), { recursive: true, force: true });
});

test("config file adds extra roots", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "typecase-cfg-"));
  const extra = path.join(cwd, "my-skills");
  writeSkill(cwd, "my-skills", "config-skill", { description: "From a configured path. Use when configured." });
  writeFileSync(path.join(cwd, "typecase.json"), JSON.stringify({ paths: [{ dir: extra, tool: "shared", scope: "user" }] }));
  const data = discover({ cwd });
  assert.ok(data.skills.some((s) => s.name === "config-skill"));
});

test("unreadable or malformed SKILL.md becomes a parse-error record, not a crash", () => {
  const dir = path.join(home, ".claude/skills/broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: [unterminated\n");
  const data = discover({ cwd: proj });
  const broken = data.skills.find((s) => s.name === "broken" || s.path.includes("broken"));
  assert.ok(broken, "broken skill not discovered at all");
  rmSync(dir, { recursive: true, force: true });
});
