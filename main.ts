// KORVANE — a travel poster for a place that isn't there.
// A pure-Node, dependency-free, deterministic poster generator.
// Writes a 1024x1024 PNG to /output/entry.png (or $OUTPUT_PATH).
// Run: node main.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname } from "node:path";

const W = 1024;
const H = 1024;
const OUT = process.env.OUTPUT_PATH ?? "/output/entry.png";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same bytes on every run.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261121);

// ---------------------------------------------------------------------------
// Canvas: plain RGB buffer + alpha-aware drawing helpers.
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
const px = new Uint8Array(W * H * 3);

function clamp(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

function setPx(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
}

function blendPx(x: number, y: number, c: RGB, a: number): void {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  if (a >= 1) { setPx(x, y, c); return; }
  const i = (y * W + x) * 3;
  px[i] = clamp(px[i] + (c[0] - px[i]) * a);
  px[i + 1] = clamp(px[i + 1] + (c[1] - px[i + 1]) * a);
  px[i + 2] = clamp(px[i + 2] + (c[2] - px[i + 2]) * a);
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [clamp(lerp(c1[0], c2[0], t)), clamp(lerp(c1[1], c2[1], t)), clamp(lerp(c1[2], c2[2], t))];
}

// Vertical multi-stop gradient over the whole canvas (or a y range).
function vGradient(stops: [number, RGB][], y0 = 0, y1 = H): void {
  for (let y = y0; y < y1; y++) {
    const t = (y - y0) / (y1 - y0 - 1);
    let c: RGB = stops[stops.length - 1][1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        const lt = (t - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
        c = mix(stops[s][1], stops[s + 1][1], lt);
        break;
      }
    }
    for (let x = 0; x < W; x++) setPx(x, y, c);
  }
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++)
    for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++)
      blendPx(x, y, c, a);
}

// Scanline polygon fill.
function fillPoly(pts: [number, number][], c: RGB, a = 1): void {
  let minY = H, maxY = 0;
  for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++)
        blendPx(x, y, c, a);
    }
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  const r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) blendPx(x, y, c, a);
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(H - 1, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, Math.ceil(cx + rx)); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) blendPx(x, y, c, a);
    }
  }
}

// Thick line as stamped circles (round caps, round joins).
function thickLine(x1: number, y1: number, x2: number, y2: number, w: number, c: RGB, a = 1): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(len / Math.max(1, w * 0.45)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(lerp(x1, x2, t), lerp(y1, y2, t), w / 2, c, a);
  }
}

function polyline(pts: [number, number][], w: number, c: RGB, a = 1): void {
  for (let i = 0; i + 1 < pts.length; i++)
    thickLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, c, a);
}

// Sine-wave stroke (used for aurora ribbons, waves, smoke).
function sineStroke(x0: number, x1: number, yBase: number, amp: number, waves: number, phase: number, w: number, c: RGB, a = 1): void {
  const pts: [number, number][] = [];
  const n = 90;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([lerp(x0, x1, t), yBase + Math.sin(t * waves * Math.PI * 2 + phase) * amp]);
  }
  polyline(pts, w, c, a);
}

