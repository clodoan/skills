/* Electron smoke test: launch, grid renders, search opens a skill,
   History tab shows the change paragraph. Runs against a hermetic
   fixture home so CI never depends on the runner's real skills. */

import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ALPHA = `---
name: alpha-review
description: Review pull requests for style and risky changes.
---

# Alpha review

## When to use
When a PR needs a style pass.

## When not to use
Not for generated code.

## Steps
Run \`git diff\` and read every hunk.
`;

const BETA = `---
name: beta-notes
description: Take structured meeting notes.
---

# Beta notes

Write notes with owners and deadlines.
`;

let home;
let app;
let page;

test.beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "typecase-smoke-"));
  mkdirSync(path.join(home, ".grok/skills/alpha-review"), { recursive: true });
  mkdirSync(path.join(home, ".claude/skills/beta-notes"), { recursive: true });
  writeFileSync(path.join(home, ".grok/skills/alpha-review/SKILL.md"), ALPHA);
  writeFileSync(path.join(home, ".claude/skills/beta-notes/SKILL.md"), BETA);

  // Lock, then change alpha so History has something real to show.
  process.env.TYPECASE_HOME = home;
  process.env.TYPECASE_SNAPSHOTS = path.join(home, ".cache/typecase/snapshots");
  const { discover } = await import("../../scripts/lib/discover.mjs");
  const { writeLock } = await import("../../scripts/lib/lockfile.mjs");
  writeLock(discover({ cwd: home }), path.join(home, "skills.lock"));
  writeFileSync(
    path.join(home, ".grok/skills/alpha-review/SKILL.md"),
    ALPHA + "\n## Escalation\nStop and ask before force-pushing anything.\n",
  );

  app = await electron.launch({
    cwd: appDir,
    args: [appDir, "--no-sandbox"],
    env: { ...process.env, TYPECASE_HOME: home, TYPECASE_CWD: home },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  rmSync(home, { recursive: true, force: true });
});

test("grid renders every fixture skill with count and badges", async () => {
  await expect(page.locator(".card")).toHaveCount(2);
  await expect(page.locator(".count-head h1")).toHaveText("2 Skills");
  await expect(page.locator(".card", { hasText: "alpha-review" }).locator(".badge.changed")).toBeVisible();
});

test("search palette finds and opens a skill", async () => {
  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(page.locator(".palette")).toBeVisible();
  await page.locator("#palette-input").fill("meeting notes");
  await expect(page.locator(".palette-row.selected .name")).toHaveText("beta-notes");
  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-hero")).toHaveText("beta-notes");
  await expect(page.locator(".row", { hasText: "Path" })).toContainText("beta-notes/SKILL.md");
});

test("History tab shows the plain-language change paragraph", async () => {
  await page.keyboard.press("Escape"); // back to grid
  await page.locator(".card", { hasText: "alpha-review" }).click();
  await expect(page.locator(".detail-hero")).toHaveText("alpha-review");
  await page.locator('#segmented button[data-tab="history"]').click();
  await expect(page.locator(".history-entry .para").first()).toContainText("Escalation");
  await expect(page.locator(".diff-list li.added")).toContainText("Escalation");
});

test("sidebar tool filter narrows the grid", async () => {
  await page.keyboard.press("Escape");
  await page.locator(".nav-item", { hasText: "Claude Code" }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card .hero")).toHaveText("beta-notes");
});
