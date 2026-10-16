/**
 * Contact-sheet composition: lay out state × viewport × theme captures
 * on one evenly spaced grid, render it with Chrome at @2x, and verify
 * the output pixel-by-pixel against the computed geometry.
 *
 * All geometry is computed here in integer CSS pixels and rendered with
 * absolutely positioned elements, so the verification step knows exactly
 * where every border and gutter must land.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { decodePng, getPixel, colorDistance } from "./png.mjs";

const require = createRequire(import.meta.url);

export const SHEET = {
  bg: "#f4f5f7",
  border: "#d8dbe1",
  text: "#111827",
  muted: "#6b7280",
  pad: 28,
  gap: 14,
  groupGap: 36,
  titleH: 56,
  headerH: 46,
  dpr: 2,
};

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Pure grid geometry.
 * states: string[]; columns: [{ viewport, theme }];
 * sizes: Map "state|colIndex" -> { cssW, cssH } (CSS px of the capture clip);
 * scale: display scale applied to captures.
 */
export function computeLayout({ states, columns, sizes, scale }) {
  const { pad, gap, groupGap, titleH, headerH } = SHEET;

  const maxName = Math.max(...states.map((s) => s.length), 6);
  const labelW = Math.max(96, Math.min(220, 24 + Math.ceil(7.4 * maxName)));

  const colW = columns.map((c) => Math.round(c.viewport * scale));
  const colX = [];
  let x = pad + labelW + gap;
  for (let j = 0; j < columns.length; j++) {
    if (j > 0) x += colW[j - 1] + (columns[j].theme !== columns[j - 1].theme ? groupGap : gap);
    colX.push(x);
  }
  const width = colX[columns.length - 1] + colW[columns.length - 1] + pad;

  const rowH = states.map((state, i) =>
    Math.max(
      ...columns.map((_, j) => {
        const size = sizes.get(`${state}|${j}`);
        if (!size) throw new Error(`missing capture for ${state} column ${j}`);
        return Math.round(size.cssH * scale);
      }),
    ),
  );
  const rowsY = pad + titleH + headerH;
  const rowY = [];
  let y = rowsY;
  for (let i = 0; i < states.length; i++) {
    rowY.push(y);
    y += rowH[i] + gap;
  }
  const height = y - gap + pad;

  const cells = [];
  for (let i = 0; i < states.length; i++) {
    for (let j = 0; j < columns.length; j++) {
      const size = sizes.get(`${states[i]}|${j}`);
      cells.push({
        state: states[i],
        row: i,
        col: j,
        x: colX[j],
        y: rowY[i],
        w: colW[j],
        h: Math.round(size.cssH * scale),
        boxH: rowH[i],
      });
    }
  }

  // Theme group spans for the header banners.
  const groups = [];
  for (let j = 0; j < columns.length; j++) {
    const last = groups[groups.length - 1];
    if (last && last.theme === columns[j].theme) {
      last.w = colX[j] + colW[j] - last.x;
    } else {
      groups.push({ theme: columns[j].theme, x: colX[j], w: colW[j] });
    }
  }

  return { width, height, labelW, colX, colW, rowY, rowH, cells, groups, headerY: pad + titleH, rowsY };
}

