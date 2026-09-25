/**
 * Device viewport specs and generated frame markup.
 *
 * Frames are plain HTML/CSS generated here — rounded rects, a camera
 * pill, browser chrome dots. No copyrighted vendor artwork. All values
 * are CSS px; the composite page is screenshotted at the device's DPR,
 * so the embedded screenshot renders 1:1 at native pixels.
 */

export const DEVICES = {
  "iphone-15-pro": {
    label: "iPhone 15 Pro (spec: 393×852 @3x)",
    kind: "phone",
    viewport: { width: 393, height: 852 },
    dpr: 3,
    bezel: 13,
    outerRadius: 62,
    screenRadius: 49,
    pill: { width: 122, height: 36, top: 12 },
  },
  "pixel-8": {
    label: "Pixel 8 (spec: 412×915 @2.625x)",
    kind: "phone",
    viewport: { width: 412, height: 915 },
    dpr: 2.625,
    bezel: 12,
    outerRadius: 44,
    screenRadius: 32,
    pill: { width: 26, height: 26, top: 14 },
  },
  "ipad-pro-11": {
    label: "iPad Pro 11\" (spec: 834×1194 @2x)",
    kind: "tablet",
    viewport: { width: 834, height: 1194 },
    dpr: 2,
    bezel: 28,
    outerRadius: 38,
    screenRadius: 18,
    pill: null,
  },
  "macbook-14": {
    label: "MacBook-class 14\" laptop (spec: 1512×982 @2x)",
    kind: "laptop",
    viewport: { width: 1512, height: 982 },
    dpr: 2,
    bezel: 18,
    outerRadius: 20,
    screenRadius: 10,
    deck: { height: 30, lipWidth: 180, overhang: 70 },
  },
  browser: {
    label: "Desktop browser window (1280×800 @2x)",
    kind: "browser",
    viewport: { width: 1280, height: 800 },
    dpr: 2,
    bezel: 0,
    outerRadius: 12,
    screenRadius: 0,
    bar: { height: 44 },
  },
};

export function deviceList() {
  return Object.entries(DEVICES)
    .map(([id, d]) => `  ${id.padEnd(14)} ${d.label}`)
    .join("\n");
}

// Outer frame size in CSS px (without padding/background).
export function frameSize(device) {
  const { width, height } = device.viewport;
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
      // +2 for the 1px window border on each side: the screenshot must
      // keep its exact pixel size, never be squeezed by the border.
      return { width: width + 2, height: height + device.bar.height + 2 };
    default: {
      const exhaustive = device.kind;
      throw new Error(`unhandled device kind: ${exhaustive}`);
    }
  }
}

// The screen rect (where screenshot pixels land) relative to the frame,
// CSS px. Used by the alignment check.
export function screenRect(device) {
  switch (device.kind) {
    case "phone":
    case "tablet":
      return { x: device.bezel, y: device.bezel, ...device.viewport };
    case "laptop":
      return { x: device.bezel + device.deck.overhang, y: device.bezel, ...device.viewport };
    case "browser":
      return { x: 1, y: device.bar.height + 1, ...device.viewport };
    default: {
      const exhaustive = device.kind;
      throw new Error(`unhandled device kind: ${exhaustive}`);
    }
  }
}

const FRAME_COLORS = {
  dark: { body: "#17171b", edge: "#2c2c31", bar: "#26262b", barText: "#9a9aa2", dot: "#4a4a52" },
  light: { body: "#e7e7ec", edge: "#c9c9d1", bar: "#f1f1f4", barText: "#6b6b74", dot: "#c4c4cc" },
};

/**
 * HTML for one framed device. `src` is a data: URL for the screenshot.
 * Returned element has class "frame" and exact frameSize dimensions.
 */
export function frameHtml(device, src, { frameTheme = "dark", url = "" } = {}) {
  const c = FRAME_COLORS[frameTheme] ?? FRAME_COLORS.dark;
  const { width: vw, height: vh } = device.viewport;
  const size = frameSize(device);
  const img = (radius) =>
    `<img src="${src}" style="display:block;width:${vw}px;height:${vh}px;border-radius:${radius}px" alt=""/>`;

  switch (device.kind) {
    case "phone":
    case "tablet": {
      const pill = device.pill
        ? `<div style="position:absolute;left:50%;top:${device.pill.top}px;transform:translateX(-50%);width:${device.pill.width}px;height:${device.pill.height}px;background:#000;border-radius:999px"></div>`
        : "";
      return `<div class="frame" style="position:relative;width:${size.width}px;height:${size.height}px;background:${c.body};border:1px solid ${c.edge};box-sizing:border-box;border-radius:${device.outerRadius}px;padding:${device.bezel - 1}px">
        ${img(device.screenRadius)}${pill}</div>`;
    }
    case "laptop": {
      const lidW = vw + 2 * device.bezel;
      return `<div class="frame" style="width:${size.width}px;height:${size.height}px">
        <div style="position:relative;width:${lidW}px;margin:0 auto;background:${c.body};border:1px solid ${c.edge};box-sizing:border-box;border-radius:${device.outerRadius}px ${device.outerRadius}px 0 0;padding:${device.bezel - 1}px">
          <div style="position:absolute;left:50%;top:${Math.round(device.bezel / 2) - 3}px;transform:translateX(-50%);width:6px;height:6px;border-radius:99px;background:#000"></div>
          ${img(device.screenRadius)}
        </div>
        <div style="position:relative;width:${size.width}px;height:${device.deck.height}px;background:linear-gradient(${c.body},${c.edge});border-radius:0 0 14px 14px">
          <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:${device.deck.lipWidth}px;height:${Math.round(device.deck.height / 2.6)}px;background:${c.edge};border-radius:0 0 10px 10px"></div>
        </div></div>`;
    }
    case "browser": {
      const shownUrl = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return `<div class="frame" style="width:${size.width}px;height:${size.height}px;border-radius:${device.outerRadius}px;overflow:hidden;background:${c.bar};border:1px solid ${c.edge};box-sizing:border-box">
        <div style="display:flex;align-items:center;gap:8px;height:${device.bar.height}px;padding:0 16px;box-sizing:border-box">
          <span style="width:12px;height:12px;border-radius:99px;background:#ff5f57"></span>
          <span style="width:12px;height:12px;border-radius:99px;background:#febc2e"></span>
          <span style="width:12px;height:12px;border-radius:99px;background:#28c840"></span>
          <span style="flex:1;max-width:520px;margin:0 auto;background:${c.dot}33;border-radius:8px;padding:5px 14px;font:12px/1.2 system-ui,sans-serif;color:${c.barText};text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${shownUrl}</span>
          <span style="width:60px"></span>
        </div>${img(0)}</div>`;
    }
    default: {
      const exhaustive = device.kind;
      throw new Error(`unhandled device kind: ${exhaustive}`);
    }
  }
}

export const BACKGROUNDS = {
  studio: "linear-gradient(160deg,#f4f5f7 0%,#dfe2e8 55%,#c9cdd6 100%)",
  "studio-dark": "linear-gradient(160deg,#1c1d22 0%,#121317 60%,#0a0b0e 100%)",
  sunset: "linear-gradient(135deg,#fde5d0 0%,#f7c6cf 50%,#c9c3ef 100%)",
  ocean: "linear-gradient(135deg,#d8ecf5 0%,#c1d9f0 50%,#a9c3e8 100%)",
  none: "transparent",
};
