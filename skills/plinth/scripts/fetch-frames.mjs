#!/usr/bin/env node
/**
 * plinth fetch-frames — download official Apple Product Bezels into the
 * local cache (~/.cache/plinth/frames), gated on the license.
 *
 * The art is governed by Apple's App Store Marketing Artwork License
 * Agreement (shipped inside each .dmg): a limited, NON-TRANSFERABLE
 * license for App Store marketing by Apple Developer Program members.
 * That does not permit redistribution, so plinth never commits these
 * images — every machine fetches them from Apple's own CDN and must
 * accept the license here first. Checksums (dmg + extracted PNG) are
 * pinned in frames.mjs and verified.
 *
 *   node scripts/fetch-frames.mjs [device ...] [--accept-license]
 *
 * Requires 7z (p7zip) to extract Apple's .dmg archives.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { FRAME_MANIFEST, APPLE_LICENSE_NOTE, framesCacheDir, cachedFramePath } from "./frames.mjs";

const args = process.argv.slice(2);
const acceptFlag = args.includes("--accept-license");
const devices = args.filter((a) => !a.startsWith("-"));
const targets = devices.length ? devices : Object.keys(FRAME_MANIFEST);

for (const id of targets) {
  if (!FRAME_MANIFEST[id]) {
    console.error(`fetch-frames: no official frame art for "${id}" (have: ${Object.keys(FRAME_MANIFEST).join(", ")})`);
    process.exit(2);
  }
}

const has7z = spawnSync("7z", ["--help"], { stdio: "ignore" }).status === 0;
if (!has7z) {
  console.error("fetch-frames: 7z not found — install p7zip (e.g. `apt-get install p7zip-full` / `brew install p7zip`)");
  process.exit(2);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function confirmLicense() {
  console.log("─".repeat(72));
  console.log("LICENSE — read before downloading:");
  console.log(APPLE_LICENSE_NOTE);
  console.log("The full agreement text ships inside each download and is saved next");
  console.log("to the cached art. By accepting you confirm YOUR use qualifies.");
  console.log("─".repeat(72));
  if (acceptFlag) {
    console.log("license accepted via --accept-license");
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("fetch-frames: not a TTY — re-run with --accept-license to accept Apple's license terms");
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question("Type 'yes' to accept: ", resolve));
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.error("fetch-frames: license not accepted; nothing downloaded");
    process.exit(2);
  }
}

await confirmLicense();
mkdirSync(framesCacheDir(), { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), "plinth-frames-"));

try {
  const byDmg = new Map();
  for (const id of targets) {
    const entry = FRAME_MANIFEST[id];
    if (!byDmg.has(entry.dmgUrl)) byDmg.set(entry.dmgUrl, []);
    byDmg.get(entry.dmgUrl).push(id);
  }

  for (const [dmgUrl, ids] of byDmg) {
    const dmgFile = path.join(work, path.basename(new URL(dmgUrl).pathname));
    console.log(`fetch-frames · downloading ${dmgUrl}`);
    const res = await fetch(dmgUrl);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const dmgBuf = Buffer.from(await res.arrayBuffer());
    const expectedDmg = FRAME_MANIFEST[ids[0]].dmgSha256;
    const gotDmg = sha256(dmgBuf);
    if (gotDmg !== expectedDmg) {
      throw new Error(
        `dmg checksum mismatch for ${dmgUrl}\n  expected ${expectedDmg}\n  got      ${gotDmg}\n` +
          "Apple may have republished the package; refusing to proceed. Update frames.mjs after re-verifying.",
      );
    }
    writeFileSync(dmgFile, dmgBuf);

    for (const id of ids) {
      const entry = FRAME_MANIFEST[id];
      const extract = spawnSync("7z", ["x", "-y", `-o${work}`, dmgFile, entry.pathInDmg], { encoding: "utf8" });
      const extracted = path.join(work, entry.pathInDmg);
      if (extract.status !== 0 || !existsSync(extracted)) {
        throw new Error(`extraction failed for ${entry.pathInDmg}:\n${extract.stderr?.slice(-400)}`);
      }
      const pngBuf = readFileSync(extracted);
      const gotPng = sha256(pngBuf);
      if (gotPng !== entry.pngSha256) {
        throw new Error(`png checksum mismatch for ${id}\n  expected ${entry.pngSha256}\n  got      ${gotPng}`);
      }
      writeFileSync(cachedFramePath(id), pngBuf);
      writeFileSync(
        path.join(framesCacheDir(), `${id}.attribution.json`),
        JSON.stringify({ source: dmgUrl, pathInDmg: entry.pathInDmg, attribution: entry.attribution, sha256: gotPng, fetchedAt: new Date().toISOString(), license: "App Store Marketing Artwork License Agreement (see license.rtf)" }, null, 2),
      );
      console.log(`  ✓ ${id} → ${cachedFramePath(id)} (sha256 ${gotPng.slice(0, 12)}…)`);
    }

    // Keep the full license text next to the art.
    const licenseInDmg = `${FRAME_MANIFEST[ids[0]].pathInDmg.split("/")[0]}/App Store Marketing Artwork License Agreement.rtf`;
    spawnSync("7z", ["x", "-y", `-o${work}`, dmgFile, licenseInDmg], { stdio: "ignore" });
    const licenseFile = path.join(work, licenseInDmg);
    if (existsSync(licenseFile)) {
      writeFileSync(path.join(framesCacheDir(), "license.rtf"), readFileSync(licenseFile));
    }
  }
  console.log(`fetch-frames · done — cache: ${framesCacheDir()}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