// ---------------------------------------------------------------------------
// Geometric stroke font. Grid: x 0..4, y 0..7. Each glyph = list of polylines.
// ---------------------------------------------------------------------------
type Glyph = [number, number][][];
const FONT: Record<string, Glyph> = {
  A: [[[0, 7], [2, 0], [4, 7]], [[1, 4.2], [3, 4.2]]],
  B: [[[0, 0], [0, 7]], [[0, 0], [2.4, 0], [3.6, 1], [3.6, 2.2], [2.4, 3.4], [0, 3.4]], [[0, 3.4], [2.6, 3.4], [3.8, 4.4], [3.8, 5.8], [2.6, 7], [0, 7]]],
  C: [[[3.6, 1.2], [2, 0], [0.6, 0.6], [0, 2.2], [0, 4.8], [0.6, 6.4], [2, 7], [3.6, 5.8]]],
  D: [[[0, 0], [0, 7]], [[0, 0], [2.4, 0], [3.8, 1.4], [3.8, 5.6], [2.4, 7], [0, 7]]],
  E: [[[0, 0], [0, 7]], [[0, 0], [4, 0]], [[0, 3.5], [3, 3.5]], [[0, 7], [4, 7]]],
  F: [[[0, 0], [0, 7]], [[0, 0], [4, 0]], [[0, 3.5], [3, 3.5]]],
  G: [[[3.6, 1.2], [2, 0], [0.6, 0.6], [0, 2.2], [0, 4.8], [0.6, 6.4], [2, 7], [3.6, 7], [4, 6.4], [4, 4]], [[2.2, 4], [4, 4]]],
  H: [[[0, 0], [0, 7]], [[4, 0], [4, 7]], [[0, 3.5], [4, 3.5]]],
  I: [[[0, 0], [4, 0]], [[2, 0], [2, 7]], [[0, 7], [4, 7]]],
  J: [[[3.2, 0], [3.2, 5.6], [2.2, 7], [0.6, 7], [0, 6]]],
  K: [[[0, 0], [0, 7]], [[3.8, 0], [0, 3.6]], [[0.8, 3.2], [3.8, 7]]],
  L: [[[0, 0], [0, 7]], [[0, 7], [4, 7]]],
  M: [[[0, 7], [0, 0], [2, 3.6], [4, 0], [4, 7]]],
  N: [[[0, 7], [0, 0], [4, 7], [4, 0]]],
  O: [[[1.2, 0], [2.8, 0], [4, 1.4], [4, 5.6], [2.8, 7], [1.2, 7], [0, 5.6], [0, 1.4], [1.2, 0]]],
  P: [[[0, 0], [0, 7]], [[0, 0], [2.4, 0], [3.6, 1], [3.6, 2.4], [2.4, 3.5], [0, 3.5]]],
  Q: [[[1.2, 0], [2.8, 0], [4, 1.4], [4, 5.6], [2.8, 7], [1.2, 7], [0, 5.6], [0, 1.4], [1.2, 0]], [[2.4, 4.8], [4, 7]]],
  R: [[[0, 0], [0, 7]], [[0, 0], [2.4, 0], [3.6, 1], [3.6, 2.4], [2.4, 3.5], [0, 3.5]], [[2, 3.5], [4, 7]]],
  S: [[[3.6, 1], [2, 0], [0.6, 0.6], [0, 2], [0.8, 3.4], [3.2, 3.6], [4, 5], [3.4, 6.4], [2, 7], [0.6, 6.4]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 7]]],
  U: [[[0, 0], [0, 5.4], [1, 7], [3, 7], [4, 5.4], [4, 0]]],
  V: [[[0, 0], [2, 7], [4, 0]]],
  W: [[[0, 0], [1, 7], [2, 3.4], [3, 7], [4, 0]]],
  X: [[[0, 0], [4, 7]], [[4, 0], [0, 7]]],
  Y: [[[0, 0], [2, 3.4], [4, 0]], [[2, 3.4], [2, 7]]],
  Z: [[[0, 0], [4, 0], [0, 7], [4, 7]]],
};

function textWidth(text: string, unit: number, tracking: number): number {
  return text.length * (4 + tracking) * unit - tracking * unit;
}

function drawText(text: string, cx: number, yTop: number, unit: number, c: RGB, a = 1): void {
  const tracking = unit > 10 ? 0.7 : 0.55;
  const w = textWidth(text, unit, tracking);
  let x = cx - w / 2;
  const thick = Math.max(2, unit * 0.52);
  for (const ch of text) {
    if (ch === " ") { x += (4 + tracking) * unit; continue; }
    const glyph = FONT[ch];
    if (!glyph) { x += (4 + tracking) * unit; continue; }
    for (const stroke of glyph) {
      const pts = stroke.map(([gx, gy]): [number, number] => [x + gx * unit, yTop + gy * unit]);
      polyline(pts, thick, c, a);
    }
    x += (4 + tracking) * unit;
  }
}

