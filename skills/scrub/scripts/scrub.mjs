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
import { pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_ERR = 2;

const STRONG_THRESHOLD = 24; // 0-255 luma delta that counts as "changed" (bbox, changed_px)
// A row with only faint change (fades) counts as motion when it lasts
// FAINT_RUN rows, changes FAINT_PX_FACTOR x --min-px pixels, and fills its
// bbox densely. Codec noise is short-lived, small, or scattered.
const FAINT_RUN = 3;
const FAINT_PX_FACTOR = 10;
const FAINT_MIN_DENSITY = 0.05;
const TRIM_PAD_FRAMES = 3;
const CROP_MAX_COVERAGE = 0.85; // skip cropping when motion covers most of the frame
const UPSCALE_TARGET = 320; // upscale crops until min dimension reaches this
const MAX_UPSCALE = 4;
const SHEET_MAX_PX = 4096; // sheets stay under image-reader limits (8000px) on both axes
const MAX_FPS = 120;
// Everything scrub writes; only these are removed when reusing an output dir.
const NORMALIZED = path.join("work", "normalized.mp4");
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
  --pad <px>          Padding around the motion crop (default 24, 0 allowed)
  --no-crop           Analyze the full frame, skip motion cropping
  --min-px <n>        Changed pixels a frame needs to count as motion (default 20)
  --threshold <n>     Luma delta for faint change such as fades (default 8, max 24)
  --keep-work         Keep intermediate files in work/
  -h, --help          Show this help`;
}

function parseArgs(argv) {
  const opts = {
    input: null, out: null, fps: null, grid: 4,
    maxFrames: 96, pad: 24, crop: true, keepWork: false, minPx: 20, threshold: 8,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${arg}`);
      return v;
    };
    const nextInt = (min = 1) => {
      const n = Math.round(Number(next()));
      if (!Number.isFinite(n) || n < min) throw new UsageError(`${arg} needs a whole number ≥ ${min}`);
      return n;
    };
    switch (arg) {
      case "--out": opts.out = next(); break;
      case "--fps": opts.fps = nextInt(); break;
      case "--grid": opts.grid = nextInt(); break;
      case "--max-frames": opts.maxFrames = nextInt(); break;
      case "--pad": opts.pad = nextInt(0); break;
      case "--min-px": opts.minPx = nextInt(); break;
      case "--threshold":
        opts.threshold = nextInt();
        if (opts.threshold > STRONG_THRESHOLD) throw new UsageError(`--threshold must be at most ${STRONG_THRESHOLD}`);
        break;
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

// Sheets fall back to unstamped cells when ffmpeg cannot draw text: no
// drawtext filter (built without freetype, e.g. Homebrew's slim ffmpeg)
// or no font it can find. SCRUB_NO_DRAWTEXT=1 forces the fallback.
function canDrawText(outDir) {
  if (process.env.SCRUB_NO_DRAWTEXT === "1") return false;
  const res = spawnSync("ffmpeg", [
    "-v", "error", "-i", NORMALIZED, "-vf", "drawtext=text=f0", "-frames:v", "1", "-f", "null", "-",
  ], { cwd: outDir, stdio: "ignore" });
  return res.status === 0;
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
  if (override) return { fps: override, capped: false };
  const candidate = Math.round(meta.vfr && meta.medianFps > 0 ? meta.medianFps : meta.avgFps || meta.medianFps || 30);
  return { fps: Math.min(MAX_FPS, Math.max(5, candidate)), capped: candidate > MAX_FPS };
}

function normalize(input, fps, outDir) {
  const out = path.join(outDir, NORMALIZED);
  run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", input,
    "-vf", `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    "-an", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast",
    NORMALIZED,
  ], outDir);
  // Dimensions come from the normalized clip: ffmpeg applies rotation
  // metadata and trims odd sizes, so the source's stream size can differ.
  const stream = JSON.parse(run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=nb_read_packets,width,height", "-of", "json", out,
  ])).streams[0];
  return { frames: Number(stream.nb_read_packets), width: stream.width, height: stream.height };
}

// One decode pass, two thresholds: per-transition motion bbox + changed-
// pixel fraction. Output frame k of tblend is the difference between
// normalized frames k and k+1, so row k describes motion arriving AT
// frame k+1.
function motionPass(outDir, threshold) {
  const strongFile = path.join("work", "motion-strong.txt");
  const faintFile = path.join("work", "motion-faint.txt");
  workFiles.push(path.join(outDir, strongFile), path.join(outDir, faintFile));
  const branch = (label, t, file) =>
    `[${label}]lut=y=if(gt(val\\,${t})\\,255\\,0),bbox=min_val=1,signalstats,metadata=mode=print:file=${file}[${label}o]`;
  const graph = `[0:v]format=gray,tblend=all_mode=difference,split[s][f];` +
    `${branch("s", STRONG_THRESHOLD, strongFile)};${branch("f", threshold, faintFile)}`;
  run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", NORMALIZED, "-filter_complex", graph,
    "-map", "[so]", "-f", "null", "-", "-map", "[fo]", "-f", "null", "-",
  ], outDir);
  const faint = new Map(parseMetadata(path.join(outDir, faintFile)).map((r) => [r.k, r]));
  return parseMetadata(path.join(outDir, strongFile)).map((r) => ({ ...r, faint: faint.get(r.k) }));
}

function parseMetadata(file) {
  const rows = [];
  let current = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
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

function analyzeMotion(rows, meta, totalFrames, fps, minPx) {
  const pixels = meta.width * meta.height;
  const box = (b) => (b && Number.isFinite(b.x1) ? b : null);
  const table = rows.map((r) => ({
    frame: r.k + 1, // motion arrives at this normalized frame
    ms: Math.round(((r.k + 1) * 1000) / fps),
    changedPx: Math.round(r.changedFrac * pixels),
    faintPx: Math.round((r.faint?.changedFrac ?? 0) * pixels),
    bbox: box(r.bbox),
    faintBbox: box(r.faint?.bbox),
    active: false,
  }));

  // Strong rows count on their own; faint-only rows need a run.
  const isFaint = (r) => r.faintBbox && r.faintPx >= FAINT_PX_FACTOR * minPx &&
    r.faintPx >= FAINT_MIN_DENSITY * r.faintBbox.w * r.faintBbox.h;
  const isStrong = (r) => r.bbox && r.changedPx >= minPx;
  for (let i = 0; i < table.length;) {
    let j = i;
    while (j < table.length && isFaint(table[j])) j++;
    if (j - i >= FAINT_RUN) {
      for (const r of table.slice(i, j)) if (!isStrong(r)) Object.assign(r, { active: true, bbox: r.faintBbox });
    }
    i = Math.max(j, i + 1);
  }
  for (const r of table) if (isStrong(r)) r.active = true;
  const active = table.filter((r) => r.active);
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

function computeCrop(union, pad, meta, grid) {
  if (!union) return null;
  const even = (n) => Math.max(0, 2 * Math.floor(n / 2));
  const x = even(union.x1 - pad);
  const y = even(union.y1 - pad);
  // bbox x2/y2 are inclusive.
  const w = Math.min(meta.width - x, 2 * Math.ceil((union.x2 + 1 + pad - x) / 2));
  const h = Math.min(meta.height - y, 2 * Math.ceil((union.y2 + 1 + pad - y) / 2));
  if ((w * h) / (meta.width * meta.height) > CROP_MAX_COVERAGE) return null;
  return { x, y, w, h, scale: cellScale(w, h, grid, true) };
}

// Scale for one sheet cell: small crops upscale (nearest neighbor) toward
// UPSCALE_TARGET, and every grid×grid sheet stays within SHEET_MAX_PX.
function cellScale(w, h, grid, upscale) {
  const maxCell = Math.floor((SHEET_MAX_PX - 4 - 2 * (grid - 1)) / grid);
  const big = Math.max(w, h);
  if (big > maxCell) return maxCell / big;
  let scale = 1;
  while (upscale && Math.min(w, h) * scale < UPSCALE_TARGET && scale < MAX_UPSCALE && big * (scale + 1) <= maxCell) scale++;
  return scale;
}

// Filter prefix and output cell size for a w×h region shown at scale.
function scaleCell(w, h, scale) {
  if (scale === 1) return { chain: "", cellW: w };
  if (scale > 1) return { chain: `scale=iw*${scale}:ih*${scale}:flags=neighbor,`, cellW: w * scale };
  const cw = 2 * Math.floor((w * scale) / 2), ch = 2 * Math.floor((h * scale) / 2);
  return { chain: `scale=${cw}:${ch}:flags=area,`, cellW: cw };
}

// Pick which normalized frames appear on dense sheets: every frame when
// they fit, otherwise maxFrames evenly spaced frames spanning the window.
function pickDenseFrames(start, end, maxFrames) {
  const count = end - start + 1;
  if (count <= maxFrames) {
    return { frames: Array.from({ length: count }, (_, i) => start + i), strategy: "every frame" };
  }
  const step = (count - 1) / Math.max(1, maxFrames - 1);
  const frames = [...new Set(Array.from({ length: maxFrames }, (_, i) => start + Math.round(i * step)))];
  return { frames, strategy: `evenly spaced, about every ${step.toFixed(1)} frames` };
}

export function stampFontsize(cellW) {
  return Math.min(36, Math.max(12, Math.round(cellW / 20)));
}

// Stamps "f<frame> <ms>ms" from the frame index; ms rounds like motion.csv.
export function stampFilter(frameExpr, fontsize, fps) {
  return (
    `drawtext=text='f%{eif\\:${frameExpr}\\:d} %{eif\\:round((${frameExpr})*1000/${fps})\\:d}ms':` +
    `x=6:y=h-th-6:fontsize=${fontsize}:fontcolor=white:box=1:boxcolor=black`
  );
}

function selectExpr(relFrames) {
  return `select='${relFrames.map((n) => `eq(n\\,${n})`).join("+")}'`;
}

// Runs inside outDir with relative paths, so a '%' in the user's path is
// never read as an image2 pattern. setpts + -r 1 emits each tile exactly
// once on every ffmpeg from 4.4 to 9 (no -fps_mode / -vsync needed).
function renderGraph(outDir, graph, output) {
  run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", NORMALIZED,
    "-filter_complex", `[0:v]${graph},setpts=N/TB[out]`,
    "-map", "[out]", "-r", "1", output,
  ], outDir);
}

function renderSheets({ outDir, motion, crop, denseFrames, grid, meta, totalFrames, stamps, fps }) {
  const { start, end } = motion;
  const stamp = (frameExpr, cellW) => (stamps ? stampFilter(frameExpr, stampFontsize(cellW), fps) : "null");
  const tile = `tile=${grid}x${grid}:padding=2:margin=2:color=0x101010`;
  const full = scaleCell(meta.width, meta.height, cellScale(meta.width, meta.height, grid, false));
  const cell = crop ? scaleCell(crop.w, crop.h, crop.scale) : full;
  const cellW = cell.cellW;
  const cropChain = (crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "") + cell.chain;

  mkdirSync(path.join(outDir, "sheets"), { recursive: true });

  // Overview: the whole clip, uncropped, grid^2 frames sampled evenly.
  const overviewCount = Math.min(grid * grid, totalFrames);
  const overviewFrames = [...new Set(
    Array.from({ length: overviewCount }, (_, i) =>
      Math.round((i * (totalFrames - 1)) / Math.max(1, overviewCount - 1))),
  )];
  renderGraph(outDir,
    `${full.chain}${stamp("n", full.cellW)},${selectExpr(overviewFrames)},${tile}`,
    "overview.png");

  const sheets = { overview: overviewFrames, dense: denseFrames };
  if (denseFrames.length === 0) return sheets;

  // Dense sheets: trimmed + cropped active window.
  const rel = denseFrames.map((f) => f - start);
  renderGraph(outDir,
    `trim=start_frame=${start}:end_frame=${end + 1},${cropChain}${stamp(`n+${start}`, cellW)},${selectExpr(rel)},${tile}`,
    path.join("sheets", "sheet-%02d.png"));

  // Difference sheets, cell for cell with the dense sheets: diff frame k is
  // the change INTO frame start+k. Trimming from start-1 supplies the
  // predecessor; at frame 0 a cloned frame 0 yields a black cell.
  const head = start > 0 ? `trim=start_frame=${start - 1}:end_frame=${end + 1},` :
    `trim=start_frame=0:end_frame=${end + 1},tpad=start=1:start_mode=clone,`;
  renderGraph(outDir,
    `${head}${cropChain}format=gray,tblend=all_mode=difference,` +
    `lut=y=min(val*4\\,255),${stamp(`n+${start}`, cellW)},${selectExpr(rel)},${tile}`,
    path.join("sheets", "diff-%02d.png"));
  return sheets;
}

// Without stamps, index.md carries each sheet's frames in cell order.
function sheetFrameList(sheets, grid, ms) {
  const cells = grid * grid;
  const lines = [];
  const add = (name, frames) => {
    for (let i = 0; i * cells < frames.length; i++) {
      const label = name.replaceAll("%", String(i + 1).padStart(2, "0"));
      lines.push(`- \`${label}\`: ${frames.slice(i * cells, (i + 1) * cells).map((f) => `f${f} ${ms(f)}ms`).join(", ")}`);
    }
  };
  add("overview.png", sheets.overview);
  add("sheets/sheet-%.png (and diff-%.png)", sheets.dense);
  return lines.join("\n");
}

