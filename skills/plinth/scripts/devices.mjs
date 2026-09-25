/**
 * Device specs and generated frame/chrome markup.
 *
 * Every number is in device points (pt) and cited. Sources:
 * [UYL16]  useyourloaf.com/blog/iphone-16-screen-sizes — points, native px,
 *          scale, status-bar height, safe-area insets per device.
 * [1440]   1440px.com/safe-area — safe-area table across models, matches UYL.
 * [SO-HI]  stackoverflow.com/q/53109069 — home indicator measured from
 *          pixel-accurate renders: 134×5pt (non-Max), 8pt above the edge.
 * [DCR]    UIScreen _displayCornerRadius values as collated in public
 *          device-metric references: 55pt for 393×852 iPhones (15/15 Pro/16),
 *          62pt for the 402×874 iPhone 16 Pro.
 * [ISL]    Dynamic Island: public iOS UI kits and simulator-shell
 *          implementations disagree by ~1pt — 124×36 @ y=11 (dimina-kit
 *          simulator) vs 126×37.33 @ y≈11.33 (design kits). We use 125×37
 *          @ y=11 and note the ±1pt tolerance.
 * [BJANGO] bjango.com/articles/designingmenubarextras — MacBook Pro 14/16"
 *          menu bar is 37pt tall at default scaling (wraps the camera
 *          housing); logical menu content stays 24pt.
 * [CREST]  crestnotch.app/macbook-notch-dimensions — measured on the 16"
 *          and derived for its default mode as ≈185×32pt; the 14" is listed
 *          unverified. The 14" shares the 254ppi panel and 2x default
 *          scale, so we reuse 185pt and draw it flush with the 37pt bar.
 * APPROX   marks values with no authoritative public source (Android chrome
 *          metrics, Safari's dynamic compact bar, iPad home-indicator bar
 *          width, browser chrome). They are drawn from screenshots of real
 *          devices/apps and labeled as approximations in the README.
 */

export const DEVICES = {
  "iphone-16-pro": {
    label: "iPhone 16 Pro (402×874pt @3x, island)",   // [UYL16]
    kind: "phone",
    os: "ios",
    pt: { width: 402, height: 874 },
    dpr: 3,
    screenRadius: 62,                                  // [DCR]
    safeTop: 62,                                       // [UYL16][1440]
    safeBottom: 34,                                    // [UYL16][1440]
    statusBar: 54,                                     // [UYL16]
    island: { width: 125, height: 37, y: 11 },         // [ISL] ±1pt
    homeIndicator: { width: 134, height: 5, bottomGap: 8 }, // [SO-HI]
    bezel: 9,
  },
  "iphone-16": {
    label: "iPhone 16 (393×852pt @3x, island)",        // [UYL16]
    kind: "phone",
    os: "ios",
    pt: { width: 393, height: 852 },
    dpr: 3,
    screenRadius: 55,                                  // [DCR]
    safeTop: 59,                                       // [UYL16][1440]
    safeBottom: 34,
    statusBar: 54,                                     // [UYL16]
    island: { width: 125, height: 37, y: 11 },         // [ISL]
    homeIndicator: { width: 134, height: 5, bottomGap: 8 },
    bezel: 10,
  },
  "iphone-15-pro": {
    label: "iPhone 15 Pro (393×852pt @3x, island)",    // [UYL16][1440]
    kind: "phone",
    os: "ios",
    pt: { width: 393, height: 852 },
    dpr: 3,
    screenRadius: 55,                                  // [DCR]
    safeTop: 59,
    safeBottom: 34,
    statusBar: 54,
    island: { width: 125, height: 37, y: 11 },
    homeIndicator: { width: 134, height: 5, bottomGap: 8 },
    bezel: 9,
  },
  "pixel-8": {
    label: "Pixel 8 (412×915dp @2.625x) — chrome metrics APPROX",
    kind: "phone",
    os: "android",
    pt: { width: 412, height: 915 },
    dpr: 2.625,
    screenRadius: 32,                                  // APPROX
    safeTop: 28,                                       // APPROX (status bar)
    safeBottom: 24,                                    // APPROX (gesture area)
    statusBar: 28,                                     // APPROX
    punchHole: { d: 12, cy: 14 },                      // APPROX
    homeIndicator: { width: 108, height: 4, bottomGap: 10 }, // APPROX
    bezel: 11,
  },
  "ipad-pro-11": {
    // 1st–4th gen geometry; the 2024 M4 model is 834×1210pt, but its
    // safe areas and corner radius have no source as solid as [1440]/[DCR].
    label: 'iPad Pro 11" 2018–2022 (834×1194pt @2x)',   // [1440]
    kind: "tablet",
    os: "ios",
    pt: { width: 834, height: 1194 },
    dpr: 2,
    screenRadius: 18,                                  // [DCR] iPad family
    safeTop: 24,                                       // [1440]
    safeBottom: 20,                                    // [1440]
    statusBar: 24,
    island: null,
    homeIndicator: { width: 208, height: 5.5, bottomGap: 7 }, // APPROX width
    bezel: 26,
  },
  "macbook-14": {
    label: 'MacBook Pro 14" class (1512×982pt @2x)',
    kind: "laptop",
    os: "macos",
    pt: { width: 1512, height: 982 },
    dpr: 2,
    screenRadius: 12,
    menuBar: 37,                                       // [BJANGO]
    notch: { width: 185, height: 37 },                 // [CREST] + flush bar
    bezel: 16,
    deck: { height: 30, lipWidth: 180, overhang: 70 },
  },
  browser: {
    label: "Desktop browser window (1280×800 @2x) — chrome APPROX",
    kind: "browser",
    os: "none",
    pt: { width: 1280, height: 800 },
    dpr: 2,
    screenRadius: 0,
    tabStrip: 38,                                      // APPROX (Chromium)
    toolbar: 44,                                       // APPROX (Chromium)
    outerRadius: 12,
    bezel: 0,
  },
};

