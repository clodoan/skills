/**
 * plinth 3D scene — procedural device bodies built from the verified
 * spec table (no vendor 3D assets). Runs inside headless Chrome; driven
 * by render3d.mjs through window.__plinth.
 *
 * Geometry: the same sampled-superellipse outline that clips the 2D
 * compositor is extruded (with bevels) for the body; the screen is a
 * squircle-shaped plane textured with the 2D compositor's output — the
 * single source of screen truth. The island is its own capsule mesh.
 * Materials are MeshPhysicalMaterial with a procedural room environment;
 * the screen material is unlit and tone-map-exempt so flat renders stay
 * pixel-exact.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const CONFIG = await (await fetch("/config.json")).json();

const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

if (CONFIG.bg.type === "color") scene.background = new THREE.Color(CONFIG.bg.a);
if (CONFIG.bg.type === "gradient") {
  const c = document.createElement("canvas");
  c.width = 16; c.height = 512;
  const g = c.getContext("2d").createLinearGradient(0, 0, 6, 512);
  g.addColorStop(0, CONFIG.bg.a);
  g.addColorStop(1, CONFIG.bg.b);
  const ctx = c.getContext("2d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}

function shapeFromPoints(points, height) {
  // Config points are y-down (pt, origin top-left); three is y-up.
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => {
    const yy = height - y;
    if (i === 0) shape.moveTo(x, yy);
    else shape.lineTo(x, yy);
  });
  shape.closePath();
  return shape;
}

/** ShapeGeometry UVs are raw plane coords; remap them to 0..1. */
function normalizeUVs(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
      (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y),
    );
  }
  uv.needsUpdate = true;
  return geo;
}