function fontFaces() {
  const dir = path.dirname(require.resolve("@fontsource/inter/package.json"));
  return [400, 500, 600]
    .map((weight) => {
      const file = path.join(dir, "files", `inter-latin-${weight}-normal.woff2`);
      const data = fs.readFileSync(file).toString("base64");
      return `@font-face { font-family: InterSheet; font-weight: ${weight}; font-style: normal; src: url(data:font/woff2;base64,${data}) format("woff2"); }`;
    })
    .join("\n");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sheetHtml({ title, subtitle, states, columns, cellImages, cellBg, layout }) {
  const { pad } = SHEET;
  const el = [];

  el.push(`<div class="title" style="left:${pad}px;top:${pad}px">
    <div class="name">${esc(title)}</div>
    <div class="sub">${esc(subtitle)}</div>
  </div>`);

  for (const g of layout.groups) {
    el.push(`<div class="group" style="left:${g.x}px;top:${layout.headerY}px;width:${g.w}px">${esc(g.theme)}</div>`);
  }
  columns.forEach((c, j) => {
    el.push(`<div class="colhead" style="left:${layout.colX[j]}px;top:${layout.headerY + 22}px;width:${layout.colW[j]}px">${c.viewport}px</div>`);
  });

  states.forEach((state, i) => {
    el.push(`<div class="rowlabel" style="left:${pad}px;top:${layout.rowY[i] + 1}px;width:${layout.labelW}px">${esc(state)}</div>`);
  });

  for (const cell of layout.cells) {
    const key = `${cell.state}|${cell.col}`;
    const bg = cellBg.get(key) || "#ffffff";
    el.push(`<div class="cellbox" style="left:${cell.x - 1}px;top:${cell.y - 1}px;width:${cell.w + 2}px;height:${cell.boxH + 2}px;background:${esc(bg)}"></div>`);
    el.push(`<img src="data:image/png;base64,${cellImages.get(key)}" style="left:${cell.x}px;top:${cell.y}px;width:${cell.w}px;height:${cell.h}px">`);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${fontFaces()}
html, body { margin: 0; }
body { width: ${layout.width}px; height: ${layout.height}px; background: ${SHEET.bg};
  font-family: InterSheet, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
body > * { position: absolute; }
.title .name { font-size: 19px; font-weight: 600; color: ${SHEET.text}; letter-spacing: -0.01em; }
.title .sub { font-size: 12px; font-weight: 400; color: ${SHEET.muted}; margin-top: 5px; }
.group { font-size: 11px; font-weight: 600; color: ${SHEET.muted}; text-transform: uppercase;
  letter-spacing: 0.14em; text-align: center; }
.colhead { font-size: 12px; font-weight: 500; color: ${SHEET.muted}; text-align: center; }
.rowlabel { font-size: 13px; font-weight: 600; color: ${SHEET.text};
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cellbox { border: 1px solid ${SHEET.border}; box-sizing: border-box; }
img { display: block; }
</style></head><body>${el.join("\n")}</body></html>`;
}

/** Render the sheet HTML with Chrome at @2x. Returns the PNG buffer. */
export async function renderSheet(browser, html, layout) {
  const context = await browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    deviceScaleFactor: SHEET.dpr,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    return await page.screenshot({ type: "png" });
  } finally {
    await context.close();
  }
}

/**
 * Verify the rendered sheet against the computed geometry.
 * Returns [{ name, ok, detail }].
 */
export function verifySheet(buffer, layout) {
  const img = decodePng(buffer);
  const d = SHEET.dpr;
  const results = [];
  const bg = hexToRgb(SHEET.bg);
  const border = hexToRgb(SHEET.border);
  const at = (x, y) => getPixel(img, Math.round(x * d), Math.round(y * d));

  const wantW = layout.width * d;
  const wantH = layout.height * d;
  results.push({
    name: `sheet size ${img.width}×${img.height} px`,
    ok: img.width === wantW && img.height === wantH,
    detail: `expected ${wantW}×${wantH}`,
  });

  results.push({
    name: "sheet background",
    ok: colorDistance(at(8, 8), bg) <= 2,
    detail: `corner pixel ${at(8, 8).slice(0, 3).join(",")} vs ${bg.join(",")}`,
  });

  let badBorders = 0;
  for (const cell of layout.cells) {
    const corners = [
      [cell.x - 1, cell.y - 1],
      [cell.x + cell.w, cell.y - 1],
      [cell.x - 1, cell.y + cell.boxH],
    ];
    for (const [cx, cy] of corners) {
      if (colorDistance(at(cx, cy), border) > 12) badBorders++;
    }
  }
  results.push({
    name: `cell borders (${layout.cells.length} cells)`,
    ok: badBorders === 0,
    detail: badBorders > 0 ? `${badBorders} corner samples off` : "all corner samples match",
  });

  // Gutters between the label column and the grid, and between rows.
  const gutterSamples = [];
  const firstRowMid = layout.rowY[0] + Math.floor(layout.rowH[0] / 2);
  gutterSamples.push([layout.colX[0] - Math.ceil(SHEET.gap / 2), firstRowMid]);
  if (layout.rowY.length > 1) {
    const colMid = layout.colX[0] + Math.floor(layout.colW[0] / 2);
    gutterSamples.push([colMid, layout.rowY[1] - Math.ceil(SHEET.gap / 2)]);
  }
  const badGutters = gutterSamples.filter(([x, y]) => colorDistance(at(x, y), bg) > 2).length;
  results.push({
    name: "gutters are sheet background",
    ok: badGutters === 0,
    detail: badGutters > 0 ? `${badGutters} gutter samples off` : `${gutterSamples.length} samples match`,
  });

  return results;
}
