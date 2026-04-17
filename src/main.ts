// ─── G-Code Simulator — Main Entry ───────────────────────────────────────────

import './styles/main.css';
import { parseGCode, computeStats } from './parser/GCodeParser.ts';
import { buildToolpath } from './renderer/ToolpathBuilder.ts';
import { Renderer3D } from './renderer/Renderer3D.ts';
import { ViewCube } from './renderer/ViewCube.ts';
import { StockSimulator } from './renderer/StockSimulator.ts';
import { GCodeEditor } from './editor/GCodeEditor.ts';
import { Simulator } from './simulator/Simulator.ts';
import { DRO } from './ui/DRO.ts';
import { Controls } from './ui/Controls.ts';
import type { MachineMode } from './simulator/MachineState.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Demo G-code program (shown on first load)
// ─────────────────────────────────────────────────────────────────────────────

function generateDemo(): string {
  const lines: string[] = [
    '; ========================================',
    '; G-Code Simulator — Demo Program',
    '; Features: G0/G1 moves, G2/G3 arcs, modal',
    '; ========================================',
    'G21        ; Millimeters',
    'G90        ; Absolute mode',
    'G17        ; XY plane',
    'M3 S2000   ; Spindle on',
    '',
    '; --- Outer frame ---',
    'G0 Z5.0',
    'G0 X-60 Y-60',
    'G1 Z-2.0 F400',
    'G1 X60  Y-60 F1200',
    'G1 X60  Y60',
    'G1 X-60 Y60',
    'G1 X-60 Y-60',
    'G0 Z5.0',
    '',
    '; --- Corner radii (G2) ---',
    'G0 X-50 Y-60',
    'G1 Z-1.5 F400',
    'G1 X-60 Y-50 F1000',
    'G0 Z5.0',
    'G0 X50  Y-60',
    'G1 Z-1.5 F400',
    'G1 X60  Y-50 F1000',
    'G0 Z5.0',
    '',
    '; --- Concentric circles ---',
  ];

  for (let r = 8; r <= 48; r += 8) {
    lines.push(`G0 X${r} Y0`);
    lines.push('G1 Z-1.0 F400');
    lines.push(`G2 X${r} Y0 I${-r} J0 F1000`);
    lines.push('G0 Z5.0');
  }

  lines.push('');
  lines.push('; --- Counter-clockwise circles (inner) ---');
  for (let r = 4; r <= 20; r += 8) {
    lines.push(`G0 X${r} Y0`);
    lines.push('G1 Z-0.5 F400');
    lines.push(`G3 X${r} Y0 I${-r} J0 F800`);
    lines.push('G0 Z5.0');
  }

  lines.push('');
  lines.push('; --- Diagonal cross ---');
  lines.push('G0 X-55 Y-55');
  lines.push('G1 Z-1.0 F400');
  lines.push('G1 X55 Y55 F1200');
  lines.push('G0 Z5.0');
  lines.push('G0 X55 Y-55');
  lines.push('G1 Z-1.0 F400');
  lines.push('G1 X-55 Y55 F1200');
  lines.push('G0 Z5.0');

  lines.push('');
  lines.push('; --- Spiral ---');
  lines.push('G0 X5 Y0');
  lines.push('G1 Z-0.5 F400');
  const nSpiralPts = 180;
  for (let i = 1; i <= nSpiralPts; i++) {
    const t = i / nSpiralPts;
    const angle = t * 6 * Math.PI;
    const r = 5 + t * 40;
    const x = +(r * Math.cos(angle)).toFixed(3);
    const y = +(r * Math.sin(angle)).toFixed(3);
    const z = +(-0.5 - t * 1.5).toFixed(3);
    lines.push(`G1 X${x} Y${y} Z${z} F${Math.round(800 + t * 400)}`);
  }
  lines.push('G0 Z5.0');

  lines.push('');
  lines.push('; --- Finish ---');
  lines.push('G0 X0 Y0 Z10');
  lines.push('M5         ; Spindle off');
  lines.push('M2         ; End program');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// App bootstrap
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ── Tool Library ────────────────────────────────────────────────────────────

let currentUnit: 'mm' | 'inch' = 'inch';

export type ToolType = 'endmill' | 'ballmill' | 'drill' | 'spotdrill' | 'chamfer' | 'bullnose' | 'facemill';

export const TOOL_TYPE_LABELS: Record<ToolType, string> = {
  endmill:   'End Mill',
  ballmill:  'Ball Mill',
  drill:     'Drill',
  spotdrill: 'Spot Drill',
  chamfer:   'Chamfer Mill',
  bullnose:  'Bull Nose',
  facemill:  'Face Mill',
};

interface ToolDef { num: number; type: ToolType; diameter: number; loc: number; cornerRadius: number; }
const toolLib: ToolDef[] = [
  { num: 1, type: 'endmill',  diameter: 0.5  * 25.4, loc: 1.0 * 25.4, cornerRadius: 0 },  // 1/2" EM, 1" LOC
  { num: 2, type: 'ballmill', diameter: 0.25 * 25.4, loc: 0.5 * 25.4, cornerRadius: 0 },  // 1/4" BM, 1/2" LOC
];

/**
 * Try to extract a tool diameter (in mm) from a G-code comment.
 * Handles common CAM output formats including Mastercam shop-style headers.
 * Returns diameter in mm, or undefined if not found.
 */
function detectToolDiameter(comment: string | undefined): number | undefined {
  if (!comment) return undefined;
  // Strip leading "T301 - " or "T1 | " or "T13 | " prefix (dash or pipe separators)
  const c = comment.replace(/^\s*T\d+\s*[-–|]?\s*/i, '').replace(/^\|\s*/, '').trim();

  // Highest priority: explicit D0.7500" or D2.0000" (inch symbol confirms unit)
  let m = c.match(/\bD([\d.]+)"/);
  if (m) { const v = parseFloat(m[1]); if (v > 0 && v <= 30) return v * 25.4; }

  // Mastercam explicit: "TOOL DIA. - .75"
  m = c.match(/TOOL\s+DIA\.?\s*[-–]?\s*([\d.]+)/i);
  if (m) { const v = parseFloat(m[1]); if (v > 0) return v * 25.4; }

  // "2.0 DIA ..." or ".4375 DIA ..."
  m = c.match(/^([\d]*\.[\d]+|[\d]+\.[\d]*)\s+DIA\b/i);
  if (m) { const v = parseFloat(m[1]); if (v > 0 && v <= 30) return v * 25.4; }

  // Fusion 360 / HSMWorks: D=6.35 (mm, no inch symbol)
  m = c.match(/\bD\s*=\s*([\d.]+)/i);
  if (m) return parseFloat(m[1]);

  // DIA=8 or DIAMETER=12.7 (mm)
  m = c.match(/\bDIA(?:METER)?\s*=\s*([\d.]+)/i);
  if (m) return parseFloat(m[1]);

  // Fractional inch at start: 1/4, 7/16, 3/8 ...
  m = c.match(/^(\d+)\s*\/\s*(\d+)/);
  if (m) return (parseInt(m[1]) / parseInt(m[2])) * 25.4;

  // Decimal with explicit inch unit: 0.500" or 0.500 inch
  m = c.match(/\b([\d.]+)\s*(?:"|inch|in\b)/i);
  if (m) { const v = parseFloat(m[1]); if (v > 0 && v <= 30) return v * 25.4; }

  // Millimetre explicit: 6mm or 6 mm
  m = c.match(/\b([\d.]+)\s*mm\b/i);
  if (m) return parseFloat(m[1]);

  // Bare decimal at start of comment (Mastercam shop format):
  // ".443 CARBIDE COOLANT DRILL" / ".7500 C-B 3F ..."
  m = c.match(/^([\d]*\.[\d]+|[\d]+\.[\d]*)\s+\S/);
  if (m) { const v = parseFloat(m[1]); if (v > 0 && v <= 4) return v * 25.4; }

  return undefined;
}

/**
 * Try to extract a corner radius (in mm) from a G-code comment.
 * Handles: W/.125CR  /  CR=0.5  /  .008CR
 */
function detectCornerRadius(comment: string | undefined): number | undefined {
  if (!comment) return undefined;
  const c = comment.replace(/^\s*T\d+\s*[-–|]?\s*/i, '').replace(/^\|\s*/, '');

  // W/.125CR  or  W/.008CR  (Mastercam style)
  let m = c.match(/W\/([\d.]+)CR/i);
  if (m) { const v = parseFloat(m[1]); if (v > 0) return v * 25.4; }

  // CR=0.5 or CR=.062
  m = c.match(/\bCR\s*=\s*([\d.]+)/i);
  if (m) { const v = parseFloat(m[1]); if (v > 0) return v * 25.4; }

  // .062 RAD (corner rounder style)
  m = c.match(/([\d.]+)\s*RAD\b/i);
  if (m) { const v = parseFloat(m[1]); if (v > 0) return v * 25.4; }

  // R.045 or R0.030 — standalone R<decimal> not followed by more digits (tool radius shorthand)
  m = c.match(/\bR([\d]*\.[\d]+)\b/);
  if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 2) return v * 25.4; }

  return undefined;
}

function detectToolType(comment: string | undefined): ToolType {
  if (!comment) return 'endmill';
  const c = comment.toLowerCase();
  if (/ball\s*mill|ballmill/.test(c))                        return 'ballmill';
  if (/bull|corner.?round|corner.?rad|w\/[\d.]+cr/i.test(c)) return 'bullnose';
  if (/spot.?drill|center.?drill/.test(c))                   return 'spotdrill';
  if (/chamfer|v.?bit|vbit|engraver/.test(c))                return 'chamfer';
  if (/face.?mill|facemill/.test(c))                         return 'facemill';
  if (/ball/.test(c))                                        return 'ballmill';
  // Drill: match drill but exclude "spot drill" (already caught) and taps
  if (/drill/.test(c) && !/tap/.test(c))                     return 'drill';
  return 'endmill';
}

function syncToolLibFromCommands(cmds: ReturnType<typeof parseGCode>): void {
  // Build map of toolNum → comment from the line that calls T or M6 nearby
  const toolComments = new Map<number, string>();

  // Pass 1: scan pure comment lines for embedded T-numbers
  // e.g. (T301 - 2.0 DIA SHEAR HOG - H301 - D301 - D2.0000" - R0.0300")
  for (const cmd of cmds) {
    if (cmd.T === undefined && cmd.comment) {
      const m = cmd.comment.match(/\bT(\d+)\b/i);
      if (m) {
        const num = parseInt(m[1], 10);
        if (!toolComments.has(num)) toolComments.set(num, cmd.comment);
      }
    }
  }

  // Pass 2: T-word on motion/M6 lines (overrides comment-only if found later)
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i];
    if (cmd.T !== undefined) {
      const comment = cmd.comment ?? cmds[i + 1]?.comment ?? '';
      // Only override if we have a richer comment (contains diameter hint)
      if (!toolComments.has(cmd.T) || comment.match(/DIA|D[\d.]+"|R[\d.]+"/i)) {
        toolComments.set(cmd.T, comment || toolComments.get(cmd.T) || '');
      }
    }
  }

  let added = false;
  for (const [num, comment] of [...toolComments.entries()].sort((a, b) => a[0] - b[0])) {
    const detectedDia  = detectToolDiameter(comment);
    const detectedType = detectToolType(comment);
    const detectedCr   = detectCornerRadius(comment);
    const existing = toolLib.find(t => t.num === num);
    if (!existing) {
      toolLib.push({
        num,
        type: detectedType,
        diameter: detectedDia ?? 6,
        loc: detectedDia ? Math.round(detectedDia * 2) : 12,
        cornerRadius: detectedCr ?? 0,
      });
      added = true;
    } else {
      // Update fields only if still at defaults (not user-edited)
      if (existing.type === 'endmill' && detectedType !== 'endmill') existing.type = detectedType;
      if (existing.diameter === 6 && detectedDia !== undefined) {
        existing.diameter = detectedDia;
        existing.loc = Math.round(detectedDia * 3.5);
      }
      if (existing.cornerRadius === 0 && detectedCr !== undefined) {
        existing.cornerRadius = detectedCr;
      }
    }
  }
  if (added) toolLib.sort((a, b) => a.num - b.num);
}