// Safari iOS 18 compact bottom bar has no fixed published height (it is a
// dynamic element). Drawn as a 50pt pill zone above the 34pt bottom safe
// area. APPROX by design; documented in the README.
const SAFARI_BOTTOM_PILL = 50;

export function deviceList() {
  return Object.entries(DEVICES)
    .map(([id, d]) => `  ${id.padEnd(14)} ${d.label}`)
    .join("\n");
}

/** Outer frame size in pt (without padding/background). */
export function frameSize(device) {
  const { width, height } = device.pt;
  switch (device.kind) {
    case "phone":
    case "tablet":
      return { width: width + 2 * device.bezel, height: height + 2 * device.bezel };
    case "laptop":
      return {
        width: width + 2 * device.bezel + 2 * device.deck.overhang,
        height: height + 2 * device.bezel + device.deck.height,
      };
    case "browser":
      return { width: width + 2, height: height + device.tabStrip + device.toolbar + 2 };
  }
}

/** Screen origin (full panel, pt) relative to the frame. */
export function screenRect(device) {
  switch (device.kind) {
    case "phone":
    case "tablet":
      return { x: device.bezel, y: device.bezel, ...device.pt };
    case "laptop":
      return { x: device.bezel + device.deck.overhang, y: device.bezel, ...device.pt };
    case "browser":
      return { x: 1, y: device.tabStrip + device.toolbar + 1, ...device.pt };
  }
}

/**
 * Where captured page pixels land inside the screen (pt, screen-relative),
 * and the viewport the page must be captured at. Mode:
 *  - "standalone": app-style — page occupies the safe area only.
 *  - "safari":     mobile Safari — status bar + compact bottom bar.
 *  - "bare":       full-bleed (previous behavior; content under everything).
 */
export function contentRect(device, mode) {
  const { width, height } = device.pt;
  switch (device.kind) {
    case "phone": {
      if (mode === "bare") return { x: 0, y: 0, width, height };
      if (mode === "safari" && device.os === "ios") {
        const top = device.statusBar;
        const bottom = SAFARI_BOTTOM_PILL + device.safeBottom;
        return { x: 0, y: top, width, height: height - top - bottom };
      }
      // standalone (default) — also the android shape
      return { x: 0, y: device.safeTop, width, height: height - device.safeTop - device.safeBottom };
    }
    case "tablet": {
      if (mode === "bare") return { x: 0, y: 0, width, height };
      return { x: 0, y: device.safeTop, width, height: height - device.safeTop - device.safeBottom };
    }
    case "laptop":
      return { x: 0, y: device.menuBar, width, height: height - device.menuBar };
    case "browser":
      return { x: 0, y: 0, width, height };
  }
}