function writeCsv(outDir, table) {
  const lines = ["frame,ms,x,y,w,h,cx,cy,changed_px,faint_px"];
  for (const r of table) {
    const b = r.bbox;
    lines.push([
      r.frame, r.ms,
      b ? b.x1 : "", b ? b.y1 : "", b ? b.w : "", b ? b.h : "",
      b ? Math.round((b.x1 + b.x2) / 2) : "", b ? Math.round((b.y1 + b.y2) / 2) : "",
      r.changedPx, r.faintPx,
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
    "| frame | ms | bbox x,y | bbox w×h | center | changed px | faint px |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of sampled) {
    const b = r.bbox;
    lines.push(
      `| ${r.frame} | ${r.ms} | ${b ? `${b.x1},${b.y1}` : "—"} | ${b ? `${b.w}×${b.h}` : "—"} | ` +
      `${b ? `${Math.round((b.x1 + b.x2) / 2)},${Math.round((b.y1 + b.y2) / 2)}` : "—"} | ${r.changedPx} | ${r.faintPx} |`,
    );
  }
  if (stride > 1) lines.push("", `(every ${stride}th row shown — full data in motion.csv)`);
  return lines.join("\n");
}

function peakChange(active) {
  const peak = active.reduce((a, b) => (b.faintPx > a.faintPx ? b : a));
  return `frame ${peak.frame} (${peak.changedPx} px changed, ${peak.faintPx} incl. faint)`;
}

function writeIndex(ctx) {
  const { outDir, opts, meta, fps, fpsCapped, totalFrames, motion, crop, dense, hasChart, sheetsCount, sheets, stamps } = ctx;
  const ms = (f) => Math.round((f * 1000) / fps);
  const retinaHint = Math.min(meta.width, meta.height) >= 1400
    ? "large enough to be a 2x (Retina) capture, or a 1x large monitor; confirm against a known element size before halving px to pt"
    : "could be a 1x capture or a 2x region capture; confirm against a known element size before converting px to pt";
  const fmtScale = (x) => (Number.isInteger(x) ? `${x}` : x.toFixed(2));

  const noMotion = motion.active.length === 0;
  const md = `# scrub · ${path.basename(opts.input)}

Read this file top to bottom, then open the contact sheets it lists.
All frame numbers and milliseconds refer to the normalized clip
(\`work/normalized.mp4\`, constant ${fps} fps): frame N = N·1000/${fps} ms, rounded.

## Metadata

- **Duration:** ${meta.duration.toFixed(3)}s (${totalFrames} frames at ${fps} fps normalized)
- **Source frame rate:** median frame interval ${meta.medianFps.toFixed(2)} fps, avg ${meta.avgFps.toFixed(2)} fps, container reports ${meta.reportedFps.toFixed(2)} fps${meta.vfr ? " — **variable frame rate detected**, normalized to a constant rate before analysis" : " (constant)"}${fpsCapped ? ` — **faster than ${MAX_FPS} fps**, so normalizing dropped frames (pass --fps to keep them)` : ""}
- **Resolution:** ${meta.width}×${meta.height} px — ${retinaHint}

## Motion summary

${noMotion ? "**No motion detected** above the noise floor. The clip appears static; only the overview sheet was generated." : `- **Active window:** frames ${motion.start}–${motion.end} (${ms(motion.start)}–${ms(motion.end)} ms)${motion.trimmed ? " — still head/tail trimmed automatically" : " — motion spans the whole clip"}
- **Motion crop:** ${crop ? `x=${crop.x} y=${crop.y} ${crop.w}×${crop.h}px${crop.scale !== 1 ? `, shown at ${fmtScale(crop.scale)}x on sheets (divide sheet px by ${fmtScale(crop.scale)})` : ""}` : "none (motion covers most of the frame or --no-crop)"}
- **Peak change:** ${peakChange(motion.active)}
- **Dense sampling:** ${dense.strategy}, ${dense.frames.length} frames across ${sheetsCount} sheet(s)`}

## Files

- \`overview.png\` — ${Math.min(opts.grid * opts.grid, totalFrames)} frames sampled evenly across the whole clip, uncropped
${noMotion ? "" : `- \`sheets/sheet-*.png\` — dense ${opts.grid}×${opts.grid} contact sheets of the active window${crop ? " (cropped to motion)" : ""}${stamps ? ", each cell stamped \`f<frame> <ms>ms\`" : ""}
- \`sheets/diff-*.png\` — consecutive-frame differences (brightened 4×), cell for cell with the sheets; bright pixels = what moved INTO that frame
`}- \`motion.csv\` — per-frame motion bounding box and changed-pixel count
${hasChart ? "- `motion-curve.svg` — plotted x/y center and changed-pixel curves\n" : ""}- \`work/normalized.mp4\` — the constant-rate clip all frame numbers refer to (use it for any further ffmpeg extraction)
${stamps ? "" : `\n**Cells are unstamped** (this ffmpeg cannot draw text). Frames per sheet, row by row:\n\n${sheetFrameList(sheets, opts.grid, ms)}\n`}
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
   and settles; convert frames to ms via frame·1000/${fps}.
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
  prepareOutDir(outDir, opts.input);
  // Absolute, so ffmpeg never reads "name:" as a protocol prefix.
  const input = path.resolve(opts.input);
  console.log(`scrub · probing ${opts.input}`);
  const meta = probe(input);
  const { fps, capped: fpsCapped } = pickFps(meta, opts.fps);
  if (meta.vfr) console.log(`  variable frame rate detected — normalizing to ${fps} fps`);

  const { frames: totalFrames, width, height } = normalize(input, fps, outDir);
  if (totalFrames < 2) throw new Error("clip has fewer than 2 frames after normalization; nothing to compare");
  Object.assign(meta, { width, height });
  const stamps = canDrawText(outDir);
  if (!stamps) {
    console.error("scrub: warning: this ffmpeg cannot draw text (no drawtext filter or no usable font), " +
      "so sheet cells are unstamped; index.md lists each sheet's frames. For stamps, install an ffmpeg " +
      "with freetype and fontconfig, e.g. `brew install ffmpeg-full`.");
  }

  console.log(`  analyzing ${totalFrames} frames at ${fps} fps`);
  const rows = motionPass(outDir, opts.threshold);
  const motion = analyzeMotion(rows, meta, totalFrames, fps, opts.minPx);
  const crop = opts.crop && motion.active.length > 0 ? computeCrop(motion.union, opts.pad, meta, opts.grid) : null;
  const dense = motion.active.length > 0
    ? pickDenseFrames(motion.start, motion.end, opts.maxFrames)
    : { frames: [], strategy: "none (no motion)" };

  console.log(`  rendering contact sheets`);
  const sheets = renderSheets({ outDir, motion, crop, denseFrames: dense.frames, grid: opts.grid, meta, totalFrames, stamps, fps });

  writeCsv(outDir, motion.table);
  const hasChart = writeChart(outDir, motion.table, motion);
  const sheetsCount = Math.ceil(dense.frames.length / (opts.grid * opts.grid));
  writeIndex({ outDir, opts, meta, fps, fpsCapped, totalFrames, motion, crop, dense, hasChart, sheetsCount, sheets, stamps });

  if (!opts.keepWork) {
    for (const f of workFiles) rmSync(f, { force: true });
  }

  console.log(`  done → ${path.join(outDir, "index.md")}`);
}

// Run only as a CLI; tests import the stamp helpers.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
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
}