function getToolDef(toolNum: number): ToolDef {
  return toolLib.find(t => t.num === toolNum) ?? toolLib[0] ?? { num:0, type:'endmill', diameter:6, loc:21, cornerRadius:0 };
}
function getToolRadius(toolNum: number): number {
  return getToolDef(toolNum).diameter / 2;
}

function renderToolTable(activeTool: number) {
  const tbody = document.getElementById('tool-tbody')!;
  tbody.innerHTML = '';
  const isInch = currentUnit === 'inch';
  const step = isInch ? '0.0001' : '0.01';
  const dec  = isInch ? 4 : 3;
  toolLib.forEach((t, idx) => {
    const tr = document.createElement('tr');
    if (t.num === activeTool) tr.classList.add('active-tool');
    const dispDia = isInch ? (t.diameter / 25.4).toFixed(dec) : t.diameter.toFixed(dec);
    const dispLoc = isInch ? (t.loc      / 25.4).toFixed(dec) : t.loc.toFixed(dec);
    const dispCr  = isInch ? (t.cornerRadius / 25.4).toFixed(dec) : t.cornerRadius.toFixed(dec);
    const typeOptions = (Object.keys(TOOL_TYPE_LABELS) as ToolType[])
      .map(k => `<option value="${k}"${k === t.type ? ' selected' : ''}>${TOOL_TYPE_LABELS[k]}</option>`)
      .join('');
    tr.innerHTML = `
      <td class="col-num">
        <span class="tool-t-badge">T${t.num}</span>
      </td>
      <td class="col-name">
        <select class="tool-input tool-type-select" data-idx="${idx}" data-field="type">${typeOptions}</select>
      </td>
      <td class="col-dia">
        <input class="tool-input" type="number" min="0.0001" step="${step}" value="${dispDia}" data-idx="${idx}" data-field="diameter">
      </td>
      <td class="col-loc">
        <input class="tool-input" type="number" min="0.0001" step="${step}" value="${dispLoc}" data-idx="${idx}" data-field="loc">
      </td>
      <td class="col-del">
        <button class="btn-del-tool" data-idx="${idx}" title="Delete">✕</button>
      </td>`;
    tbody.appendChild(tr);
    if (t.type === 'bullnose') {
      const crTr = document.createElement('tr');
      crTr.className = 'cr-row';
      crTr.innerHTML = `
        <td class="col-num" style="color:var(--text-muted);font-size:11px;text-align:right;padding-right:6px;">CR</td>
        <td class="col-name" style="color:var(--text-muted);font-size:11px;">Corner Rad.</td>
        <td class="col-dia">
          <input class="tool-input" type="number" min="0" step="${step}" value="${dispCr}" data-idx="${idx}" data-field="cornerRadius">
        </td>
        <td class="col-loc"></td>
        <td class="col-del"></td>`;
      tbody.appendChild(crTr);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function main() {
  // ── Instantiate modules ────────────────────────────────────
  const canvas    = document.getElementById('three-canvas') as HTMLCanvasElement;
  const editorDiv = document.getElementById('editor-container') as HTMLElement;

  const renderer = new Renderer3D(canvas);
  const canvasContainer = document.getElementById('canvas-container') as HTMLElement;
  const viewCube = new ViewCube(canvasContainer, 100, (face) => renderer.snapCameraTo(face), () => renderer.snapIsometric());
  (function syncCube() {
    requestAnimationFrame(syncCube);
    renderer.syncViewCube(viewCube);
  })();

  const editor   = new GCodeEditor(editorDiv);
  const sim      = new Simulator('mill');
  const dro      = new DRO();
  const controls = new Controls(sim);

  let machineMode: MachineMode = 'mill';
  let followSim = true;

  // ── Stock simulation ───────────────────────────────────────
  // Resolution quality levels: cells-per-inch targets
  // The actual cell count scales with stock size so quality is consistent regardless of part size.
  const RES_CPI = [20, 40, 80, 160, 320]; // cells per inch at each quality level
  const RES_MAX = 2048;                     // hard cap to keep GPU/CPU load sane
  let resQuality = 2;  // default = 80 cpi (index 2)

  function calcStockRes(): number {
    const { sx, sy } = getStockInputs(); // mm
    const largerSideMM = Math.max(sx, sy, 1);
    const largerSideIn = largerSideMM / 25.4;
    const cpi = RES_CPI[resQuality];
    return Math.min(RES_MAX, Math.max(64, Math.ceil(largerSideIn * cpi)));
  }

  function updateResLabel() {
    const el = document.getElementById('stock-res-label');
    if (!el) return;
    const res = calcStockRes();
    const cpi = RES_CPI[resQuality];
    el.textContent = `${res}px`;
    const slider = document.getElementById('stock-res-slider') as HTMLInputElement | null;
    if (slider) slider.title = `${cpi} cells/inch → ${res}×${res} grid`;
  }

  let stockRes = 512;
  let stockSim = new StockSimulator(stockRes);
  let stockSimEnabled  = true;
  let stockSolidVisible = true;
  let stockWireVisible  = true;
  // Pending segments accumulated from onMotion; processed each RAF frame
  const pendingSegs: Array<[number,number,number, number,number,number, number, number]> = [];

  /**
   * Scanned unit mode of the currently-loaded program.
   * Set by loadProgram() by scanning commands for G20/G21.
   * Used everywhere we need to convert between mm (toolLib units) and G-code scene units.
   */
  let programUnitMode: 20 | 21 = 21;

  function getStockInputs() {
    const fromDisp = currentUnit === 'inch' ? (v: number) => v * 25.4 : (v: number) => v;
    const n = (id: string) => fromDisp(parseFloat((document.getElementById(id) as HTMLInputElement).value) || 0);
    const sx = n('stock-sx'), sy = n('stock-sy'), sz = n('stock-sz');
    const cx = n('stock-cx'), cy = n('stock-cy');
    // Z0 is always the top; stock descends downward from Z0
    return { sx, sy, sz, ox: cx - sx / 2, oy: cy - sy / 2, oz: -sz };
  }

  /**
   * Returns the factor to convert from mm (tool library units) to G-code scene units.
   * G20 (inch) programs: 1/25.4   G21 (mm) programs: 1
   */
  function mmToGcode() {
    return programUnitMode === 20 ? 1 / 25.4 : 1;
  }

  function applyStock(resetSim = true) {
    const { sx, sy, sz, ox, oy, oz } = getStockInputs(); // always mm
    const s = mmToGcode();
    stockRes = calcStockRes();
    if (resetSim) stockSim = new StockSimulator(stockRes);
    updateResLabel();
    // Convert to G-code units so stock mesh aligns with toolpath lines in the scene
    renderer.setStock(sx*s, sy*s, sz*s, ox*s, oy*s, oz*s, stockRes);
    renderer.setStockSolidVisible(stockSolidVisible);
    renderer.setStockWireVisible(stockWireVisible);
    if (resetSim) {
      stockSim.reset(sx*s, sy*s, sz*s, ox*s, oy*s, oz*s);
      renderer.resetStockSurface();
      pendingSegs.length = 0;
    }
  }

  /** Reset stock to clean then flush whatever is in pendingSegs (called after backward seek replays). */
  function flushStockReset() {
    if (!stockSimEnabled) return;
    const { sx, sy, sz, ox, oy, oz } = getStockInputs(); // mm
    const s = mmToGcode();
    stockSim.reset(sx*s, sy*s, sz*s, ox*s, oy*s, oz*s);
    renderer.resetStockSurface();
    pendingSegs.length = 0;
  }

  function autoSizeStock(tpData: ReturnType<typeof buildToolpath>) {
    const PAD_MM = 1.27; // 0.050"
    // Toolpath bounds are in G-code units; convert to mm for consistent storage.
    // Must use programUnitMode (scanned at load time) — sim.currentState is reset by sim.load().
    const toMM = programUnitMode === 20 ? 25.4 : 1;
    const [minX, minY, minZ] = tpData.boundsMin.map(v => v * toMM);
    const [maxX, maxY] = [tpData.boundsMax[0] * toMM, tpData.boundsMax[1] * toMM];
    // toDisp converts internal mm → display units
    const toDisp = currentUnit === 'inch' ? (v: number) => v / 25.4 : (v: number) => v;
    const decimals = currentUnit === 'inch' ? 4 : 2;
    const setVal = (id: string, v: number) => {
      const el = document.getElementById(id) as HTMLInputElement;
      el.value = toDisp(v).toFixed(decimals);
      el.step = currentUnit === 'inch' ? '0.001' : '1';
    };
    setVal('stock-sx', (maxX - minX) + PAD_MM * 2);
    setVal('stock-sy', (maxY - minY) + PAD_MM * 2);
    // Z0 = top of part; size = depth from Z0 down to deepest cut + pad
    setVal('stock-sz', Math.abs(minZ) + PAD_MM);
    // Center X/Y midpoints of toolpath bounds
    setVal('stock-cx', (minX + maxX) / 2);
    setVal('stock-cy', (minY + maxY) / 2);
  }

  // RAF loop: process pending stock segments and upload to GPU
  ;(function stockLoop() {
    requestAnimationFrame(stockLoop);
    if (!stockSimEnabled || pendingSegs.length === 0) return;
    const deadline = performance.now() + 10; // 10 ms budget per frame
    while (pendingSegs.length > 0 && performance.now() < deadline) {
      const [x0,y0,z0,x1,y1,z1,r,cr] = pendingSegs.shift()!;
      stockSim.applySweep(x0,y0,z0,x1,y1,z1,r,cr);
    }
    if (stockSim.dirty) {
      renderer.updateStockSurface(stockSim.heightMap, 10 * mmToGcode());
      stockSim.clearDirty();
    }
  })();

  // ── Load program into sim + renderer ───────────────────────
  function loadProgram(source: string, filename = 'demo') {
    const cmds     = parseGCode(source);

    // Scan for G20/G21 so mmToGcode() is correct before stock is set up.
    // If not found, fall back to the display unit — many imperial CAM programs
    // (Mastercam, Fusion) omit G20 and rely on the machine being in inch mode.
    programUnitMode = currentUnit === 'inch' ? 20 : 21;
    for (const cmd of cmds) {
      if (cmd.G === 20) { programUnitMode = 20; break; }
      if (cmd.G === 21) { programUnitMode = 21; break; }
    }

    syncToolLibFromCommands(cmds);
    renderToolTable(0);

    // Debug: log unit mode so sizing issues can be diagnosed in the browser console
    console.log(`[GCodeSim] loadProgram: file="${filename}"  programUnitMode=${programUnitMode} (${programUnitMode===20?'inch/G20':'mm/G21'})  mmToGcode=${mmToGcode().toFixed(6)}`);
    { const td = getToolDef(1); console.log(`[GCodeSim] T${td.num}: diameter=${td.diameter.toFixed(3)}mm → ${(td.diameter*mmToGcode()).toFixed(4)} scene-units`); }

    const toolpath = buildToolpath(cmds, machineMode);
    const stats    = computeStats(cmds);

    renderer.loadToolpath(toolpath);
    renderer.revealAll();

    sim.load(cmds, machineMode);
    controls.setTotal(cmds.length);
    controls.onStep(0);
    controls.onStatusChange('idle');

    dro.update(sim.currentState);
    renderer.setToolPosition(0, 0, 0);
    { const td = getToolDef(1); renderer.setToolGeometry(td.diameter * mmToGcode(), td.loc * mmToGcode(), td.type, td.cornerRadius * mmToGcode()); }

    // Auto-size stock from toolpath bounds, then fit camera with stock in scene
    autoSizeStock(toolpath);
    applyStock(true);
    renderer.fitCamera(machineMode);

    // File info bar — also shows detected unit mode so mismatches are obvious
    const bytes = new TextEncoder().encode(source).length;
    const unitLabel = programUnitMode === 20 ? 'inch' : 'mm';
    document.getElementById('file-info')!.textContent =
      `${filename}  •  ${stats.lineCount.toLocaleString()} lines  •  ` +
      `${stats.rapidCount} rapids, ${stats.linearCount} feeds, ${stats.arcCount} arcs  •  ` +
      `${unitLabel}  •  ` +
      formatBytes(bytes);
  }

  // ── Per-command motion callback (fires for every cut, not per batch) ──────
  sim.onMotion = (x0, y0, z0, x1, y1, z1, _mode, toolNum, comp) => {
    if (!stockSimEnabled) return;
    const td = getToolDef(toolNum);
    // toolLib stores dimensions in mm; convert to G-code scene units (1/25.4 for inch programs)
    const s  = mmToGcode();
    const r  = (td.diameter / 2) * s;
    const cr = (td.type === 'bullnose' ? td.cornerRadius : 0) * s;

    // Positions from the simulator are already in G-code units — same space as the
    // stock mesh and toolpath lines.  Apply G41/G42 cutter radius compensation here.
    // G41 = tool left of direction of travel, G42 = tool right.
    let ox0 = x0, oy0 = y0, ox1 = x1, oy1 = y1;
    if (comp !== 40 && r > 0) {
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-9) {
        // left  perpendicular: (-dy,  dx) / len * r
        // right perpendicular: ( dy, -dx) / len * r
        const sign = comp === 41 ? 1 : -1;
        const nx = sign * (-dy / len) * r;
        const ny = sign * ( dx / len) * r;
        ox0 += nx; oy0 += ny;
        ox1 += nx; oy1 += ny;
      }
    }
    pendingSegs.push([ox0, oy0, z0, ox1, oy1, z1, r, cr]);
  };

  // ── Backward seek: reset stock, the replay will re-populate pendingSegs ──
  sim.onSeekBackward = () => {
    flushStockReset();
    // After this callback returns, the simulator replays 0→target firing onMotion,
    // which refills pendingSegs. The RAF stockLoop then flushes them progressively.
    // For immediate feedback we flush synchronously after a short rAF tick — but
    // since the replay happens synchronously inside seekTo/stepBack, we can do it
    // with a queueMicrotask to run after the seek completes.
    queueMicrotask(() => {
      for (const [x0,y0,z0,x1,y1,z1,r,cr] of pendingSegs) {
        stockSim.applySweep(x0,y0,z0,x1,y1,z1,r,cr);
      }
      pendingSegs.length = 0;
      if (stockSim.dirty) { renderer.updateStockSurface(stockSim.heightMap, 10 * mmToGcode()); stockSim.clearDirty(); }
    });
  };

  // ── Sim step callback (fires once per display batch) ───────
  sim.onStep = ({ commandIndex, state }) => {
    const curr = state.position;
    dro.update(state);
    controls.onStep(commandIndex);
    renderer.revealUpTo(commandIndex);
    // setToolGeometry BEFORE setToolPosition so depth-cylinder uses the correct radius
    { const td = getToolDef(state.toolNumber); renderer.setToolGeometry(td.diameter * mmToGcode(), td.loc * mmToGcode(), td.type, td.cornerRadius * mmToGcode()); }
    renderer.setToolPosition(curr.X, curr.Y, curr.Z);
    editor.highlightLine(
      Math.max(0, commandIndex - 1),
      followSim && (document.getElementById('chk-follow') as HTMLInputElement).checked,
    );
    renderToolTable(state.toolNumber);
  };

  sim.onStatus = (status) => {
    controls.onStatusChange(status);
    if (status === 'idle') {
      renderer.revealAll();
      pendingSegs.length = 0;
      const { sx,sy,sz,ox,oy,oz } = getStockInputs();
      const s = mmToGcode();
      stockSim.reset(sx*s, sy*s, sz*s, ox*s, oy*s, oz*s);
      renderer.resetStockSurface();
    }
  };

  // ── Machine mode toggle ────────────────────────────────────
  document.getElementById('machine-mode-btns')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.mode-btn');
    if (!btn) return;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    machineMode = btn.dataset.mode as MachineMode;
    sim.setMachineMode(machineMode);
    const cmds     = parseGCode(editor.getContent());
    const toolpath = buildToolpath(cmds, machineMode);
    renderer.loadToolpath(toolpath);
    renderer.revealAll();
    renderer.fitCamera(machineMode);
  });

  // ── File open ──────────────────────────────────────────────
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  document.getElementById('btn-open-file')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      editor.setContent(text);
      loadProgram(text, file.name);
    };
    reader.readAsText(file);
    fileInput.value = '';
  });

  // ── Camera / show-all buttons ──────────────────────────────

  document.getElementById('btn-show-all')!.addEventListener('click', () => {
    pendingSegs.length = 0;
    const { sx,sy,sz,ox,oy,oz } = getStockInputs();
    const s = mmToGcode();
    stockSim.reset(sx*s, sy*s, sz*s, ox*s, oy*s, oz*s);
    renderer.resetStockSurface();

    // 2. Run all commands — onMotion fires per-command, populating pendingSegs
    renderer.revealAll();
    sim.seekTo(sim.totalLines);
    controls.onStep(sim.totalLines);

    // 3. Flush all segments immediately (no RAF time-budget)
    for (const [x0,y0,z0,x1,y1,z1,r,cr] of pendingSegs) {
      stockSim.applySweep(x0,y0,z0,x1,y1,z1,r,cr);
    }
    pendingSegs.length = 0;
    if (stockSim.dirty) { renderer.updateStockSurface(stockSim.heightMap, 10 * mmToGcode()); stockSim.clearDirty(); }
  });

  // ── Follow checkbox ────────────────────────────────────────
  document.getElementById('chk-follow')!.addEventListener('change', (e) => {
    followSim = (e.target as HTMLInputElement).checked;
  });

  // ── Axes / Rapids toggles ──────────────────────────────────
  const btnAxes = document.getElementById('btn-toggle-axes')!;
  btnAxes.addEventListener('click', () => {
    const v = btnAxes.classList.toggle('active');
    renderer.setAxesVisible(v);
  });
  const btnRapids = document.getElementById('btn-toggle-rapids')!;
  btnRapids.addEventListener('click', () => {
    const v = btnRapids.classList.toggle('active');
    renderer.setRapidsVisible(v);
  });
  const btnTool = document.getElementById('btn-toggle-tool')!;
  btnTool.addEventListener('click', () => {
    const v = btnTool.classList.toggle('active');
    renderer.setToolVisible(v);
  });

  // ── Setup panel ───────────────────────────────────────────
  const setupPanel = document.getElementById('setup-panel')!;
  const btnSetup   = document.getElementById('btn-setup')!;
  document.getElementById('btn-setup-close')!.addEventListener('click', () => {
    setupPanel.classList.add('hidden'); btnSetup.classList.remove('active');
  });
  btnSetup.addEventListener('click', () => {
    const open = setupPanel.classList.toggle('hidden');
    btnSetup.classList.toggle('active', !open);
  });

  // ── Tool table ─────────────────────────────────────────────
  renderToolTable(0);

  document.getElementById('tool-tbody')!.addEventListener('change', (e) => {
    const el    = e.target as HTMLInputElement;
    const idx   = parseInt(el.dataset.idx ?? '0', 10);
    const field = el.dataset.field as 'type' | 'diameter' | 'loc' | 'cornerRadius';
    if (field === 'diameter' || field === 'loc' || field === 'cornerRadius') {
      const dispVal = parseFloat(el.value) || 0;
      const mmVal   = currentUnit === 'inch' ? dispVal * 25.4 : dispVal;
      if (field === 'diameter') toolLib[idx].diameter     = Math.max(0.0001, mmVal);
      else if (field === 'loc') toolLib[idx].loc          = Math.max(0.0001, mmVal);
      else                      toolLib[idx].cornerRadius = Math.max(0, mmVal);
    } else if (field === 'type') {
      toolLib[idx].type = el.value as ToolType;
      // Re-render table so CR row appears/disappears
      renderToolTable(sim.currentState.toolNumber);
    }
    const tNum = sim.currentState.toolNumber;
    const td = getToolDef(tNum);
    renderer.setToolGeometry(td.diameter * mmToGcode(), td.loc * mmToGcode(), td.type, td.cornerRadius * mmToGcode());
  });

  document.getElementById('btn-add-tool')!.addEventListener('click', () => {
    const nextNum = (toolLib.reduce((m, t) => Math.max(m, t.num), 0)) + 1;
    toolLib.push({ num: nextNum, type: 'endmill', diameter: 6, loc: 21, cornerRadius: 0 });
    renderToolTable(sim.currentState.toolNumber);
  });

  document.getElementById('tool-tbody')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.btn-del-tool');
    if (!btn || toolLib.length <= 1) return;
    toolLib.splice(parseInt(btn.dataset.idx ?? '0', 10), 1);
    renderToolTable(sim.currentState.toolNumber);
  });

  // ── Stock inputs ───────────────────────────────────────────
  ['stock-sx','stock-sy','stock-sz','stock-cx','stock-cy'].forEach(id =>
    document.getElementById(id)!.addEventListener('change', () => applyStock(true)));

  document.getElementById('chk-stock-solid')!.addEventListener('change', (e) => {
    stockSolidVisible = (e.target as HTMLInputElement).checked;
    renderer.setStockSolidVisible(stockSolidVisible);
  });

  document.getElementById('chk-stock-wire')!.addEventListener('change', (e) => {
    stockWireVisible = (e.target as HTMLInputElement).checked;
    renderer.setStockWireVisible(stockWireVisible);
  });

  document.getElementById('chk-stock-sim')!.addEventListener('change', (e) => {
    stockSimEnabled = (e.target as HTMLInputElement).checked;
  });

  const resSlider = document.getElementById('stock-res-slider') as HTMLInputElement;
  resSlider.addEventListener('change', () => {
    resQuality = parseInt(resSlider.value);
    applyStock(true);  // applyStock now calls calcStockRes() and rebuilds stockSim
  });
  resSlider.addEventListener('input', () => {
    resQuality = parseInt(resSlider.value);
    updateResLabel();
  });

  // ── Unit toggle (mm / inch) ────────────────────────────────
  // toolLib.diameter is always mm internally; stock inputs are converted for display.
  document.getElementById('unit-toggle')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.unit-btn');
    if (!btn || btn.dataset.unit === currentUnit) return;
    const toInch = btn.dataset.unit === 'inch';
    // Convert stock display values (read current mm values, convert to new unit)
    ['stock-sx','stock-sy','stock-sz','stock-cx','stock-cy'].forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement;
      // Current displayed value is in old unit; convert raw mm value to new unit
      const mmVal = currentUnit === 'inch'
        ? parseFloat(el.value) * 25.4
        : parseFloat(el.value);
      el.value = toInch ? (mmVal / 25.4).toFixed(4) : mmVal.toFixed(2);
      el.step = toInch ? '0.001' : '1';
    });
    // Update all unit labels
    const unitText = btn.dataset.unit!;
    document.querySelectorAll('.unit-label').forEach(el => el.textContent = unitText);
    // Update active state
    document.querySelectorAll<HTMLButtonElement>('.unit-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
    currentUnit = unitText as 'mm' | 'inch';
    // Re-render tool table with new display unit (no toolLib conversion needed)
    renderToolTable(sim.currentState.toolNumber);
    // Stock inputs now display in new unit; getStockInputs() converts back to mm
    applyStock(true);
  });

  // ── Splitter drag ──────────────────────────────────────────
  const splitter   = document.getElementById('splitter')!;
  const editorPane = document.getElementById('editor-panel')!;
  let dragging = false, startX = 0, startW = 0;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true; startX = e.clientX;
    startW = editorPane.getBoundingClientRect().width;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newW = Math.max(240, Math.min(startW + e.clientX - startX, window.innerWidth * 0.65));
    editorPane.style.width = editorPane.style.minWidth = editorPane.style.maxWidth = `${newW}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; splitter.classList.remove('dragging');
    document.body.style.cursor = document.body.style.userSelect = '';
  });

  // ── Load demo on startup ───────────────────────────────────
  const demo = generateDemo();
  editor.setContent(demo);
  loadProgram(demo, 'demo.nc');
}

main();