/**
 * Continuous-curvature ("squircle") rounded-rect path approximating Apple's
 * display corners with a sampled superellipse (exponent 4.5, 16 samples per
 * corner). CSS border-radius is circular and reads wrong at large radii; a
 * sampled superellipse is visually indistinguishable from the private
 * continuous-corner curve at these sizes.
 */
function squirclePath(w, h, r, dx = 0, dy = 0, samples = 16) {
  if (r <= 0) {
    return `M${dx},${dy} L${dx + w},${dy} L${dx + w},${dy + h} L${dx},${dy + h} Z`;
  }
  const n = 4.5;
  const f = (t) => Math.abs(Math.cos(t)) ** (2 / n);
  const g = (t) => Math.abs(Math.sin(t)) ** (2 / n);
  const pts = [];
  // Each corner: superellipse quadrant traced clockwise (screen coords).
  // reverse=true iterates t 90°→0°, else 0°→90°.
  const corner = (cx, cy, sx, sy, reverse) => {
    for (let i = 0; i <= samples; i++) {
      const t = (Math.PI / 2) * ((reverse ? samples - i : i) / samples);
      const x = cx + sx * r * f(t);
      const y = cy + sy * r * g(t);
      pts.push(`${(dx + x).toFixed(2)},${(dy + y).toFixed(2)}`);
    }
  };
  corner(w - r, r, 1, -1, true);      // top-right: (w-r,0) → (w,r)
  corner(w - r, h - r, 1, 1, false);  // bottom-right: (w,h-r) → (w-r,h)
  corner(r, h - r, -1, 1, true);      // bottom-left: (r,h) → (0,h-r)
  corner(r, r, -1, -1, false);        // top-left: (0,r) → (r,0)
  return `M${pts.join(" L")} Z`;
}

const FRAME_COLORS = {
  dark: {
    body: "#3b3b40", bodyEdge: "#151518", inner: "#000000",
    highlight: "rgba(255,255,255,0.28)", lowlight: "rgba(0,0,0,0.55)",
    laptopBody: "#1c1c20", bar: "#26262b", barText: "#c8c8cf", dot: "#4a4a52",
  },
  light: {
    body: "#c9c9d1", bodyEdge: "#8f8f98", inner: "#0a0a0c",
    highlight: "rgba(255,255,255,0.85)", lowlight: "rgba(0,0,0,0.25)",
    laptopBody: "#e7e7ec", bar: "#f1f1f4", barText: "#5f5f68", dot: "#c4c4cc",
  },
};

/**
 * Phone/tablet frame as an SVG overlay: an evenodd path between the outer
 * squircle and the inner (screen) squircle. Because the *same* squircle path
 * clips the screenshot and cuts the frame hole, the two edges coincide
 * exactly — no gaps, no halos, and the mask anti-aliasing comes from the
 * SVG rasterizer. A 1.25pt outer stroke fakes the titanium edge highlight.
 */
function frameOverlaySvg(device, theme = "dark", { buttons = false } = {}) {
  const c = FRAME_COLORS[theme] ?? FRAME_COLORS.dark;
  const b = device.bezel;
  const size = frameSize(device);
  const outerR = device.screenRadius + b;
  const outer = squirclePath(size.width, size.height, outerR);
  const innerTranslated = squirclePath(device.pt.width, device.pt.height, device.screenRadius, b, b);

  const btn = (x, y, w, h) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" fill="${c.bodyEdge}"/>`;
  // Side buttons: positions measured off product photos — APPROX, optional.
  // iPhone: action + volume left, side button right. Pixel: power above
  // the volume rocker, both on the right.
  const right = size.width - 0.5;
  const buttonsSvg = !buttons || device.kind !== "phone" ? ""
    : device.os === "android" ? btn(right, 190, 3, 46) + btn(right, 262, 3, 96)
    : btn(-2.5, 150, 3, 28) + btn(-2.5, 196, 3, 48) + btn(-2.5, 254, 3, 48) + btn(right, 208, 3, 74);
  // The viewBox grows 3pt each side for the buttons; the width must grow
  // with it or the whole overlay scales down and misregisters.
  const extra = buttons ? 6 : 0;

  return `<svg class="frame-overlay" width="${size.width + extra}" height="${size.height}"
    viewBox="${buttons ? -3 : 0} 0 ${size.width + extra} ${size.height}"
    style="position:absolute;left:${buttons ? -3 : 0}px;top:0;overflow:visible" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${c.highlight}"/>
        <stop offset="0.18" stop-color="rgba(255,255,255,0.06)"/>
        <stop offset="0.82" stop-color="rgba(255,255,255,0.05)"/>
        <stop offset="1" stop-color="${c.highlight}"/>
      </linearGradient>
    </defs>
    ${buttonsSvg}
    <path d="${outer} ${innerTranslated}" fill-rule="evenodd" fill="${c.body}"/>
    <path d="${outer} ${innerTranslated}" fill-rule="evenodd" fill="url(#edge)"/>
    <path d="${outer}" fill="none" stroke="${c.bodyEdge}" stroke-width="1.5"/>
    <path d="${innerTranslated}" fill="none" stroke="${c.inner}" stroke-width="2.5"/>
  </svg>`;
}

