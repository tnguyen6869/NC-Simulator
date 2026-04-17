// ─── Simulator ────────────────────────────────────────────────────────────────
// Steps through GCodeCommand[] applying each to MachineState.
// Uses requestAnimationFrame + a time accumulator for frame-rate-independent speed.

import type { GCodeCommand } from '../parser/GCodeParser.ts';
import {
  type MachineState,
  type MachineMode,
  type Position,
  createMachineState,
  cloneState,
} from './MachineState.ts';

export type SimStatus = 'idle' | 'playing' | 'paused' | 'ended';

export interface SimStepEvent {
  commandIndex: number;
  state: MachineState;
}

export type StepCallback   = (e: SimStepEvent) => void;
export type StatusCallback = (status: SimStatus) => void;
/** Fires for every cutting move (G1/G2/G3) — once per command, not per batch. */
export type MotionCallback = (
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  motionMode: 1 | 2 | 3,
  toolNumber: number,
  /** G40=no comp, G41=left, G42=right */
  toolCompMode: 40 | 41 | 42,
) => void;

// ─────────────────────────────────────────────────────────────────────────────

export class Simulator {
  private commands: GCodeCommand[] = [];
  private state:    MachineState;
  private index:    number = 0;      // next command to execute
  private status:   SimStatus = 'idle';

  /** Steps per second (1 – 10 000) */
  speed: number = 100;

  // RAF bookkeeping
  private rafId:        number = 0;
  private lastTime:     number = 0;
  private accumulator:  number = 0;

  onStep:   StepCallback   | null = null;
  onStatus: StatusCallback | null = null;
  onMotion: MotionCallback | null = null;
  /** Fires before any backward seek/step so the caller can reset dependent state. */
  onSeekBackward: ((targetIndex: number) => void) | null = null;

  // ── public API ──────────────────────────────────────────────

  constructor(machineMode: MachineMode = 'mill') {
    this.state = createMachineState(machineMode);
  }

  load(commands: GCodeCommand[], machineMode?: MachineMode): void {
    this.stop();
    this.commands = commands;
    this.state = createMachineState(machineMode ?? this.state.machineMode);
    this.index = 0;
    this.accumulator = 0;
    this._emitStep();
    this._setStatus('idle');
  }

  get currentIndex() { return this.index; }
  get totalLines()   { return this.commands.length; }
  get currentState() { return this.state; }
  get simStatus()    { return this.status; }

  play(): void {
    if (this.status === 'ended') this.rewind();
    if (this.status === 'playing') return;
    this.lastTime = performance.now();
    this._setStatus('playing');
    this._schedule();
  }

  pause(): void {
    if (this.status !== 'playing') return;
    cancelAnimationFrame(this.rafId);
    this.accumulator = 0;
    this._setStatus('paused');
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.accumulator = 0;
    this._setStatus('idle');
  }

  rewind(): void {
    this.stop();
    this.state    = createMachineState(this.state.machineMode);
    this.index    = 0;
    this._emitStep();
    this._setStatus('idle');
  }

  stepForward(): void {
    if (this.index >= this.commands.length) return;
    this._executeOne();
    this._emitStep();
    if (this.index >= this.commands.length) this._setStatus('ended');
  }

  stepBack(): void {
    if (this.index <= 0) return;
    const target = this.index - 1;
    this.onSeekBackward?.(target);
    this.state    = createMachineState(this.state.machineMode);
    this.index    = 0;
    while (this.index < target) this._executeOne();
    this._emitStep();
    if (this.status !== 'playing') this._setStatus('paused');
  }

  seekTo(targetIndex: number): void {
    targetIndex = Math.max(0, Math.min(targetIndex, this.commands.length));
    if (targetIndex === this.index) return;

    if (targetIndex < this.index) {
      this.onSeekBackward?.(targetIndex);
      this.state = createMachineState(this.state.machineMode);
      this.index = 0;
    }
    while (this.index < targetIndex) this._executeOne();
    this._emitStep();
  }

  setMachineMode(mode: MachineMode): void {
    this.state.machineMode = mode;
    const idx = this.index;
    this.rewind();
    this.seekTo(idx);
  }

  // ── private ─────────────────────────────────────────────────

  private _schedule(): void {
    this.rafId = requestAnimationFrame((now) => this._tick(now));
  }

