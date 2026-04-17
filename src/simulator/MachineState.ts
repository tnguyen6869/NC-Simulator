// ─── Machine State ────────────────────────────────────────────────────────────

export type MachineMode = 'mill' | 'lathe' | 'printer';

export interface Position {
  X: number;
  Y: number;
  Z: number;
  A: number;
  B: number;
  C: number;
}

export interface MachineState {
  // Live position (in current units)
  position: Position;

  // ── Modal groups ────────────────────────────────────────────
  /** G0/G1/G2/G3 — current motion mode */
  motionMode: 0 | 1 | 2 | 3;
  /** G17/G18/G19 — active plane */
  planeSelect: 17 | 18 | 19;
  /** G90/G91 — absolute (90) or incremental (91) */
  distanceMode: 90 | 91;
  /** G40/G41/G42 — cutter radius compensation (40=off, 41=left, 42=right) */
  toolCompMode: 40 | 41 | 42;
  /** G20/G21 — inch (20) or mm (21) */
  unitMode: 20 | 21;
  /** G90.1/G91.1 — arc I/J/K absolute or incremental */
  arcDistanceMode: 90 | 91;

  // ── Spindle / program ───────────────────────────────────────
  feedRate: number;
  spindleSpeed: number;
  toolNumber: number;
  spindleOn: boolean;
  spindleCW: boolean;
  programEnd: boolean;

  // ── Machine configuration ───────────────────────────────────
  machineMode: MachineMode;

  // ── Work coordinate offset (G92) ────────────────────────────
  wco: Position;
}

export function createMachineState(machineMode: MachineMode = 'mill'): MachineState {
  return {
    position:       { X: 0, Y: 0, Z: 0, A: 0, B: 0, C: 0 },
    motionMode:      0,
    planeSelect:    17,
    distanceMode:   90,
    unitMode:       21,
    arcDistanceMode: 91,  // most common default — I,J,K relative to start
    toolCompMode:    40,  // G40 — no compensation
    feedRate:        0,
    spindleSpeed:    0,
    toolNumber:      0,
    spindleOn:       false,
    spindleCW:       true,
    programEnd:      false,
    machineMode,
    wco:            { X: 0, Y: 0, Z: 0, A: 0, B: 0, C: 0 },
  };
}

export function cloneState(s: MachineState): MachineState {
  return {
    ...s,
    position: { ...s.position },
    wco:      { ...s.wco },
  };
}

/** Human-readable motion mode label */
export function motionLabel(s: MachineState): string {
  if (s.programEnd) return 'END';
  switch (s.motionMode) {
    case 0: return 'RAPID';
    case 1: return 'FEED';
    case 2: return 'ARC CW';
    case 3: return 'ARC CCW';
  }
}