/**
 * iOS status bar SVG at device width × statusBar height. Layout per real
 * renders: time centered in the left "ear" (between the corner curve and
 * the island), cellular/wifi/battery centered in the right ear. Time is
 * 17pt semibold [kit-measured]; glyph boxes: cellular 18×12, wifi 17×12,
 * battery 27.5×13 [kit-measured]. Rendered in Inter (SF Pro cannot be
 * redistributed; Inter is the closest freely-licensed metric match —
 * documented in the README).
 */
function statusBarSvg(device, { color }) {
  const w = device.pt.width;
  const h = device.statusBar;
  const isl = device.island;
  const earL = isl ? (w - isl.width) / 2 : w / 2;
  const earR = isl ? (w + isl.width) / 2 : w / 2;
  // vertical center of the ear content sits at island center [kit-measured]
  const cy = isl ? isl.y + isl.height / 2 : h / 2;

  const timeX = earL / 2 + 2;
  const glyphsCx = (earR + w) / 2 - 6;

  const cell = `
    <g transform="translate(${glyphsCx - 32.5},${cy - 6})" fill="${color}">
      <rect x="0"   y="7.5" width="3" height="4.5" rx="1"/>
      <rect x="5"   y="5.5" width="3" height="6.5" rx="1"/>
      <rect x="10"  y="3"   width="3" height="9"   rx="1"/>
      <rect x="15"  y="0.5" width="3" height="11.5" rx="1"/>
    </g>`;
  const wifi = `
    <g transform="translate(${glyphsCx - 8.5},${cy - 6})" fill="none" stroke="${color}" stroke-width="2.1" stroke-linecap="round">
      <path d="M 2.2 4.8 A 9 9 0 0 1 14.8 4.8"/>
      <path d="M 4.9 7.9 A 5.4 5.4 0 0 1 12.1 7.9"/>
      <circle cx="8.5" cy="10.9" r="1.5" fill="${color}" stroke="none"/>
    </g>`;
  const battery = `
    <g transform="translate(${glyphsCx + 13},${cy - 6.5})">
      <rect x="0" y="0" width="25" height="13" rx="4" fill="none" stroke="${color}" stroke-opacity="0.38" stroke-width="1"/>
      <path d="M 26.6 4.3 Q 28.2 6.5 26.6 8.7 Z" fill="${color}" fill-opacity="0.4"/>
      <rect x="2" y="2" width="${21 * 0.82}" height="9" rx="2.4" fill="${color}"/>
    </g>`;
  const island = isl
    ? `<rect x="${(w - isl.width) / 2}" y="${isl.y}" width="${isl.width}" height="${isl.height}" rx="${isl.height / 2}" fill="#000"/>`
    : "";
  const punch = device.punchHole
    ? `<circle cx="${w / 2}" cy="${device.punchHole.cy}" r="${device.punchHole.d / 2}" fill="#000"/>`
    : "";

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"
    style="position:absolute;left:0;top:0">
    <text x="${timeX}" y="${cy}" text-anchor="middle" dominant-baseline="central"
      font-family="Inter, 'SF Pro Text', 'Helvetica Neue', sans-serif"
      font-size="17" font-weight="600" letter-spacing="-0.3" fill="${color}">9:41</text>
    ${cell}${wifi}${battery}${island}${punch}
  </svg>`;
}

/** Android-style status bar (Pixel). Metrics APPROX — see header. */
function androidStatusSvg(device, { color }) {
  const w = device.pt.width;
  const h = device.statusBar;
  const cy = h / 2 + 2;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"
    style="position:absolute;left:0;top:0">
    <text x="26" y="${cy}" dominant-baseline="central"
      font-family="Inter, Roboto, sans-serif" font-size="14" font-weight="500" fill="${color}">9:41</text>
    <g transform="translate(${w - 78},${cy - 7})" fill="${color}">
      <path d="M 0 12 A 14 14 0 0 1 20 12 L 10 12 Z" transform="translate(0,-1) scale(0.75)"/>
      <path d="M 26 13 L 40 13 L 40 0 Z" transform="translate(0,-1) scale(0.75)"/>
      <rect x="40" y="0" width="8" height="13" rx="2" fill-opacity="0.35"/>
      <rect x="41.5" y="3.5" width="5" height="8" rx="1"/>
    </g>
    ${device.punchHole ? `<circle cx="${w / 2}" cy="${device.punchHole.cy}" r="${device.punchHole.d / 2}" fill="#000"/>` : ""}
  </svg>`;
}

