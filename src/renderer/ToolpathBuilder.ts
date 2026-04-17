// ─── Toolpath Builder ─────────────────────────────────────────────────────────
// Converts parsed G-code commands into flat Float32Array geometry data plus
// prefix-sum maps so the renderer can reveal the path in O(1) per step.

import type { GCodeCommand } from '../parser/GCodeParser.ts';
import type { MachineMode } from '../simulator/MachineState.ts';

export interface ToolpathData {
  /** Flat position buffer for G0 rapid moves: [x0,y0,z0, x1,y1,z1, ...] */
  rapidPositions: Float32Array;
  /** Flat position buffer for G1/G2/G3 cutting moves */
  cutPositions:   Float32Array;
  /** Vertex colours (RGB) per cut vertex — used for printer layer colours */
  cutColors:      Float32Array;

  /**
   * Prefix-sum arrays indexed by commandIndex.
   * rapidVertexCount[i] = total rapid *vertices* (not segments) after command i-1.
   * i.e. "how many rapid vertices are visible when sim cursor is at command i"
   */
  rapidVertexCount: Int32Array;
  cutVertexCount:   Int32Array;

  /** World-space bounding box */
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];

  /** Machine mode this data was built for */
  machineMode: MachineMode;
}

// ─────────────────────────────────────────────────────────────────────────────

interface Vec3 { x: number; y: number; z: number; }