// ---------------------------------------------------------------------------
// Palette (vintage glossy travel poster).
// ---------------------------------------------------------------------------
const INK: RGB = [27, 20, 64];        // deep indigo
const CREAM: RGB = [255, 243, 214];   // poster cream
const PEACH: RGB = [255, 158, 94];
const ROSE: RGB = [201, 79, 109];
const VIOLET: RGB = [91, 42, 110];
const SUN: RGB = [255, 217, 122];
const TEAL: RGB = [47, 168, 160];
const SEA_DEEP: RGB = [11, 58, 77];
const SEA_MID: RGB = [20, 96, 110];
const ICE_LIT: RGB = [223, 242, 251];
const ICE_MID: RGB = [168, 212, 236];
const ICE_SHADOW: RGB = [111, 168, 216];
const ICE_DARK: RGB = [74, 127, 184];
const SNOW: RGB = [255, 255, 255];
const RED: RGB = [214, 69, 69];
const WARM: RGB = [255, 233, 168];

// ---------------------------------------------------------------------------
// 1. SKY — layered dusk gradient, sun glow, stars, aurora, clouds.
// ---------------------------------------------------------------------------
vGradient([
  [0.00, [24, 16, 58]],
  [0.28, [58, 30, 96]],
  [0.48, [122, 52, 110]],
  [0.62, [201, 79, 109]],
  [0.70, [255, 158, 94]],
  [0.72, [255, 190, 120]],
  [1.00, [255, 190, 120]],
], 0, 730);

// Sun glow (drawn behind the iceberg): concentric halos, then the disc.
for (let i = 12; i >= 1; i--) {
  const r = 78 + i * 14;
  fillCircle(196, 606, r, PEACH, 0.05);
}
fillCircle(196, 606, 92, SUN, 0.55);
fillCircle(196, 606, 84, [255, 226, 150], 0.9);
fillCircle(196, 606, 78, SUN, 1);
// Retro cut-lines across the sun disc only (clipped to the disc's chords).
fillRect(122, 590, 270, 594, [58, 30, 96], 0.85);
fillRect(120, 612, 272, 615, [122, 52, 110], 0.7);

// Stars in the upper sky (deterministic).
for (let i = 0; i < 150; i++) {
  const x = rand() * W;
  const y = rand() * 400;
  const r = 0.7 + rand() * 1.6;
  const a = 0.35 + rand() * 0.6;
  fillCircle(x, y, r, CREAM, a);
  if (rand() < 0.12) { // four-point sparkle on a few stars
    thickLine(x - 5, y, x + 5, y, 1, CREAM, a * 0.8);
    thickLine(x, y - 5, x, y + 5, 1, CREAM, a * 0.8);
  }
}

// Aurora ribbon drawn in two side segments (left/right of the village on the
// berg top), using an absolute-x sine so the two halves stay in phase.
function auroraBand(yBase: number, amp: number, freq: number, phase: number, w: number, c: RGB, a: number): void {
  for (const [x0, x1] of [[-40, 384], [646, 1064]] as [number, number][]) {
    const pts: [number, number][] = [];
    for (let x = x0; x <= x1; x += 6) {
      pts.push([x, yBase + Math.sin(x * freq + phase) * amp]);
    }
    polyline(pts, w, c, a);
  }
}

// Aurora ribbons: layered translucent bands in the clear sky gap between the
// subtitle and the iceberg top (y ~268-308), so they never cross the type.
auroraBand(282, 9, 0.0091, 0.4, 26, [95, 242, 200], 0.20);
auroraBand(282, 9, 0.0091, 0.4, 9, [157, 255, 110], 0.28);
auroraBand(296, 7, 0.012, 2.2, 18, [95, 242, 200], 0.16);
auroraBand(296, 7, 0.012, 2.2, 6, [190, 255, 150], 0.24);
auroraBand(268, 6, 0.007, 4.0, 12, [140, 120, 255], 0.14);

// Flat vintage clouds (ellipse clusters), peach-cream.
function cloud(cx: number, cy: number, s: number, c: RGB, a: number): void {
  fillEllipse(cx, cy, 74 * s, 20 * s, c, a);
  fillEllipse(cx - 52 * s, cy + 8 * s, 44 * s, 15 * s, c, a);
  fillEllipse(cx + 56 * s, cy + 9 * s, 48 * s, 15 * s, c, a);
  fillEllipse(cx + 6 * s, cy - 12 * s, 40 * s, 16 * s, c, a);
}
cloud(830, 300, 1.0, [255, 214, 170], 0.55);
cloud(150, 420, 0.8, [255, 190, 150], 0.45);
cloud(880, 470, 0.7, [255, 200, 160], 0.4);
cloud(120, 210, 0.6, [210, 160, 220], 0.4);