function homeIndicatorHtml(device, color) {
  const hi = device.homeIndicator;
  if (!hi) return "";
  return `<div style="position:absolute;left:50%;bottom:${hi.bottomGap}px;transform:translateX(-50%);
    width:${hi.width}px;height:${hi.height}px;border-radius:${hi.height}px;background:${color}"></div>`;
}

function safariBottomHtml(device, { domain, statusColor }) {
  const dark = statusColor === "#ffffff";
  const pillBg = dark ? "rgba(48,48,52,0.92)" : "rgba(246,246,248,0.96)";
  const text = dark ? "#f2f2f4" : "#1c1c1e";
  const dim = dark ? "rgba(242,242,244,0.55)" : "rgba(28,28,30,0.5)";
  const y = device.safeBottom;
  return `<div style="position:absolute;left:10px;right:10px;bottom:${y + 2}px;height:${SAFARI_BOTTOM_PILL - 4}px;
      border-radius:16px;background:${pillBg};box-shadow:0 0 0 0.5px rgba(0,0,0,0.15),0 4px 14px rgba(0,0,0,0.18);
      display:flex;align-items:center;padding:0 14px;box-sizing:border-box;font-family:Inter,sans-serif">
    <span style="font-size:15px;color:${dim}">ᴀA</span>
    <span style="flex:1;text-align:center;font-size:16px;color:${text}">${domain}</span>
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="${dim}" stroke-width="1.6" stroke-linecap="round">
      <path d="M 13.5 3.8 A 6 6 0 1 0 14.9 9.5"/><path d="M 13.7 1 L 13.7 4.1 L 10.6 4.1"/>
    </svg>
  </div>`;
}

