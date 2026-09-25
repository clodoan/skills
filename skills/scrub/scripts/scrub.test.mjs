import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
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
  if (!hasFfmpeg) return;

  // Moving 40px box, back-ease-out (overshoot ~10%): still 0–0.5s,
  // animates x 20→220 over 0.5–1.5s peaking near x≈242, still 1.5–2.5s.
  const easedX =
    "if(lt(t,0.5),20,if(lt(t,1.5),20+200*(1+2.70158*pow(t-1.5,3)+1.70158*pow(t-1.5,2)),220))";
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x202020:s=320x240:d=2.5:r=30",
    "-f", "lavfi", "-i", "color=c=white:s=40x40:d=2.5:r=30",
    "-filter_complex", `[0][1]overlay=x='${easedX}':y=100`,
    "-pix_fmt", "yuv420p", file("eased.mp4"),
  ]);

  // VFR variant: drop frames irregularly, keep original timestamps.
  ffmpeg([
    "-i", file("eased.mp4"),
    "-vf", "select='not(mod(n\\,3))+not(mod(n\\,2))'",
    "-fps_mode", "vfr", file("vfr.mp4"),
  ]);

  // Completely still clip.
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x404040:s=320x240:d=1.5:r=30", "-pix_fmt", "yuv420p", file("still.mp4")]);

  // Long clip: 12s of continuous oscillation (360 frames).
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x202020:s=320x240:d=12:r=30",
    "-f", "lavfi", "-i", "color=c=white:s=30x30:d=12:r=30",
    "-filter_complex", "[0][1]overlay=x='145+100*sin(t*2)':y=100",
    "-pix_fmt", "yuv420p", file("long.mp4"),
  ]);

  // GIF input.
  ffmpeg(["-i", file("eased.mp4"), "-vf", "fps=15", file("eased.gif")]);
});

function file(name) {
  return path.join(dir, name);
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
}

function runScrub(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
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

test("recovers eased motion with overshoot within tolerance", opts, () => {
  const { code, out } = runScrub([file("eased.mp4")]);
  assert.equal(code, 0, out);
  const outDir = file("eased-scrub");
  const rows = readCsv(outDir).filter((r) => r.cx !== null);
  assert.ok(rows.length > 15, `expected many motion rows, got ${rows.length}`);

  // Motion starts near 500ms (frame 15 at 30fps).
  assert.ok(Math.abs(rows[0].ms - 500) <= 100, `motion starts at ${rows[0].ms}ms, expected ~500ms`);

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

test("trims still head/tail to an active window", opts, () => {
  const index = readFileSync(file("eased-scrub/index.md"), "utf8");
  const m = index.match(/Active window:\*\* frames (\d+)–(\d+)/);
  assert.ok(m, "index.md should state the active window");
  const [start, end] = [Number(m[1]), Number(m[2])];
  // True motion spans frames 15–45 of 75; window is padded but must trim
  // most of the 0–0.5s head and 1.5–2.5s tail.
  assert.ok(start >= 8 && start <= 16, `window start ${start}, expected 8–16`);
  assert.ok(end >= 43 && end <= 52, `window end ${end}, expected 43–52`);
  assert.match(index, /still head\/tail trimmed automatically/);
});

test("crops to the motion band and upscales small crops", opts, () => {
  const index = readFileSync(file("eased-scrub/index.md"), "utf8");
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
  const outDir = file("eased-scrub");
  assert.ok(existsSync(path.join(outDir, "overview.png")));
  assert.ok(existsSync(path.join(outDir, "sheets/sheet-01.png")));
  assert.ok(existsSync(path.join(outDir, "sheets/diff-01.png")));
  assert.ok(existsSync(path.join(outDir, "motion-curve.svg")));
  assert.ok(existsSync(path.join(outDir, "work/normalized.mp4")));
  const index = readFileSync(path.join(outDir, "index.md"), "utf8");
  for (const section of ["## Metadata", "## Motion summary", "## Files", "## Per-frame motion table", "## How to read the results"]) {
    assert.ok(index.includes(section), `missing ${section}`);
  }
  assert.match(index, /\| frame \| ms \|/);
  assert.match(index, /not\*\* the real animation values/);
});

test("handles variable frame rate input", opts, () => {
  const { code, out } = runScrub([file("vfr.mp4")]);
  assert.equal(code, 0, out);
  const index = readFileSync(file("vfr-scrub/index.md"), "utf8");
  assert.match(index, /variable frame rate detected/);

  // The normalized clip must be constant-rate.
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json",
    file("vfr-scrub/work/normalized.mp4"),
  ], { encoding: "utf8" }));
  assert.equal(probe.streams[0].avg_frame_rate, probe.streams[0].r_frame_rate);

  // Motion is still recovered: overshoot survives retiming.
  const rows = readCsv(file("vfr-scrub")).filter((r) => r.cx !== null);
  assert.ok(rows.length >= 8, `expected motion rows, got ${rows.length}`);
  const maxCx = Math.max(...rows.map((r) => r.cx));
  assert.ok(Math.abs(rows.at(-1).cx - 240) <= 12 && maxCx > rows.at(-1).cx, "motion shape recovered from VFR input");
});

test("still clip reports no motion and keeps output minimal", opts, () => {
  const { code, out } = runScrub([file("still.mp4")]);
  assert.equal(code, 0, out);
  const index = readFileSync(file("still-scrub/index.md"), "utf8");
  assert.match(index, /No motion detected/);
  assert.ok(existsSync(file("still-scrub/overview.png")));
  assert.ok(!existsSync(file("still-scrub/sheets/sheet-01.png")));
});

test("long clips are capped and sampled by motion peaks", opts, () => {
  const { code, out } = runScrub([file("long.mp4"), "--max-frames", "32"]);
  assert.equal(code, 0, out);
  const index = readFileSync(file("long-scrub/index.md"), "utf8");
  assert.match(index, /motion peaks/);
  const sheets = readdirSync(file("long-scrub/sheets")).filter((f) => f.startsWith("sheet-"));
  assert.ok(sheets.length <= 2, `expected ≤2 dense sheets for --max-frames 32, got ${sheets.length}`);
});

test("gif input just works", opts, () => {
  const { code, out } = runScrub([file("eased.gif"), "--out", file("gif-scrub")]);
  assert.equal(code, 0, out);
  const index = readFileSync(file("gif-scrub/index.md"), "utf8");
  assert.match(index, /## Motion summary/);
  assert.ok(existsSync(file("gif-scrub/sheets/sheet-01.png")));
});

test("missing input is a usage error", () => {
  const res = spawnSync(process.execPath, [CLI, "/nonexistent/clip.mp4"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /input not found/);
});