// ---------------------------------------------------------------------------
// 2. SEA — deep teal gradient, wave strokes, sun reflection, sparkles.
// ---------------------------------------------------------------------------
for (let y = 700; y < H; y++) {
  const t = (y - 700) / (H - 700 - 1);
  const c = mix(SEA_MID, SEA_DEEP, Math.min(1, t * 1.15));
  for (let x = 0; x < W; x++) setPx(x, y, c);
}
// Horizon glow band.
for (let y = 700; y < 730; y++) {
  const a = 0.5 * (1 - (y - 700) / 30);
  for (let x = 0; x < W; x++) blendPx(x, y, [255, 170, 110], a);
}
// Sun reflection column on the water.
for (let i = 0; i < 26; i++) {
  const y = 724 + i * 11;
  const wdt = 26 + i * 4.5 + rand() * 26;
  const x0 = 196 - wdt / 2 + (rand() - 0.5) * 14;
  thickLine(x0, y, x0 + wdt, y, 3.5, WARM, 0.5 - i * 0.012);
}
// Wave strokes, denser toward the bottom.
for (let row = 0; row < 15; row++) {
  const y = 726 + row * 19 + (rand() - 0.5) * 6;
  const amp = 3 + rand() * 5;
  const waves = 4 + Math.floor(rand() * 5);
  sineStroke(-20, 1044, y, amp, waves, rand() * 6, 2.5, TEAL, 0.28 + rand() * 0.2);
}
// Short white wave dashes.
for (let i = 0; i < 90; i++) {
  const x = rand() * W;
  const y = 720 + rand() * 290;
  const len = 8 + rand() * 26;
  thickLine(x, y, x + len, y + (rand() - 0.5) * 3, 2, [214, 240, 248], 0.25 + rand() * 0.3);
}
// Sparkles on the water.
for (let i = 0; i < 70; i++) {
  fillCircle(rand() * W, 720 + rand() * 290, 0.8 + rand() * 1.4, WARM, 0.3 + rand() * 0.5);
}

