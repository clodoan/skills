#!/usr/bin/env node
/**
 * scrub — frame-by-frame UI animation inspection for coding agents.
 *
 * Wraps ffmpeg/ffprobe. Takes a screen recording (CleanShot X, QuickTime,
 * Screen Studio, .gif, ...) and writes an output folder with an index.md
 * the agent reads first: metadata, motion-trimmed and motion-cropped
 * contact sheets stamped with frame numbers and milliseconds, difference
 * sheets, and a per-frame motion table (CSV + chart) estimated from
 * pixel differencing.
 *
 * Requires ffmpeg + ffprobe on PATH. No other dependencies. Node >= 18.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const EXIT_OK = 0;
const EXIT_ERR = 2;

const DIFF_THRESHOLD = 24; // 0-255 luma delta that counts as "changed"
const NOISE_FRACTION = 0.0004; // changed-pixel fraction below which a frame is "still"
const TRIM_PAD_FRAMES = 3;
const CROP_MAX_COVERAGE = 0.85; // skip cropping when motion covers most of the frame
const UPSCALE_TARGET = 320; // upscale crops until min dimension reaches this
const MAX_UPSCALE = 4;
// Everything scrub writes; only these are removed when reusing an output dir.
const SCRUB_OUTPUTS = ["index.md", "overview.png", "motion.csv", "motion-curve.svg", "sheets", "work"];

class UsageError extends Error {}

// Intermediate files created during a run, removed unless --keep-work.
const workFiles = [];

function usage() {
  return `Usage: scrub <video> [options]

Analyzes a screen recording frame by frame and writes <video>-scrub/
with an index.md, stamped contact sheets, difference sheets, and a
per-frame motion table.

Options:
  --out <dir>         Output directory (default: <video>-scrub next to input);
                      must be new, empty, or a previous scrub output
  --fps <n>           Override the normalized frame rate
  --grid <n>          Contact sheet grid (default 4 = 4x4 cells)
  --max-frames <n>    Cap on frames in dense sheets (default 96)
  --pad <px>          Padding around the motion crop (default 24)
  --no-crop           Analyze the full frame, skip motion cropping
  --keep-work         Keep intermediate files in work/
  -h, --help          Show this help`;
}

function parseArgs(argv) {
  const opts = {
    input: null, out: null, fps: null, grid: 4,
    maxFrames: 96, pad: 24, crop: true, keepWork: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${arg}`);
      return v;
    };
    const nextInt = () => {
      const n = Number(next());
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${arg} needs a positive number`);
      return Math.round(n);
    };
    switch (arg) {
      case "--out": opts.out = next(); break;
      case "--fps": opts.fps = nextInt(); break;
      case "--grid": opts.grid = nextInt(); break;
      case "--max-frames": opts.maxFrames = nextInt(); break;
      case "--pad": opts.pad = nextInt(); break;
      case "--no-crop": opts.crop = false; break;
      case "--keep-work": opts.keepWork = true; break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(EXIT_OK);
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
        if (opts.input) throw new UsageError("only one input video is supported");
        opts.input = arg;
    }
  }
  if (!opts.input) throw new UsageError("missing input video");
  if (!existsSync(opts.input)) throw new UsageError(`input not found: ${opts.input}`);
  if (!statSync(opts.input).isFile()) throw new UsageError(`input is not a file: ${opts.input}`);
  return opts;
}

// Refuse any directory that holds the input or someone else's files.
// A previous scrub output (index.md + work/) is reused by removing only
// scrub's own files.
function prepareOutDir(outDir, input) {
  if (existsSync(outDir)) {
    const rel = path.relative(realpathSync(outDir), realpathSync(input));
    if (rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
      throw new UsageError(`output dir ${outDir} contains the input video; pass a different --out`);
    }
    if (!statSync(outDir).isDirectory()) throw new UsageError(`output path ${outDir} is not a directory`);
    const entries = readdirSync(outDir);
    const previousRun = entries.includes("index.md") && entries.includes("work");
    if (entries.length > 0 && !previousRun) {
      throw new UsageError(`output dir ${outDir} is not empty and is not a previous scrub output; pass a new or empty --out`);
    }
    for (const name of SCRUB_OUTPUTS) rmSync(path.join(outDir, name), { recursive: true, force: true });
  }
  mkdirSync(path.join(outDir, "work"), { recursive: true });
}

function checkTools() {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const res = spawnSync(tool, ["-version"], { stdio: "ignore" });
    if (res.error || res.status !== 0) {
      throw new UsageError(`${tool} not found on PATH — scrub needs ffmpeg (e.g. \`brew install ffmpeg\` or \`apt-get install ffmpeg\`)`);
    }
  }
}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = err.stderr?.toString().split("\n").slice(-8).join("\n") ?? "";
    throw new Error(`${cmd} ${args.slice(0, 4).join(" ")}... failed:\n${stderr}`);
  }
}

function parseRate(rate) {
  const [num, den] = String(rate ?? "0/1").split("/").map(Number);
  return den ? num / den : 0;
}

function probe(input) {
  const json = JSON.parse(run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration",
    "-show_entries", "format=duration",
    "-of", "json", input,
  ]));
  const stream = json.streams?.[0];
  if (!stream) throw new UsageError(`no video stream in ${input}`);

  // Sample packet timestamps (first 20s) to detect variable frame rate.
  const ptsCsv = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-read_intervals", "%+20",
    "-show_entries", "packet=pts_time",
    "-of", "csv=p=0", input,
  ]);
  const pts = ptsCsv.split("\n").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i] - pts[i - 1];
    if (d > 0.0001) deltas.push(d);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
  const distinctMs = new Set(deltas.map((d) => Math.round(d * 1000)));
  const vfr =
    deltas.length >= 4 &&
    (distinctMs.size > 2 || (deltas.at(-1) / deltas[0] > 1.5));

  const avgFps = parseRate(stream.avg_frame_rate);
  const medianFps = median > 0 ? 1 / median : 0;
  const duration = Number(stream.duration ?? json.format?.duration ?? 0);

  return {
    width: stream.width,
    height: stream.height,
    duration,
    avgFps,
    reportedFps: parseRate(stream.r_frame_rate),
    medianFps,
    vfr,
  };
}

function pickFps(meta, override) {
  if (override) return override;
  const candidate = meta.vfr && meta.medianFps > 0 ? meta.medianFps : meta.avgFps || meta.medianFps || 30;
  return Math.min(60, Math.max(5, Math.round(candidate)));
}

function normalize(input, fps, workDir) {
  const out = path.join(workDir, "normalized.mp4");
  run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", input,
    "-vf", `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    "-an", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast",
    out,
  ]);
  const count = run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", out,
  ]).trim();
  return { file: out, frames: Number(count) };
}

// One decode pass: per-transition motion bbox + changed-pixel fraction.
// Output frame k of tblend is the difference between normalized frames
// k and k+1, so row k describes motion arriving AT frame k+1.
function motionPass(normalized, outDir) {
  const metaFile = path.join("work", "motion-meta.txt");
  workFiles.push(path.join(outDir, metaFile));
  const chain =
    `format=gray,tblend=all_mode=difference,` +
    `lut=y=if(gt(val\\,${DIFF_THRESHOLD})\\,255\\,0),` +
    `bbox=min_val=1,signalstats,metadata=mode=print:file=${metaFile}`;
  run("ffmpeg", ["-y", "-loglevel", "error", "-i", normalized, "-vf", chain, "-f", "null", "-"], outDir);

  const rows = [];
  let current = null;
  for (const line of readFileSync(path.join(outDir, metaFile), "utf8").split("\n")) {
    const frameHead = line.match(/^frame:(\d+)\s/);
    if (frameHead) {
      if (current) rows.push(current);
      current = { k: Number(frameHead[1]), bbox: null, changedFrac: 0 };
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^lavfi\.(\S+)=(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key.startsWith("bbox.")) {
      current.bbox ??= {};
      current.bbox[key.slice(5)] = Number(value);
    } else if (key === "signalstats.YAVG") {
      current.changedFrac = Number(value) / 255;
    }
  }
  if (current) rows.push(current);
  return rows;
}

function analyzeMotion(rows, meta, totalFrames, fps) {
  const pixels = meta.width * meta.height;
  const noiseFloor = Math.max(30, pixels * NOISE_FRACTION);
  const table = rows.map((r) => ({
    frame: r.k + 1, // motion arrives at this normalized frame
    ms: Math.round(((r.k + 1) * 1000) / fps),
    changedPx: Math.round(r.changedFrac * pixels),
    bbox: r.bbox && Number.isFinite(r.bbox.x1) ? r.bbox : null,
  }));

  const active = table.filter((r) => r.changedPx >= noiseFloor && r.bbox);
  if (active.length === 0) {
    return { table, active, start: 0, end: totalFrames - 1, union: null, trimmed: false };
  }
  const start = Math.max(0, active[0].frame - 1 - TRIM_PAD_FRAMES);
  const end = Math.min(totalFrames - 1, active.at(-1).frame + TRIM_PAD_FRAMES);

  const union = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const r of active) {
    union.x1 = Math.min(union.x1, r.bbox.x1);
    union.y1 = Math.min(union.y1, r.bbox.y1);
    union.x2 = Math.max(union.x2, r.bbox.x2);
    union.y2 = Math.max(union.y2, r.bbox.y2);
  }
  return { table, active, start, end, union, trimmed: start > 0 || end < totalFrames - 1 };
}

function computeCrop(union, pad, meta) {
  if (!union) return null;
  const even = (n) => Math.max(0, 2 * Math.floor(n / 2));
  let x = even(union.x1 - pad);
  let y = even(union.y1 - pad);
  let w = Math.min(meta.width - x, 2 * Math.ceil((union.x2 - union.x1 + 2 * pad) / 2));
  let h = Math.min(meta.height - y, 2 * Math.ceil((union.y2 - union.y1 + 2 * pad) / 2));
  if ((w * h) / (meta.width * meta.height) > CROP_MAX_COVERAGE) return null;
  let scale = 1;
  while (Math.min(w, h) * scale < UPSCALE_TARGET && scale < MAX_UPSCALE) scale++;
  return { x, y, w, h, scale };
}

// Pick which normalized frames appear on dense sheets.
// Short clips: every frame. Medium: uniform stride. Long: the frames
// with the most pixel change (motion peaks), in chronological order.
function pickDenseFrames(start, end, table, maxFrames) {
  const all = [];
  for (let f = start; f <= end; f++) all.push(f);
  if (all.length <= maxFrames) return { frames: all, strategy: "every frame" };

  if (all.length <= maxFrames * 3) {
    const stride = Math.ceil(all.length / maxFrames);
    const frames = all.filter((_, i) => i % stride === 0);
    if (frames.at(-1) !== end) frames.push(end);
    return { frames, strategy: `every ${stride}th frame` };
  }

  const byChange = table
    .filter((r) => r.frame >= start && r.frame <= end)
    .sort((a, b) => b.changedPx - a.changedPx)
    .slice(0, maxFrames - 2)
    .map((r) => r.frame);
  const frames = [...new Set([start, ...byChange, end])].sort((a, b) => a - b);
  return { frames, strategy: "motion peaks (highest changed-pixel frames)" };
}

function drawtextFilter(labelExpr, fontsize) {
  return (
    `drawtext=text='f%{eif\\:${labelExpr}\\:d} %{eif\\:t*1000\\:d}ms':` +
    `x=6:y=h-th-6:fontsize=${fontsize}:fontcolor=white:box=1:boxcolor=black@0.55`
  );
}

function selectExpr(relFrames) {
  return `select='${relFrames.map((n) => `eq(n\\,${n})`).join("+")}'`;
}

function renderGraph(outDir, normalized, graph, outputPattern) {
  const scriptFile = path.join(outDir, "work", `graph-${path.basename(outputPattern).replace(/%\d*d|\W/g, "")}.txt`);
  writeFileSync(scriptFile, `[0:v]${graph}[out]`);
  workFiles.push(scriptFile);
  const args = [
    "-y", "-loglevel", "error", "-i", normalized,
    "-filter_complex_script", scriptFile,
    "-map", "[out]", "-fps_mode", "passthrough", path.join(outDir, outputPattern),
  ];
  run("ffmpeg", args);
}

function renderSheets({ outDir, normalized, motion, crop, denseFrames, grid, fps, meta, totalFrames }) {
  const { start, end } = motion;
  const cellW = crop ? crop.w * crop.scale : meta.width;
  const fontsize = Math.min(36, Math.max(12, Math.round(cellW / 20)));
  const tile = `tile=${grid}x${grid}:padding=2:margin=2:color=0x101010`;
  const cropChain = crop
    ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` +
      (crop.scale > 1 ? `scale=iw*${crop.scale}:ih*${crop.scale}:flags=neighbor,` : "")
    : "";

  mkdirSync(path.join(outDir, "sheets"), { recursive: true });

  // Overview: the whole clip, uncropped, grid^2 frames sampled evenly.
  const overviewCount = Math.min(grid * grid, totalFrames);
  const overviewFrames = [...new Set(
    Array.from({ length: overviewCount }, (_, i) =>
      Math.round((i * (totalFrames - 1)) / Math.max(1, overviewCount - 1))),
  )];
  renderGraph(outDir, normalized,
    `${drawtextFilter("n", Math.max(12, Math.round(meta.width / 40)))},${selectExpr(overviewFrames)},${tile}`,
    "overview.png");

  if (denseFrames.length === 0) return;

  // Dense sheets: trimmed + cropped active window.
  const rel = denseFrames.map((f) => f - start);
  renderGraph(outDir, normalized,
    `trim=start_frame=${start}:end_frame=${end + 1},${cropChain}${drawtextFilter(`n+${start}`, fontsize)},${selectExpr(rel)},${tile}`,
    path.join("sheets", "sheet-%02d.png"));

  // Difference sheets: same window; diff frame k = change INTO frame start+k+1.
  const relDiff = denseFrames.filter((f) => f > start).map((f) => f - start - 1);
  if (relDiff.length > 0) {
    renderGraph(outDir, normalized,
      `trim=start_frame=${start}:end_frame=${end + 1},${cropChain}format=gray,tblend=all_mode=difference,` +
      `lut=y=min(val*4\\,255),${drawtextFilter(`n+${start}+1`, fontsize)},${selectExpr(relDiff)},${tile}`,
      path.join("sheets", "diff-%02d.png"));
  }
}

function writeCsv(outDir, table) {
  const lines = ["frame,ms,x,y,w,h,cx,cy,changed_px"];
  for (const r of table) {
    const b = r.bbox;
    lines.push([
      r.frame, r.ms,
      b ? b.x1 : "", b ? b.y1 : "", b ? b.w : "", b ? b.h : "",
      b ? Math.round((b.x1 + b.x2) / 2) : "", b ? Math.round((b.y1 + b.y2) / 2) : "",
      r.changedPx,
    ].join(","));
  }
  writeFileSync(path.join(outDir, "motion.csv"), lines.join("\n") + "\n");
}

function writeChart(outDir, table, motion) {
  const rows = table.filter((r) => r.frame >= motion.start && r.frame <= motion.end);
  const withBox = rows.filter((r) => r.bbox);
  if (withBox.length < 2) return false;

  const W = 720, H = 280, padL = 46, padR = 12, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const msMin = rows[0].ms, msMax = rows.at(-1).ms || 1;
  const px = (ms) => padL + ((ms - msMin) / Math.max(1, msMax - msMin)) * plotW;

  const series = [
    { name: "cx (px)", color: "#4da3ff", vals: withBox.map((r) => [r.ms, (r.bbox.x1 + r.bbox.x2) / 2]) },
    { name: "cy (px)", color: "#ff6b6b", vals: withBox.map((r) => [r.ms, (r.bbox.y1 + r.bbox.y2) / 2]) },
    { name: "changed px", color: "#9aa0a6", vals: rows.map((r) => [r.ms, r.changedPx]) },
  ];
  const polylines = series.map((s) => {
    const ys = s.vals.map((v) => v[1]);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const py = (v) => padT + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * plotH;
    const points = s.vals.map(([ms, v]) => `${px(ms).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    return { ...s, points, yMin, yMax };
  });

  const legend = polylines.map((s, i) =>
    `<text x="${padL + i * 170}" y="${H - 10}" fill="${s.color}" font-size="12">` +
    `${s.name}  [${Math.round(s.yMin)}…${Math.round(s.yMax)}]</text>`).join("\n  ");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#16181c"/>
  <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="#3c4043"/>
  <text x="${padL}" y="12" fill="#e8eaed" font-size="12">motion curves (each series normalized to its own min…max)</text>
  <text x="${padL}" y="${padT + plotH + 14}" fill="#9aa0a6" font-size="11">${msMin}ms</text>
  <text x="${W - padR}" y="${padT + plotH + 14}" fill="#9aa0a6" font-size="11" text-anchor="end">${msMax}ms</text>
  ${polylines.map((s) => `<polyline points="${s.points}" fill="none" stroke="${s.color}" stroke-width="1.5"/>`).join("\n  ")}
  ${legend}
</svg>
`;
  writeFileSync(path.join(outDir, "motion-curve.svg"), svg);
  return true;
}

function markdownTable(table, motion, maxRows = 36) {
  const rows = table.filter((r) => r.frame >= motion.start && r.frame <= motion.end);
  const stride = Math.max(1, Math.ceil(rows.length / maxRows));
  const sampled = rows.filter((_, i) => i % stride === 0);
  const lines = [
    "| frame | ms | bbox x,y | bbox w×h | center | changed px |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of sampled) {
    const b = r.bbox;
    lines.push(
      `| ${r.frame} | ${r.ms} | ${b ? `${b.x1},${b.y1}` : "—"} | ${b ? `${b.w}×${b.h}` : "—"} | ` +
      `${b ? `${Math.round((b.x1 + b.x2) / 2)},${Math.round((b.y1 + b.y2) / 2)}` : "—"} | ${r.changedPx} |`,
    );
  }
  if (stride > 1) lines.push("", `(every ${stride}th row shown — full data in motion.csv)`);
  return lines.join("\n");
}

function writeIndex(ctx) {
  const { outDir, opts, meta, fps, totalFrames, motion, crop, dense, hasChart, sheetsCount } = ctx;
  const ms = (f) => Math.round((f * 1000) / fps);
  const retinaHint = Math.min(meta.width, meta.height) >= 1400
    ? "resolution suggests a 2x (Retina) capture — divide px by 2 for pt/logical units"
    : "resolution suggests a 1x capture (heuristic — verify against known element sizes)";

  const noMotion = motion.active.length === 0;
  const md = `# scrub · ${path.basename(opts.input)}

Read this file top to bottom, then open the contact sheets it lists.
All frame numbers and milliseconds refer to the normalized clip
(\`work/normalized.mp4\`, constant ${fps} fps) — frame N = ${Math.round(1000 / fps)}·N ms.

## Metadata

- **Duration:** ${meta.duration.toFixed(3)}s (${totalFrames} frames at ${fps} fps normalized)
- **Source frame rate:** avg ${meta.avgFps.toFixed(2)} fps, container reports ${meta.reportedFps.toFixed(2)} fps${meta.vfr ? " — **variable frame rate detected**, normalized to a constant rate before analysis" : " (constant)"}
- **Resolution:** ${meta.width}×${meta.height} px — ${retinaHint}

## Motion summary

${noMotion ? "**No motion detected** above the noise floor. The clip appears static; only the overview sheet was generated." : `- **Active window:** frames ${motion.start}–${motion.end} (${ms(motion.start)}–${ms(motion.end)} ms)${motion.trimmed ? " — still head/tail trimmed automatically" : " — motion spans the whole clip"}
- **Motion crop:** ${crop ? `x=${crop.x} y=${crop.y} ${crop.w}×${crop.h}px${crop.scale > 1 ? `, upscaled ${crop.scale}x for legibility (divide sheet px by ${crop.scale})` : ""}` : "none (motion covers most of the frame or --no-crop)"}
- **Peak change:** frame ${motion.active.reduce((a, b) => (b.changedPx > a.changedPx ? b : a)).frame} (${motion.active.reduce((a, b) => (b.changedPx > a.changedPx ? b : a)).changedPx} px changed)
- **Dense sampling:** ${dense.strategy}, ${dense.frames.length} frames across ${sheetsCount} sheet(s)`}

## Files

- \`overview.png\` — ${Math.min(opts.grid * opts.grid, totalFrames)} frames sampled evenly across the whole clip, uncropped
- \`sheets/sheet-*.png\` — dense ${opts.grid}×${opts.grid} contact sheets of the active window (cropped to motion), each cell stamped \`f<frame> <ms>ms\`
- \`sheets/diff-*.png\` — consecutive-frame differences (brightened 4×); bright pixels = what moved INTO the stamped frame
- \`motion.csv\` — per-frame motion bounding box and changed-pixel count
${hasChart ? "- `motion-curve.svg` — plotted x/y center and changed-pixel curves\n" : ""}- \`work/normalized.mp4\` — the constant-rate clip all frame numbers refer to (use it for any further ffmpeg extraction)

## Per-frame motion table

Estimated from pixel differencing between consecutive frames — this is
**not** the real animation values. The bbox is the region that changed
between a frame and its predecessor (it spans both the old and new
position of a moving element). Sub-pixel motion, opacity fades, and
blurs register as changed pixels without a clean box.

${noMotion ? "(no rows above the noise floor)" : markdownTable(motion.table, motion)}

## How to read the results

1. Skim \`overview.png\` for the overall arc, then the dense sheets for
   the frames that matter.
2. Use the table/CSV to find where movement starts, peaks, overshoots,
   and settles; convert frames to ms via frame·${Math.round(1000 / fps)}.
3. Diff sheets show *what* moved; near-black diff cells are hold frames
   (potential jank if they sit mid-animation).
4. Report findings in frame/ms terms, e.g. "frames 12–18 overshoot by
   ~6px; reads as ease-out, spec says spring".
`;
  writeFileSync(path.join(outDir, "index.md"), md);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  checkTools();

  const outDir = path.resolve(opts.out ?? `${opts.input.replace(/\.[^./]+$/, "")}-scrub`);
  const workDir = path.join(outDir, "work");
  prepareOutDir(outDir, opts.input);

  console.log(`scrub · probing ${opts.input}`);
  const meta = probe(opts.input);
  const fps = pickFps(meta, opts.fps);
  if (meta.vfr) console.log(`  variable frame rate detected — normalizing to ${fps} fps`);

  const { file: normalized, frames: totalFrames } = normalize(opts.input, fps, workDir);
  if (totalFrames < 2) throw new UsageError("clip has fewer than 2 frames after normalization");

  console.log(`  analyzing ${totalFrames} frames at ${fps} fps`);
  const rows = motionPass(normalized, outDir);
  const motion = analyzeMotion(rows, meta, totalFrames, fps);
  const crop = opts.crop && motion.active.length > 0 ? computeCrop(motion.union, opts.pad, meta) : null;
  const dense = motion.active.length > 0
    ? pickDenseFrames(motion.start, motion.end, motion.table, opts.maxFrames)
    : { frames: [], strategy: "none (no motion)" };

  console.log(`  rendering contact sheets`);
  renderSheets({ outDir, normalized, motion, crop, denseFrames: dense.frames, grid: opts.grid, fps, meta, totalFrames });

  writeCsv(outDir, motion.table);
  const hasChart = writeChart(outDir, motion.table, motion);
  const sheetsCount = Math.ceil(dense.frames.length / (opts.grid * opts.grid));
  writeIndex({ outDir, opts, meta, fps, totalFrames, motion, crop, dense, hasChart, sheetsCount });

  if (!opts.keepWork) {
    for (const f of workFiles) rmSync(f, { force: true });
  }

  console.log(`  done → ${path.join(outDir, "index.md")}`);
}

try {
  main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`scrub: ${err.message}`);
    console.error("");
    console.error(usage());
    process.exit(EXIT_ERR);
  }
  console.error(`scrub: ${err?.message ?? err}`);
  process.exit(EXIT_ERR);
}
