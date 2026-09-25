import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./scrub.mjs", import.meta.url));

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const opts = { skip: hasFfmpeg ? false : "ffmpeg not installed" };

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "scrub-test-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
});

// Synthetic clips, built on first use so every test can run alone.
const FIXTURES = {
  // Moving 40px box, back-ease-out (overshoot ~10%): still 0–0.5s,
  // animates x 20→220 over 0.5–1.5s peaking near x≈242, still 1.5–2.5s.
  "eased.mp4": (out) => {
    const easedX =
      "if(lt(t,0.5),20,if(lt(t,1.5),20+200*(1+2.70158*pow(t-1.5,3)+1.70158*pow(t-1.5,2)),220))";
    ffmpeg([
      "-f", "lavfi", "-i", "color=c=0x202020:s=320x240:d=2.5:r=30",
      "-f", "lavfi", "-i", "color=c=white:s=40x40:d=2.5:r=30",
      "-filter_complex", `[0][1]overlay=x='${easedX}':y=100`,
      "-pix_fmt", "yuv420p", out,
    ]);
  },
  // VFR variant: drop frames irregularly, keep original timestamps.
  // Matroska keeps the gaps without -fps_mode, which ffmpeg 4.4 lacks.
  "vfr.mkv": (out) => ffmpeg(["-i", fixture("eased.mp4"), "-vf", "select='not(mod(n\\,3))+not(mod(n\\,2))'", out]),
  "still.mp4": (out) => ffmpeg(["-f", "lavfi", "-i", "color=c=0x404040:s=320x240:d=1.5:r=30", "-pix_fmt", "yuv420p", out]),
  // 12s of continuous oscillation (360 frames).
  "long.mp4": (out) => ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x202020:s=320x240:d=12:r=30",
    "-f", "lavfi", "-i", "color=c=white:s=30x30:d=12:r=30",
    "-filter_complex", "[0][1]overlay=x='145+100*sin(t*2)':y=100",
    "-pix_fmt", "yuv420p", out,
  ]),
  "eased.gif": (out) => ffmpeg(["-i", fixture("eased.mp4"), "-vf", "fps=15", out]),
  // Box still at x=20 through frame 29, then 6px/frame until frame 59:
  // motion arrives at frames 30..59 exactly.
  "linear.mp4": (out) => ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x202020:s=640x360:d=3:r=30",
    "-f", "lavfi", "-i", "color=c=white:s=40x40:d=3:r=30",
    "-filter_complex", "[0][1]overlay=x='20+6*clip(n-30\\,0\\,30)':y=160",
    "-pix_fmt", "yuv420p", out,
  ]),
};

function fixture(name) {
  const out = file(name);
  if (!existsSync(out)) FIXTURES[name](out);
  return out;
}

// Scrub each (fixture, args) once; later tests reuse the output.
const runs = new Map();
function scrubbed(name, args = []) {
  const key = [name, ...args].join(" ");
  if (!runs.has(key)) {
    const outDir = file(`run-${runs.size}-${name.replace(/\W/g, "_")}`);
    const { code, out } = runScrub([fixture(name), "--out", outDir, ...args]);
    assert.equal(code, 0, out);
    runs.set(key, outDir);
  }
  return runs.get(key);
}

function file(name) {
  return path.join(dir, name);
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
}

function runScrub(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: res.status, out: res.stdout + res.stderr };
}

function readCsv(outDir) {
  const [header, ...lines] = readFileSync(path.join(outDir, "motion.csv"), "utf8").trim().split("\n");
  const cols = header.split(",");
  return lines.map((l) => {
    const parts = l.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, parts[i] === "" ? null : Number(parts[i])]));
  });
}

function readIndex(outDir) {
  return readFileSync(path.join(outDir, "index.md"), "utf8");
}