async function loadTexture(url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (CONFIG.view === "flat") {
    // 1:1 texel mapping — no mipmaps, no anisotropy, pixel-exact.
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 1;
  } else {
    // Oblique minification without mipmaps produces heavy moiré on
    // subtle dark gradients; trilinear + max anisotropy fixes it.
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  return tex;
}

const FRAME_TINTS = {
  dark: { body: 0x4a4a50, plate: 0x0a0a0c },
  light: { body: 0xc9c9d1, plate: 0x101014 },
};

/** Build one device group centered at origin, facing +z. */
async function buildDevice(d) {
  const spec = d.spec;
  const group = new THREE.Group();
  const t = d.thickness;
  const tint = FRAME_TINTS[CONFIG.frameTheme] ?? FRAME_TINTS.dark;

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: tint.body, metalness: 0.88, roughness: 0.34,
    clearcoat: 0.6, clearcoatRoughness: 0.32, envMapIntensity: 1.15,
  });
  const plateMat = new THREE.MeshPhysicalMaterial({
    color: tint.plate, metalness: 0.2, roughness: 0.25,
    clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1,
  });
  const screenTex = await loadTexture(d.texture);
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });

  const outerW = d.outer.width;
  const outerH = d.outer.height;
  const center = (mesh) => {
    mesh.position.x -= outerW / 2;
    mesh.position.y -= outerH / 2;
    return mesh;
  };

  // Real bezel art mode: the official frame PNG is the device's front
  // face (unlit, keeping the art's baked lighting), the screenshot plane
  // sits in its cutout, and the extruded body follows the art's
  // silhouette. The front view matches the flat composite exactly.
  if (d.frameArt) {
    const fa = d.frameArt;
    // Thin slab: the art is a flat front view drawn at physical
    // proportions, so a thick extrusion inevitably projects past the
    // art's corner curves at yaw. A thin body keeps the silhouette true;
    // depth reads through perspective, glass, and the contact shadow.
    const t2 = Math.min(10, t / 4);
    const bodyShape2 = shapeFromPoints(d.outer.points, outerH);
    // No bevel: bevels grow outward past the art's silhouette.
    const bodyGeo2 = new THREE.ExtrudeGeometry(bodyShape2, {
      depth: t2, bevelEnabled: false, curveSegments: 1,
    });
    bodyGeo2.translate(0, 0, -t2);
    group.add(center(new THREE.Mesh(bodyGeo2, bodyMat)));

    // Coordinates are in art space: the slab outline, screen and art
    // plane all share the art's origin.
    const holeCx = fa.hole.x + fa.hole.width / 2;
    const holeCy = fa.hole.y + fa.hole.height / 2;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(fa.hole.width, fa.hole.height), screenMat);
    screen.position.set(holeCx - outerW / 2, outerH / 2 - holeCy, 0.4);
    group.add(screen);

    const artTex = await loadTexture(fa.texture);
    // Apple's art stores white RGB under alpha-0 margins; without
    // premultiplied alpha, linear filtering bleeds that white into the
    // silhouette as a bright halo.
    artTex.premultiplyAlpha = true;
    artTex.needsUpdate = true;
    const artCx = fa.art.width / 2;
    const artCy = fa.art.height / 2;
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(fa.art.width, fa.art.height),
      new THREE.MeshBasicMaterial({
        map: artTex, transparent: true, toneMapped: false, premultipliedAlpha: true,
      }),
    );
    art.position.set(artCx - outerW / 2, outerH / 2 - artCy, 0.8);
    group.add(art);

    if (CONFIG.view !== "flat") {
      const glass = new THREE.Mesh(
        new THREE.PlaneGeometry(fa.hole.width, fa.hole.height),
        new THREE.MeshPhysicalMaterial({
          color: 0xffffff, metalness: 0, roughness: 0.32, transparent: true,
          opacity: 0.035, envMapIntensity: 1.1, depthWrite: false,
        }),
      );
      glass.position.set(screen.position.x, screen.position.y, 3);
      group.add(glass);
    }
    return group;
  }

  // Body: extruded outer squircle with beveled edges (titanium band).
  const bodyShape = shapeFromPoints(d.outer.points, outerH);
  const bevel = Math.min(4, t / 4);
  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
    depth: t - 2 * bevel, bevelEnabled: true, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: 5, curveSegments: 1,
  });
  bodyGeo.translate(0, 0, -(t - 2 * bevel) / 2);
  const body = center(new THREE.Mesh(bodyGeo, bodyMat));
  group.add(body);

  // Front plate: black glass border between body edge and screen.
  if (d.plate) {
    const plateShape = shapeFromPoints(d.plate.outerPoints, outerH);
    plateShape.holes.push(new THREE.Path(
      shapeFromPoints(d.plate.innerPoints, outerH).getPoints(),
    ));
    const plate = center(new THREE.Mesh(new THREE.ShapeGeometry(plateShape), plateMat));
    plate.position.z = t / 2 + 0.1;
    group.add(plate);
  }

  // Screen: squircle plane textured with the 2D compositor output.
  const screenShape = shapeFromPoints(d.screen.points, outerH);
  const screen = center(new THREE.Mesh(normalizeUVs(new THREE.ShapeGeometry(screenShape)), screenMat));
  screen.position.z = d.screenZ ?? (t / 2 + 0.2);
  group.add(screen);

  // Dynamic Island / punch hole as geometry, flush over the screen.
  if (d.island) {
    const islShape = shapeFromPoints(d.island.points, outerH);
    // Unlit true black: the island is a matte display cutout, not a lit
    // surface — physical materials pick up environment light and go gray.
    const isl = center(new THREE.Mesh(
      new THREE.ShapeGeometry(islShape),
      new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }),
    ));
    isl.position.z = screen.position.z + 0.9;
    group.add(isl);
  }

  // Subtle glass reflection over the screen — perspective views only,
  // so flat renders stay pixel-exact.
  if (CONFIG.view !== "flat") {
    // Rough enough that the room environment blurs into a soft sheen —
    // sharp reflections of the room's light boxes read as moiré/banding
    // on dark screens.
    const glass = center(new THREE.Mesh(
      new THREE.ShapeGeometry(shapeFromPoints(d.screen.points, outerH)),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff, metalness: 0, roughness: 0.32, transparent: true,
        opacity: 0.035, envMapIntensity: 1.1, depthWrite: false,
      }),
    ));
    glass.position.z = screen.position.z + 3;
    group.add(glass);
  }

  if (d.buttons) {
    for (const b of d.buttons) {
      const geo = new THREE.BoxGeometry(b.w, b.h, t * 0.55);
      geo.translate(b.x - outerW / 2, outerH / 2 - b.y, 0);
      group.add(new THREE.Mesh(geo, bodyMat));
    }
  }

  // Laptop deck: a thin rounded slab hinged at the lid bottom.
  if (d.deck) {
    const deckShape = shapeFromPoints(d.deck.points, d.deck.depth);
    const deckGeo = new THREE.ExtrudeGeometry(deckShape, {
      depth: d.deck.thickness, bevelEnabled: true, bevelThickness: 1.5,
      bevelSize: 1.5, bevelSegments: 3, curveSegments: 1,
    });
    const deck = new THREE.Mesh(deckGeo, bodyMat);
    deck.geometry.translate(-d.deck.width / 2, -d.deck.depth + 4, 0);
    deck.rotation.x = -Math.PI / 2 + THREE.MathUtils.degToRad(8);
    deck.position.y = -outerH / 2;
    deck.position.z = t / 2;
    group.add(deck);
    // Slight presentation tilt in perspective views only — any rotation
    // breaks the flat view's pixel exactness.
    if (CONFIG.view !== "flat") group.rotation.x = THREE.MathUtils.degToRad(-4);
  }

  return group;
}