/** Chromium-style desktop window chrome (APPROX). */
function browserChromeHtml(device, { domain, theme }) {
  const c = FRAME_COLORS[theme] ?? FRAME_COLORS.dark;
  const tabText = theme === "dark" ? "#e6e6ea" : "#3a3a40";
  const tabBg = theme === "dark" ? "#3a3a41" : "#ffffff";
  const glyph = theme === "dark" ? "#a0a0a8" : "#6b6b74";
  return `
  <div style="height:${device.tabStrip}px;background:${c.bar};display:flex;align-items:flex-end;padding:0 14px;box-sizing:border-box">
    <div style="display:flex;gap:8px;align-items:center;height:100%;margin-right:14px;align-self:center">
      <span style="width:12px;height:12px;border-radius:99px;background:#ff5f57"></span>
      <span style="width:12px;height:12px;border-radius:99px;background:#febc2e"></span>
      <span style="width:12px;height:12px;border-radius:99px;background:#28c840"></span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;background:${tabBg};height:30px;padding:0 14px;border-radius:10px 10px 0 0;min-width:200px;max-width:260px">
      <span style="width:14px;height:14px;border-radius:4px;background:linear-gradient(135deg,#7c8cf8,#5ec9d8)"></span>
      <span style="font:12.5px/1 Inter,sans-serif;color:${tabText};overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${domain}</span>
    </div>
  </div>
  <div style="height:${device.toolbar}px;background:${tabBg};display:flex;align-items:center;gap:12px;padding:0 14px;box-sizing:border-box;border-bottom:1px solid ${theme === "dark" ? "#26262b" : "#e4e4e9"}">
    <svg width="48" height="16" viewBox="0 0 48 16" fill="none" stroke="${glyph}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 9 2 L 3 8 L 9 14"/>
      <path d="M 21 2 L 27 8 L 21 14" opacity="0.45"/>
      <path d="M 40 3 A 5.5 5.5 0 1 1 36 4.5"/><path d="M 36 1.5 L 36 5 L 39.5 5"/>
    </svg>
    <div style="flex:1;display:flex;align-items:center;gap:8px;background:${theme === "dark" ? "#26262b" : "#f1f1f4"};height:30px;border-radius:15px;padding:0 14px">
      <svg width="11" height="13" viewBox="0 0 11 13" fill="${glyph}"><rect x="0" y="5" width="11" height="8" rx="2"/><path d="M 2.5 5 V 3.5 A 3 3 0 0 1 8.5 3.5 V 5" fill="none" stroke="${glyph}" stroke-width="1.6"/></svg>
      <span style="font:13px/1 Inter,sans-serif;color:${tabText}">${domain}</span>
    </div>
    <span style="width:16px;height:16px;border-radius:99px;background:linear-gradient(135deg,#9aa6ff,#62d0c1)"></span>
  </div>`;
}

function macMenuBarHtml(device, { statusColor, domain }) {
  const dark = statusColor === "#ffffff";
  const bg = dark ? "rgba(24,24,28,0.94)" : "rgba(246,246,248,0.94)";
  const text = dark ? "#ececf0" : "#2a2a30";
  const dim = dark ? "rgba(236,236,240,0.55)" : "rgba(42,42,48,0.55)";
  const n = device.notch;
  const menus = [domain, "File", "Edit", "View", "Window", "Help"];
  return `
  <div style="position:absolute;left:0;top:0;width:${device.pt.width}px;height:${device.menuBar}px;background:${bg};
      display:flex;align-items:center;padding:0 18px;box-sizing:border-box;gap:18px;
      font:13.5px/1 Inter,sans-serif;color:${dim}">
    <span style="width:15px;height:15px;border-radius:5px;background:${text};opacity:0.9"></span>
    ${menus.map((m, i) => `<span style="${i === 0 ? `font-weight:600;color:${text}` : ""}">${m}</span>`).join("")}
    <span style="flex:1"></span>
    <svg width="17" height="13" viewBox="0 0 17 13" fill="none" stroke="${text}" stroke-width="1.8" stroke-linecap="round">
      <path d="M 2.2 4.8 A 9 9 0 0 1 14.8 4.8"/><path d="M 4.9 7.9 A 5.4 5.4 0 0 1 12.1 7.9"/>
      <circle cx="8.5" cy="10.9" r="1.4" fill="${text}" stroke="none"/>
    </svg>
    <svg width="26" height="12" viewBox="0 0 26 12"><rect x="0" y="0.5" width="22" height="11" rx="3" fill="none" stroke="${text}" stroke-opacity="0.4"/><rect x="1.8" y="2.3" width="15" height="7.4" rx="1.6" fill="${text}"/><path d="M 23.4 3.8 Q 24.8 6 23.4 8.2 Z" fill="${text}" fill-opacity="0.45"/></svg>
    <span style="color:${text}">Fri Sep 26</span><span style="color:${text}">9:41 AM</span>
  </div>
  <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:${n.width}px;height:${n.height}px;
      background:#000;border-radius:0 0 10px 10px"></div>`;
}

/**
 * One framed device with faithful chrome. opts:
 *   contentHtml — the page layer (an <img> for stills; a scroll window for
 *                 video), already sized to contentRect
 *   bandColor / bottomColor — page background continuation behind chrome
 *   statusColor — "#ffffff" | "#000000" (from page luminance or override)
 *   indicatorColor, domain (plain text; escaped here), frameTheme, buttons, mode
 */