test("recovers eased motion with overshoot within tolerance", opts, () => {
  const rows = readCsv(scrubbed("eased.mp4")).filter((r) => r.cx !== null);
  assert.ok(rows.length > 15, `expected many motion rows, got ${rows.length}`);

  // x first changes on frame 16 (t=0.533s).
  assert.equal(rows[0].frame, 16);
  assert.equal(rows[0].ms, 533);

  // Overshoot: cx peaks well past where it settles.
  const maxCx = Math.max(...rows.map((r) => r.cx));
  const settleCx = rows.at(-1).cx;
  assert.ok(maxCx >= settleCx + 8, `expected overshoot: peak cx ${maxCx} vs settle cx ${settleCx}`);

  // Settles near the box's final center (220+20=240), pixel-diff estimate.
  assert.ok(Math.abs(settleCx - 240) <= 10, `settle cx ${settleCx}, expected ~240`);

  // Vertical position stays put around cy=120.
  const cys = rows.map((r) => r.cy);
  assert.ok(Math.min(...cys) >= 110 && Math.max(...cys) <= 130, `cy range ${Math.min(...cys)}–${Math.max(...cys)}`);
});

test("labels motion rows with the exact frame they arrive at", opts, () => {
  const rows = readCsv(scrubbed("linear.mp4")).filter((r) => r.cx !== null);
  assert.deepEqual([rows[0].frame, rows[0].ms], [30, 1000]);
  assert.deepEqual([rows.at(-1).frame, rows.at(-1).ms], [59, 1967]);
  // Row 30 spans the old (x=20) and new (x=26) box.
  assert.deepEqual([rows[0].x, rows[0].w], [20, 46]);
});

test("trims still head/tail to an active window", opts, () => {
  const index = readIndex(scrubbed("linear.mp4"));
  // First motion at 30, last at 59, padded by 3 frames (plus the frame before).
  assert.match(index, /Active window:\*\* frames 26–62 /);
  assert.match(index, /still head\/tail trimmed automatically/);
});

test("crops to the motion band and upscales small crops", opts, () => {
  const index = readIndex(scrubbed("eased.mp4"));
  const m = index.match(/Motion crop:\*\* x=(\d+) y=(\d+) (\d+)×(\d+)px/);
  assert.ok(m, "index.md should state the motion crop");
  const [, , y, , h] = m.map(Number);
  // The box moves along y=100..140; crop (24px pad) must cover it and
  // stay a horizontal band, not the full frame.
  assert.ok(y >= 60 && y <= 80, `crop y ${y}`);
  assert.ok(h <= 120, `crop h ${h} should be a band, not the full 240`);
  assert.match(index, /upscaled \dx/);
});

test("writes stamped contact sheets, diff sheets, chart, and index sections", opts, () => {
  const outDir = scrubbed("eased.mp4");
  assert.ok(existsSync(path.join(outDir, "overview.png")));
  assert.ok(existsSync(path.join(outDir, "sheets/sheet-01.png")));
  assert.ok(existsSync(path.join(outDir, "sheets/diff-01.png")));
  assert.ok(existsSync(path.join(outDir, "motion-curve.svg")));
  assert.ok(existsSync(path.join(outDir, "work/normalized.mp4")));
  const index = readIndex(outDir);
  for (const section of ["## Metadata", "## Motion summary", "## Files", "## Per-frame motion table", "## How to read the results"]) {
    assert.ok(index.includes(section), `missing ${section}`);
  }
  assert.match(index, /\| frame \| ms \|/);
  assert.match(index, /not\*\* the real animation values/);
});

test("handles variable frame rate input", opts, () => {
  const outDir = scrubbed("vfr.mkv");
  assert.match(readIndex(outDir), /variable frame rate detected/);

  // The normalized clip must be constant-rate.
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json",
    path.join(outDir, "work/normalized.mp4"),
  ], { encoding: "utf8" }));
  assert.equal(probe.streams[0].avg_frame_rate, probe.streams[0].r_frame_rate);

  // Motion is still recovered: overshoot survives retiming.
  const rows = readCsv(outDir).filter((r) => r.cx !== null);
  assert.ok(rows.length >= 8, `expected motion rows, got ${rows.length}`);
  const maxCx = Math.max(...rows.map((r) => r.cx));
  assert.ok(Math.abs(rows.at(-1).cx - 240) <= 12 && maxCx > rows.at(-1).cx, "motion shape recovered from VFR input");
});

test("still clip reports no motion and keeps output minimal", opts, () => {
  const outDir = scrubbed("still.mp4");
  assert.match(readIndex(outDir), /No motion detected/);
  assert.ok(existsSync(path.join(outDir, "overview.png")));
  assert.ok(!existsSync(path.join(outDir, "sheets/sheet-01.png")));
});