function vec3(x: number, y: number, z: number): Vec3 { return { x, y, z }; }
function dist2(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Tessellate a G2/G3 arc into a sequence of points (includes start point). */
function tessellateArc(
  start:  Vec3,
  end:    Vec3,
  /** Center offset from start (I,J,K in incremental arc mode) */
  ci: number, cj: number, ck: number,
  clockwise: boolean,
  plane: 17 | 18 | 19,
): Vec3[] {
  // Extract the two planar axes + linear axis
  let sx: number, sy: number, ex: number, ey: number,
      cx: number, cy: number, linearStart: number, linearEnd: number;

  if (plane === 17) {       // XY
    sx = start.x; sy = start.y; ex = end.x; ey = end.y;
    cx = start.x + ci;     cy = start.y + cj;
    linearStart = start.z; linearEnd = end.z;
  } else if (plane === 18) { // XZ
    sx = start.x; sy = start.z; ex = end.x; ey = end.z;
    cx = start.x + ci;     cy = start.z + ck;
    linearStart = start.y; linearEnd = end.y;
  } else {                  // YZ (G19)
    sx = start.y; sy = start.z; ex = end.y; ey = end.z;
    cx = start.y + cj;     cy = start.z + ck;
    linearStart = start.x; linearEnd = end.x;
  }

  const radius = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
  if (radius < 1e-9) return [start, end]; // degenerate

  const startAngle = Math.atan2(sy - cy, sx - cx);
  const endAngle   = Math.atan2(ey - cy, ex - cx);

  // Detect full circle
  const isFullCircle =
    Math.abs(sx - ex) < 1e-6 && Math.abs(sy - ey) < 1e-6;

  let sweep: number;
  if (isFullCircle) {
    sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
  } else if (clockwise) {
    sweep = endAngle - startAngle;
    if (sweep >= 0) sweep -= 2 * Math.PI;
  } else {
    sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += 2 * Math.PI;
  }

  const arcLen = Math.abs(sweep) * radius;
  const nSeg   = Math.max(8, Math.ceil(arcLen / 0.5));
  const pts: Vec3[] = [];

  for (let i = 0; i <= nSeg; i++) {
    const t     = i / nSeg;
    const angle = startAngle + sweep * t;
    const px    = cx + radius * Math.cos(angle);
    const py    = cy + radius * Math.sin(angle);
    const lin   = linearStart + (linearEnd - linearStart) * t;

    let p: Vec3;
    if (plane === 17)      p = vec3(px, py, lin);
    else if (plane === 18) p = vec3(px, lin, py);
    else                   p = vec3(lin, px, py);

    pts.push(p);
  }
  return pts;
}

/** Map a Z height in [zMin, zMax] to an RGB colour for printer mode. */
function zToColor(z: number, zMin: number, zRange: number): [number, number, number] {
  const t = zRange > 0 ? Math.max(0, Math.min(1, (z - zMin) / zRange)) : 0;
  // Blue → Cyan → Green → Yellow → Red
  if (t < 0.25) {
    const s = t / 0.25;
    return [0, s, 1];
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return [0, 1, 1 - s];
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return [s, 1, 0];
  } else {
    const s = (t - 0.75) / 0.25;
    return [1, 1 - s, 0];
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildToolpath(
  commands:    GCodeCommand[],
  machineMode: MachineMode,
): ToolpathData {
  // ── State machine ─────────────────────────────────────────
  let px = 0, py = 0, pz = 0;     // current position
  let motionMode: 0 | 1 | 2 | 3 = 0;
  let planeSelect: 17 | 18 | 19  = 17;
  let distanceMode: 90 | 91      = 90;

  // Temporary segment lists
  const rapidPts:  number[] = [];  // pairs of [sx,sy,sz, ex,ey,ez]
  const cutPts:    number[] = [];
  const cutZs:     number[] = [];  // Z of each cut segment's midpoint

  // Per-command vertex counts — filled as we go
  const rapidPerCmd = new Int32Array(commands.length);
  const cutPerCmd   = new Int32Array(commands.length);

  function addRapid(from: Vec3, to: Vec3) {
    rapidPts.push(from.x, from.y, from.z, to.x, to.y, to.z);
  }
  function addCut(pts: Vec3[]) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      cutPts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      cutZs.push((a.z + b.z) / 2);
    }
  }

  for (let ci = 0; ci < commands.length; ci++) {
    const cmd = commands[ci];

    const rapidBefore = rapidPts.length / 3;
    const cutBefore   = cutPts.length   / 3;

    // ── Modal updates ────────────────────────────────────────
    if (cmd.G !== undefined) {
      const g = Math.floor(cmd.G);
      if (g === 17) planeSelect   = 17;
      else if (g === 18) planeSelect = 18;
      else if (g === 19) planeSelect = 19;
      else if (g === 90) distanceMode = 90;
      else if (g === 91) distanceMode = 91;
      else if (g >= 0 && g <= 3) motionMode = g as 0 | 1 | 2 | 3;
    }

    // ── Compute target position ──────────────────────────────
    const abs = distanceMode === 90;
    let tx = px, ty = py, tz = pz;
    if (cmd.X !== undefined) tx = abs ? cmd.X : px + cmd.X;
    if (cmd.Y !== undefined) ty = abs ? cmd.Y : py + cmd.Y;
    if (cmd.Z !== undefined) tz = abs ? cmd.Z : pz + cmd.Z;

    const hasMotion =
      cmd.X !== undefined || cmd.Y !== undefined || cmd.Z !== undefined;

    // Determine the active motion mode for this block
    const mg =
      cmd.G !== undefined && cmd.G >= 0 && cmd.G <= 3
        ? (cmd.G as 0 | 1 | 2 | 3)
        : motionMode;

    if (hasMotion) {
      const from = vec3(px, py, pz);
      const to   = vec3(tx, ty, tz);

      if (mg === 0) {
        // Rapid — only add if there's actual movement
        if (dist2(from, to) > 1e-6) addRapid(from, to);
      } else if (mg === 1) {
        // Linear feed
        if (dist2(from, to) > 1e-6) addCut([from, to]);
      } else if (mg === 2 || mg === 3) {
        // Arc
        const ci = cmd.I ?? 0;
        const cj = cmd.J ?? 0;
        const ck = cmd.K ?? 0;
        const pts = tessellateArc(from, to, ci, cj, ck, mg === 2, planeSelect);
        if (pts.length >= 2) addCut(pts);
      }

      px = tx; py = ty; pz = tz;
    }

    // G28 home
    if (cmd.G === 28) { px = 0; py = 0; pz = 0; }

    rapidPerCmd[ci] = (rapidPts.length / 3) - rapidBefore;
    cutPerCmd[ci]   = (cutPts.length   / 3) - cutBefore;
  }

  // ── Build prefix sums ──────────────────────────────────────
  const rapidVertexCount = new Int32Array(commands.length + 1);
  const cutVertexCount   = new Int32Array(commands.length + 1);
  for (let i = 0; i < commands.length; i++) {
    rapidVertexCount[i + 1] = rapidVertexCount[i] + rapidPerCmd[i];
    cutVertexCount[i + 1]   = cutVertexCount[i]   + cutPerCmd[i];
  }

  // ── Compute bounds ─────────────────────────────────────────
  const allPts = [...rapidPts, ...cutPts];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < allPts.length; i += 3) {
    const x = allPts[i], y = allPts[i+1], z = allPts[i+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) { minX = -10; minY = -10; minZ = -10; maxX = 10; maxY = 10; maxZ = 10; }

  // ── Build cut vertex colours ───────────────────────────────
  const nCutVerts = cutPts.length / 3;
  const cutColors = new Float32Array(nCutVerts * 3);
  const zRange    = maxZ - minZ;

  if (machineMode === 'printer') {
    for (let i = 0; i < cutZs.length; i++) {
      // Each cut segment = 2 vertices at positions i*2 and i*2+1
      const [r, g, b] = zToColor(cutZs[i], minZ, zRange);
      const vi0 = i * 2 * 3;
      const vi1 = vi0 + 3;
      cutColors[vi0]   = r; cutColors[vi0+1] = g; cutColors[vi0+2] = b;
      cutColors[vi1]   = r; cutColors[vi1+1] = g; cutColors[vi1+2] = b;
    }
  } else {
    // Uniform cyan: 0.0, 0.83, 1.0
    for (let i = 0; i < cutColors.length; i += 3) {
      cutColors[i] = 0.0; cutColors[i+1] = 0.83; cutColors[i+2] = 1.0;
    }
  }

  return {
    rapidPositions:  new Float32Array(rapidPts),
    cutPositions:    new Float32Array(cutPts),
    cutColors,
    rapidVertexCount,
    cutVertexCount,
    boundsMin: [minX, minY, minZ],
    boundsMax: [maxX, maxY, maxZ],
    machineMode,
  };
}