export function buildDeviceHtml(device, opts) {
  const {
    contentHtml, bandColor, bottomColor, statusColor, indicatorColor,
    frameTheme = "dark", buttons = false, mode = "standalone",
  } = opts;
  const domain = escapeHtml(opts.domain ?? "");
  const size = frameSize(device);
  const pt = device.pt;

  switch (device.kind) {
    case "phone":
    case "tablet": {
      const clip = squirclePath(pt.width, pt.height, device.screenRadius);
      const cr = contentRect(device, mode);
      const bottomBandH = pt.height - cr.y - cr.height;
      const bottomBand = mode !== "bare" && bottomBandH > 0
        ? `<div style="position:absolute;left:0;bottom:0;width:${pt.width}px;height:${bottomBandH}px;background:${bottomColor}"></div>`
        : "";
      const statusSvg = device.os === "android"
        ? androidStatusSvg(device, { color: statusColor })
        : statusBarSvg(device, { color: statusColor });
      return `<div class="frame" style="position:relative;width:${size.width}px;height:${size.height}px">
        <div style="position:absolute;left:${device.bezel}px;top:${device.bezel}px;width:${pt.width}px;height:${pt.height}px;
             background:${bandColor};clip-path:path('${clip}')">
          ${bottomBand}
          ${contentHtml}
          ${mode === "bare" ? (device.island ? `<svg width="${pt.width}" height="${device.statusBar}" style="position:absolute;left:0;top:0"><rect x="${(pt.width - device.island.width) / 2}" y="${device.island.y}" width="${device.island.width}" height="${device.island.height}" rx="${device.island.height / 2}" fill="#000"/></svg>` : "") : statusSvg}
          ${mode === "safari" && device.os === "ios" ? safariBottomHtml(device, { domain, statusColor }) : ""}
          ${mode === "bare" ? "" : homeIndicatorHtml(device, indicatorColor)}
        </div>
        ${frameOverlaySvg(device, frameTheme, { buttons })}
      </div>`;
    }
    case "laptop": {
      const c = FRAME_COLORS[frameTheme] ?? FRAME_COLORS.dark;
      const lidW = pt.width + 2 * device.bezel;
      const clip = squirclePath(pt.width, pt.height, device.screenRadius);
      return `<div class="frame" style="width:${size.width}px;height:${size.height}px">
        <div style="position:relative;width:${lidW}px;margin:0 auto;background:${c.laptopBody};border:1px solid ${c.bodyEdge};box-sizing:border-box;border-radius:18px 18px 0 0;padding:${device.bezel - 1}px">
          <div style="position:relative;width:${pt.width}px;height:${pt.height}px;background:${bandColor};clip-path:path('${clip}');overflow:hidden">
            ${contentHtml}
            ${macMenuBarHtml(device, { statusColor, domain })}
          </div>
        </div>
        <div style="position:relative;width:${size.width}px;height:${device.deck.height}px;background:linear-gradient(${c.laptopBody},${c.bodyEdge});border-radius:0 0 14px 14px">
          <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:${device.deck.lipWidth}px;height:${Math.round(device.deck.height / 2.6)}px;background:${c.bodyEdge};border-radius:0 0 10px 10px"></div>
        </div></div>`;
    }
    case "browser": {
      const c = FRAME_COLORS[frameTheme] ?? FRAME_COLORS.dark;
      return `<div class="frame" style="width:${size.width}px;height:${size.height}px;border-radius:${device.outerRadius}px;overflow:hidden;background:${bandColor};border:1px solid ${c.bodyEdge};box-sizing:border-box">
        ${browserChromeHtml(device, { domain, theme: frameTheme })}
        <div style="position:relative;width:${pt.width}px;height:${pt.height}px">${contentHtml}</div>
      </div>`;
    }
  }
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export const BACKGROUNDS = {
  studio: "linear-gradient(160deg,#f4f5f7 0%,#dfe2e8 55%,#c9cdd6 100%)",
  "studio-dark": "linear-gradient(160deg,#1c1d22 0%,#121317 60%,#0a0b0e 100%)",
  sunset: "linear-gradient(135deg,#fde5d0 0%,#f7c6cf 50%,#c9c3ef 100%)",
  ocean: "linear-gradient(135deg,#d8ecf5 0%,#c1d9f0 50%,#a9c3e8 100%)",
  none: "transparent",
};