test("long clips are capped", opts, () => {
  const outDir = scrubbed("long.mp4", ["--max-frames", "32"]);
  const sheets = readdirSync(path.join(outDir, "sheets")).filter((f) => f.startsWith("sheet-"));
  assert.ok(sheets.length <= 2, `expected ≤2 dense sheets for --max-frames 32, got ${sheets.length}`);
});

test("gif input just works", opts, () => {
  const outDir = scrubbed("eased.gif");
  assert.match(readIndex(outDir), /## Motion summary/);
  assert.ok(existsSync(path.join(outDir, "sheets/sheet-01.png")));
});

test("missing input is a usage error", () => {
  const res = spawnSync(process.execPath, [CLI, "/nonexistent/clip.mp4"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /input not found/);
});

test("--out never deletes a directory holding the input", opts, () => {
  const project = file("project");
  mkdirSync(project, { recursive: true });
  copyFileSync(fixture("linear.mp4"), path.join(project, "clip.mp4"));
  writeFileSync(path.join(project, "notes.txt"), "keep");
  for (const out of [".", project, path.join(project, "clip.mp4")]) {
    const res = spawnSync(process.execPath, [CLI, "clip.mp4", "--out", out], { cwd: project, encoding: "utf8" });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /contains the input video/);
  }
  assert.deepEqual(readdirSync(project).sort(), ["clip.mp4", "notes.txt"]);
});

test("--out refuses a non-empty directory that is not a scrub output", opts, () => {
  const foreign = file("foreign");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(path.join(foreign, "keep.txt"), "mine");
  const { code, out } = runScrub([fixture("still.mp4"), "--out", foreign]);
  assert.equal(code, 2, out);
  assert.match(out, /not a previous scrub output/);
  assert.deepEqual(readdirSync(foreign), ["keep.txt"]);
});

test("re-running into a previous scrub output replaces only scrub's files", opts, () => {
  const outDir = file("rerun-scrub");
  assert.equal(runScrub([fixture("linear.mp4"), "--out", outDir]).code, 0);
  writeFileSync(path.join(outDir, "sheets", "sheet-99.png"), "stale");
  writeFileSync(path.join(outDir, "notes.md"), "mine");
  const { code, out } = runScrub([fixture("still.mp4"), "--out", outDir]);
  assert.equal(code, 0, out);
  assert.match(readIndex(outDir), /No motion detected/);
  assert.ok(!existsSync(path.join(outDir, "sheets", "sheet-99.png")), "stale sheet removed");
  assert.equal(readFileSync(path.join(outDir, "notes.md"), "utf8"), "mine");
});

test("paths with %, colons, quotes and shell syntax work", opts, () => {
  const names = ["50% off %d.mp4", "a:b.mp4", "x$(touch PWNED)`touch PWNED2`;'q'.mp4", path.join("100%", "clip.mp4")];
  mkdirSync(file("100%"), { recursive: true });
  for (const name of names) {
    copyFileSync(fixture("linear.mp4"), file(name));
    const { code, out } = runScrub([name]);
    assert.equal(code, 0, `${name}: ${out}`);
    assert.ok(existsSync(file(`${name.replace(/\.mp4$/, "")}-scrub/sheets/sheet-03.png`)), name);
  }
  assert.ok(!existsSync(file("PWNED")) && !existsSync(file("PWNED2")));
});

test("falls back to unstamped sheets when ffmpeg cannot draw text", opts, () => {
  const outDir = file("nostamp-scrub");
  const { code, out } = runScrub([fixture("linear.mp4"), "--out", outDir], { SCRUB_NO_DRAWTEXT: "1" });
  assert.equal(code, 0, out);
  assert.match(out, /cannot draw text.*ffmpeg-full/s);
  assert.ok(existsSync(path.join(outDir, "sheets/sheet-01.png")));
  const index = readIndex(outDir);
  assert.match(index, /Cells are unstamped/);
  assert.match(index, /`sheets\/sheet-01.png`: f26 867ms, f27 900ms, /);
  assert.match(index, /`sheets\/sheet-03.png`: f58 1933ms, .*f62 2067ms\n/);
});