// ---------------------------------------------------------------------------
// 3. THE ICEBERG — one great berg rising out of the sea into the sky,
//    carrying a lighthouse village on its flat top.
// ---------------------------------------------------------------------------
const TOP_L: [number, number] = [392, 312];
const TOP_R: [number, number] = [640, 312];
const RIDGE_TOP: [number, number] = [512, 312];
const RIDGE_BOT: [number, number] = [524, 856];
// Silhouette.
const berg: [number, number][] = [
  TOP_L, [306, 470], [258, 640], [296, 792], [348, 856],
  [692, 856], [724, 800], [766, 640], [736, 432], TOP_R,
];
fillPoly(berg, ICE_MID, 1);
// Left face (sunlit) and right face (shadowed) split by the ridge.
fillPoly([TOP_L, RIDGE_TOP, RIDGE_BOT, [348, 856], [296, 792], [258, 640], [306, 470]], ICE_LIT, 1);
fillPoly([RIDGE_TOP, TOP_R, [736, 432], [766, 640], [724, 800], [692, 856], RIDGE_BOT], ICE_SHADOW, 1);
// Bright facet on the lit face, dark facet on the shadow face.
fillPoly([TOP_L, RIDGE_TOP, [452, 560], [400, 560]], [242, 251, 255], 0.9);
fillPoly([[430, 560], [452, 560], [400, 800], [330, 800]], [190, 224, 244], 0.8);
fillPoly([RIDGE_TOP, TOP_R, [628, 560], [560, 560]], ICE_DARK, 0.85);
fillPoly([[560, 560], [628, 560], [660, 800], [600, 800]], [92, 146, 200], 0.7);
// Ridge highlight + facet seams.
thickLine(512, 312, 524, 856, 3, SNOW, 0.85);
thickLine(392, 312, 452, 560, 2.5, SNOW, 0.6);
thickLine(640, 312, 628, 560, 2.5, [210, 230, 245], 0.55);
thickLine(306, 470, 452, 560, 2, [200, 228, 245], 0.5);
thickLine(736, 432, 560, 560, 2, [160, 195, 225], 0.5);
// Snow cap along the flat top (wavy bottom edge).
fillPoly([[392, 312], [640, 312], [628, 336], [560, 326], [512, 340], [452, 328], [404, 338]], SNOW, 1);
// Icicles dripping from the left and right edges.
for (const [ix, iy, len] of [[330, 430, 26], [288, 560, 34], [272, 690, 22], [716, 500, 30], [748, 620, 26]] as [number, number, number][]) {
  fillPoly([[ix - 7, iy], [ix + 7, iy], [ix, iy + len]], [235, 248, 255], 0.95);
}
// Cracks on the faces.
polyline([[360, 640], [400, 700], [380, 760]], 2, [150, 190, 220], 0.7);
polyline([[680, 500], [650, 580], [690, 660]], 2, [120, 160, 200], 0.6);
// Submerged ghost of the berg below the waterline (it sits IN the sea).
fillPoly([[372, 856], [668, 856], [622, 922], [418, 922]], ICE_SHADOW, 0.32);
fillPoly([[372, 856], [520, 856], [500, 922], [418, 922]], ICE_MID, 0.22);
thickLine(348, 856, 692, 856, 2.5, [232, 246, 252], 0.6);
// Foam + wave rings where the berg meets the sea.
for (const [fx, fy, frx] of [[520, 856, 300], [520, 872, 330], [520, 890, 350]] as [number, number, number][]) {
  for (let a = 0; a < Math.PI; a += 0.03) {
    const x = fx + Math.cos(a) * frx;
    const y = fy + Math.sin(a) * 10;
    fillCircle(x, y, 2.2, [232, 246, 252], 0.5);
  }
}
for (let i = 0; i < 40; i++) {
  fillCircle(300 + rand() * 440, 852 + rand() * 26, 1.5 + rand() * 2.5, SNOW, 0.5 + rand() * 0.4);
}

// Small floating ice floes in the foreground.
function floe(cx: number, cy: number, s: number): void {
  fillPoly([[cx - 52 * s, cy], [cx - 20 * s, cy - 12 * s], [cx + 30 * s, cy - 10 * s], [cx + 56 * s, cy], [cx + 20 * s, cy + 8 * s], [cx - 28 * s, cy + 9 * s]], ICE_LIT, 1);
  fillPoly([[cx - 20 * s, cy - 12 * s], [cx + 30 * s, cy - 10 * s], [cx + 20 * s, cy + 8 * s], [cx - 28 * s, cy + 9 * s]], ICE_MID, 0.8);
  fillCircle(cx - 8 * s, cy - 4 * s, 3 * s, SNOW, 0.9);
}
floe(150, 950, 1.0);
floe(880, 930, 0.85);
floe(820, 990, 0.6);
floe(210, 990, 0.55);

// ---------------------------------------------------------------------------
// 4. THE VILLAGE ON TOP — lighthouse + cottages with lit windows.
// ---------------------------------------------------------------------------
// Cottages (left of the lighthouse).
function cottage(x: number, yBase: number, s: number, wall: RGB, roof: RGB): void {
  fillRect(x, yBase - 22 * s, x + 34 * s, yBase, wall, 1);
  fillPoly([[x - 3 * s, yBase - 22 * s], [x + 17 * s, yBase - 38 * s], [x + 37 * s, yBase - 22 * s]], roof, 1);
  fillRect(x + 6 * s, yBase - 14 * s, x + 12 * s, yBase - 6 * s, WARM, 1);
  fillRect(x + 22 * s, yBase - 14 * s, x + 28 * s, yBase, INK, 1);
  fillRect(x + 26 * s, yBase - 34 * s, x + 31 * s, yBase - 24 * s, INK, 1);
  // Chimney smoke curls.
  fillCircle(x + 28 * s, yBase - 42 * s, 3, CREAM, 0.55);
  fillCircle(x + 31 * s, yBase - 50 * s, 4, CREAM, 0.4);
  fillCircle(x + 35 * s, yBase - 58 * s, 5, CREAM, 0.28);
}
cottage(408, 312, 1.0, [244, 230, 200], RED);
cottage(452, 312, 0.9, [240, 222, 190], [70, 110, 160]);
cottage(494, 312, 0.8, [244, 230, 200], [198, 120, 60]);