function blobShadow(radiusX, radiusY) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 512;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(256, 256, 20, 256, 256, 250);
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(0.55, "rgba(0,0,0,0.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radiusX * 2, radiusY * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

// ---------------------------------------------------------------- scene

const groups = [];
for (const d of CONFIG.devices) groups.push(await buildDevice(d));

const rig = new THREE.Group();
scene.add(rig);

const maxH = Math.max(...CONFIG.devices.map((d) => d.outer.height));
const maxW = Math.max(...CONFIG.devices.map((d) => d.outer.width));
const view = CONFIG.view;

function place(group, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = {}) {
  group.position.set(x, y, z);
  group.rotation.set(
    THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz),
  );
  rig.add(group);
}

if (view === "fan") {
  const n = groups.length;
  groups.forEach((g, i) => {
    const k = i - (n - 1) / 2;
    place(g, { x: k * maxW * 0.78, y: Math.abs(k) * -14, z: -Math.abs(k) * 70, ry: k * -16, rz: k * -3 });
  });
} else if (view === "combo") {
  // laptop (or larger device) centered, phone front-right.
  const sorted = [...groups.entries()].sort(
    (a, b) => CONFIG.devices[b[0]].outer.width - CONFIG.devices[a[0]].outer.width,
  );
  const [bigIdx, big] = sorted[0];
  place(big, { x: -maxW * 0.06, ry: 6 });
  if (sorted[1]) {
    const [smallIdx, small] = sorted[1];
    const bigW = CONFIG.devices[bigIdx].outer.width;
    const smallH = CONFIG.devices[smallIdx].outer.height;
    place(small, {
      x: bigW * 0.44, y: -(maxH - smallH) / 2 - 20, z: 180, ry: -14, rz: -2,
    });
  }
} else {
  const rot = {
    flat: {}, hero: { ry: -24, rx: 4, rz: -4 },
    "tilt-left": { ry: 22 }, "tilt-right": { ry: -22 },
    "top-down": { rx: 55 },
  }[view] ?? {};
  const d0 = CONFIG.devices[0];
  const flatShift = view === "flat" && d0.frameHeight
    ? (d0.frameHeight - d0.outer.height) / 2
    : 0;
  place(groups[0], { y: flatShift, ...rot, ...CONFIG.rotate });
}

// Float + contact shadow (perspective views).
if (view !== "flat") {
  const float = CONFIG.float ?? 26;
  rig.position.y += float / 2;
  const shadow = blobShadow(maxW * (view === "fan" ? 1.6 : 0.95), maxH * 0.42);
  shadow.position.y = -maxH / 2 - float;
  if (CONFIG.shadow !== false) scene.add(shadow);
}

// --------------------------------------------------------------- camera

let camera;
if (view === "flat") {
  const w = CONFIG.stage.width;
  const h = CONFIG.stage.height;
  camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 5000);
  camera.position.set(0, 0, 1000);
  renderer.toneMapping = THREE.NoToneMapping;
  // Key + fill so the metal band reads in ortho too.
  const key = new THREE.DirectionalLight(0xffffff, 0.5);
  key.position.set(-200, 300, 500);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.25));
} else {
  const dist = maxH * (view === "fan" || view === "combo" ? 2.9 : 2.4);
  // Tight near/far keeps depth precision high — a near plane of 1 makes
  // the glass overlay z-fight the screen into grid/diagonal artifacts.
  camera = new THREE.PerspectiveCamera(28, CONFIG.stage.width / CONFIG.stage.height, dist * 0.3, dist * 6);
  const el = view === "top-down" ? 0.9 : 0.16;
  camera.position.set(dist * 0.14, dist * el, dist);
  camera.lookAt(0, 0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
}

renderer.setPixelRatio(CONFIG.scale);
renderer.setSize(CONFIG.stage.width, CONFIG.stage.height);

// ------------------------------------------------------------- controls

window.__plinth = {
  renderStill() {
    renderer.render(scene, camera);
    return canvas.toDataURL("image/png");
  },
  /** Seamless float/turntable loop frame i of n. */
  renderFrame(i, n) {
    const t = (2 * Math.PI * i) / n;
    rig.rotation.y = THREE.MathUtils.degToRad(CONFIG.turnDegrees ?? 10) * Math.sin(t);
    rig.position.y = 8 * Math.sin(t + Math.PI / 3);
    renderer.render(scene, camera);
    return canvas.toDataURL("image/png");
  },
};
window.__ready = true;