  private _tick(now: number): void {
    if (this.status !== 'playing') return;

    const dt = Math.min((now - this.lastTime) / 1000, 0.1); // cap at 100 ms
    this.lastTime    = now;
    this.accumulator += dt * this.speed;

    // Batch multiple steps per frame when speed is high
    const batchLimit = Math.min(Math.ceil(this.accumulator), 5000);
    let stepped = 0;
    while (this.accumulator >= 1 && stepped < batchLimit &&
           this.index < this.commands.length) {
      this.accumulator -= 1;
      this._executeOne();
      stepped++;
    }

    if (stepped > 0) this._emitStep();

    if (this.index >= this.commands.length) {
      this._setStatus('ended');
      return;
    }

    this._schedule();
  }

  private _executeOne(): void {
    const prev = this.state.position;
    const px = prev.X, py = prev.Y, pz = prev.Z;
    const cmd = this.commands[this.index++];
    this._apply(cmd);

    if (!this.onMotion || this.state.motionMode === 0) return;
    const p = this.state.position;
    if (p.X === px && p.Y === py && p.Z === pz) return;

    const mode = this.state.motionMode as 1 | 2 | 3;
    const tool = this.state.toolNumber;
    const comp = this.state.toolCompMode;

    if (mode === 1) {
      // G1 linear: fire once
      this.onMotion(px, py, pz, p.X, p.Y, p.Z, 1, tool, comp);
    } else {
      // G2/G3 arc: tessellate so stock sim sees the actual curved path
      const pts = this._tessellateArcPts(
        px, py, pz, p.X, p.Y, p.Z,
        cmd.I ?? 0, cmd.J ?? 0, cmd.K ?? 0,
        mode === 2,
        this.state.planeSelect,
      );
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        this.onMotion(a[0], a[1], a[2], b[0], b[1], b[2], mode, tool, comp);
      }
    }
  }

  /** Tessellate a G2/G3 arc into [x,y,z] points (same algorithm as ToolpathBuilder). */
  private _tessellateArcPts(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    ci: number, cj: number, ck: number,
    clockwise: boolean,
    plane: 17 | 18 | 19,
  ): Array<[number, number, number]> {
    // Project into the arc plane's two axes
    let sx: number, sy: number, ex: number, ey: number,
        cx: number, cy: number, linS: number, linE: number;

    if (plane === 17) {
      sx = x0; sy = y0; ex = x1; ey = y1;
      cx = x0 + ci; cy = y0 + cj; linS = z0; linE = z1;
    } else if (plane === 18) {
      sx = x0; sy = z0; ex = x1; ey = z1;
      cx = x0 + ci; cy = z0 + ck; linS = y0; linE = y1;
    } else {
      sx = y0; sy = z0; ex = y1; ey = z1;
      cx = y0 + cj; cy = z0 + ck; linS = x0; linE = x1;
    }

    const radius = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
    if (radius < 1e-9) return [[x0,y0,z0],[x1,y1,z1]];

    const aStart = Math.atan2(sy - cy, sx - cx);
    const aEnd   = Math.atan2(ey - cy, ex - cx);
    const isFullCircle = Math.abs(sx - ex) < 1e-6 && Math.abs(sy - ey) < 1e-6;

    let sweep: number;
    if (isFullCircle) {
      sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
    } else if (clockwise) {
      sweep = aEnd - aStart;
      if (sweep >= 0) sweep -= 2 * Math.PI;
    } else {
      sweep = aEnd - aStart;
      if (sweep <= 0) sweep += 2 * Math.PI;
    }

    const arcLen = Math.abs(sweep) * radius;
    const nSeg   = Math.max(8, Math.ceil(arcLen / 0.5));
    const pts: Array<[number, number, number]> = [];

    for (let i = 0; i <= nSeg; i++) {
      const t = i / nSeg;
      const a = aStart + sweep * t;
      const pa = cx + radius * Math.cos(a);
      const pb = cy + radius * Math.sin(a);
      const lin = linS + (linE - linS) * t;
      if (plane === 17)      pts.push([pa,  pb,  lin]);
      else if (plane === 18) pts.push([pa,  lin, pb ]);
      else                   pts.push([lin, pa,  pb ]);
    }
    return pts;
  }

  private _emitStep(): void {
    this.onStep?.({ commandIndex: this.index, state: cloneState(this.state) });
  }

  private _setStatus(s: SimStatus): void {
    this.status = s;
    this.onStatus?.(s);
  }

  // ── G-code interpreter ──────────────────────────────────────

  private _apply(cmd: GCodeCommand): void {
    const s = this.state;

    // ── Non-motion G codes ──────────────────────────────────
    if (cmd.G !== undefined) {
      const g = Math.floor(cmd.G); // treat G17.1 as 17 for modal
      switch (g) {
        case 17: s.planeSelect = 17; break;
        case 18: s.planeSelect = 18; break;
        case 19: s.planeSelect = 19; break;
        case 20: s.unitMode = 20; break;
        case 21: s.unitMode = 21; break;
        case 28: this._homeAxes(cmd); break;
        case 40: s.toolCompMode = 40; break;
        case 41: s.toolCompMode = 41; break;
        case 42: s.toolCompMode = 42; break;
        case 90: s.distanceMode = 90; break;
        case 91: s.distanceMode = 91; break;
        case 92: this._setPosition(cmd); break;
        // G90.1/G91.1 are sub-codes (cmd.G === 90.1)
      }
      if (cmd.G === 90.1) s.arcDistanceMode = 90;
      if (cmd.G === 91.1) s.arcDistanceMode = 91;

      // Motion mode update
      if (g >= 0 && g <= 3) s.motionMode = g as 0 | 1 | 2 | 3;
    }

    // ── F / S / T ───────────────────────────────────────────
    if (cmd.F !== undefined) s.feedRate     = cmd.F;
    if (cmd.S !== undefined) s.spindleSpeed = cmd.S;
    if (cmd.T !== undefined) s.toolNumber   = cmd.T;

    // ── M codes ─────────────────────────────────────────────
    if (cmd.M !== undefined) {
      switch (cmd.M) {
        case 3: s.spindleOn = true;  s.spindleCW = true;  break;
        case 4: s.spindleOn = true;  s.spindleCW = false; break;
        case 5: s.spindleOn = false; break;
        case 0: case 1: case 2: case 30:
          s.programEnd = true;
          break;
      }
    }

    // ── Motion ──────────────────────────────────────────────
    const hasCoords = cmd.X !== undefined || cmd.Y !== undefined ||
                      cmd.Z !== undefined || cmd.A !== undefined ||
                      cmd.B !== undefined || cmd.C !== undefined;

    // Determine active motion mode for this block
    const motionG = cmd.G !== undefined && cmd.G >= 0 && cmd.G <= 3
      ? (cmd.G as 0 | 1 | 2 | 3)
      : s.motionMode;

    if (hasCoords && motionG >= 0 && motionG <= 3) {
      const target = this._resolveTarget(cmd);
      s.position = { ...s.position, ...target };
    }
  }

  /** Resolve target coordinates, honouring G90/G91 */
  private _resolveTarget(cmd: GCodeCommand): Partial<Position> {
    const { position: p, distanceMode: dm } = this.state;
    const abs = dm === 90;
    const t: Partial<Position> = {};

    if (cmd.X !== undefined) t.X = abs ? cmd.X : p.X + cmd.X;
    if (cmd.Y !== undefined) t.Y = abs ? cmd.Y : p.Y + cmd.Y;
    if (cmd.Z !== undefined) t.Z = abs ? cmd.Z : p.Z + cmd.Z;
    if (cmd.A !== undefined) t.A = abs ? cmd.A : p.A + cmd.A;
    if (cmd.B !== undefined) t.B = abs ? cmd.B : p.B + cmd.B;
    if (cmd.C !== undefined) t.C = abs ? cmd.C : p.C + cmd.C;

    return t;
  }

  private _homeAxes(cmd: GCodeCommand): void {
    const p = this.state.position;
    // If specific axes given, home only those; otherwise home all
    const hasAxes = cmd.X !== undefined || cmd.Y !== undefined || cmd.Z !== undefined;
    if (!hasAxes || cmd.X !== undefined) p.X = 0;
    if (!hasAxes || cmd.Y !== undefined) p.Y = 0;
    if (!hasAxes || cmd.Z !== undefined) p.Z = 0;
  }

  private _setPosition(cmd: GCodeCommand): void {
    // G92: set current position to specified values
    const p = this.state.position;
    if (cmd.X !== undefined) p.X = cmd.X;
    if (cmd.Y !== undefined) p.Y = cmd.Y;
    if (cmd.Z !== undefined) p.Z = cmd.Z;
    if (cmd.A !== undefined) p.A = cmd.A;
    if (cmd.B !== undefined) p.B = cmd.B;
    if (cmd.C !== undefined) p.C = cmd.C;
  }
}