// Lighthouse (right end of the plateau).
fillPoly([[586, 312], [622, 312], [616, 240], [592, 240]], [244, 241, 230], 1);
fillRect(588, 258, 620, 272, RED, 1);
fillRect(590, 286, 618, 300, RED, 1);
fillRect(588, 228, 620, 240, INK, 1);          // gallery
fillRect(596, 208, 612, 228, [40, 44, 70], 1); // lamp room
fillCircle(604, 218, 7, WARM, 1);              // lamp
fillPoly([[592, 208], [616, 208], [604, 196]], RED, 1); // dome cap
// Light beam sweeping right into the sky.
fillPoly([[612, 214], [860, 172], [860, 250]], WARM, 0.20);
fillPoly([[612, 214], [860, 192], [860, 230]], WARM, 0.18);
// Lamp glow halo.
fillCircle(604, 218, 16, WARM, 0.35);
fillCircle(604, 218, 26, WARM, 0.15);

// Gulls circling the berg.
function gull(x: number, y: number, s: number): void {
  thickLine(x - 9 * s, y - 4 * s, x, y, 2.4, INK, 0.9);
  thickLine(x, y, x + 9 * s, y - 4 * s, 2.4, INK, 0.9);
}
gull(300, 300, 1.0); gull(350, 262, 0.8); gull(700, 280, 1.1);
gull(760, 330, 0.85); gull(250, 380, 0.9); gull(820, 380, 0.8);
gull(660, 210, 0.7); gull(430, 240, 0.75); gull(880, 250, 0.9);
gull(180, 330, 0.8);

// ---------------------------------------------------------------------------
// 5. TYPE — the invented place name, huge, plus one poetic line.
// ---------------------------------------------------------------------------
// Soft indigo drop shadow, then cream type.
drawText("KORVANE", 512, 42, 21, INK, 0.55);
drawText("KORVANE", 512, 36, 21, CREAM, 1);
// Divider: line — diamond — line under the title.
thickLine(332, 204, 478, 204, 2.5, CREAM, 0.9);
thickLine(546, 204, 692, 204, 2.5, CREAM, 0.9);
fillPoly([[512, 196], [520, 204], [512, 212], [504, 204]], CREAM, 1);
// Subtitle.
drawText("WHERE THE ICEBERGS LEARN TO FLY", 512, 226, 5.2, [255, 233, 190], 1);

// ---------------------------------------------------------------------------
// 6. FRAME + GRAIN — thin cream double border, subtle film grain.
// ---------------------------------------------------------------------------
function frameRect(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a: number): void {
  fillRect(x0, y0, x1, y0 + w, c, a);
  fillRect(x0, y1 - w, x1, y1, c, a);
  fillRect(x0, y0, x0 + w, y1, c, a);
  fillRect(x1 - w, y0, x1, y1, c, a);
}
frameRect(18, 18, 1006, 1006, 3, CREAM, 0.95);
frameRect(28, 28, 996, 996, 1, CREAM, 0.5);

// Deterministic film grain: a 128x128 tile, tiled over the canvas.
const TILE = 128;
const tile = new Int8Array(TILE * TILE);
for (let i = 0; i < tile.length; i++) tile[i] = Math.floor((rand() - 0.5) * 11);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const g = tile[(y % TILE) * TILE + (x % TILE)];
    if (g === 0) continue;
    const i = (y * W + x) * 3;
    px[i] = clamp(px[i] + g);
    px[i + 1] = clamp(px[i + 1] + g);
    px[i + 2] = clamp(px[i + 2] + g);
  }
}

// ---------------------------------------------------------------------------
// PNG ENCODER — raw RGB scanlines (filter 0), zlib level 9, CRC32.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function encodePNG(): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: None
    raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(dirname(OUT), { recursive: true });
const png = encodePNG();
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes, ${W}x${H})`);
