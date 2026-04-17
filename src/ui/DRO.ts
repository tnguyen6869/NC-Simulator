// ─── Digital Read Out ─────────────────────────────────────────────────────────
// Updates the DRO panel elements based on MachineState.

import type { MachineState } from '../simulator/MachineState.ts';
import { motionLabel } from '../simulator/MachineState.ts';

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function fmt(v: number, decimals = 3): string {
  return v.toFixed(decimals);
}

export class DRO {
  private droX    = el('dro-x');
  private droY    = el('dro-y');
  private droZ    = el('dro-z');
  private droA    = el('dro-a');
  private droB    = el('dro-b');
  private droC    = el('dro-c');
  private droFeed = el('dro-feed');
  private droSpd  = el('dro-speed');
  private droTool = el('dro-tool');
  private droMode = el('dro-mode');
  private droUnits= el('dro-units');
  private droDist = el('dro-dist');

  update(state: MachineState): void {
    const p = state.position;
    this.droX.textContent = fmt(p.X);
    this.droY.textContent = fmt(p.Y);
    this.droZ.textContent = fmt(p.Z);
    this.droA.textContent = fmt(p.A);
    this.droB.textContent = fmt(p.B);
    this.droC.textContent = fmt(p.C);

    this.droFeed.textContent = fmt(state.feedRate, 0);
    this.droSpd.textContent  = fmt(state.spindleSpeed, 0);
    const compStr = state.toolCompMode === 41 ? ' G41' : state.toolCompMode === 42 ? ' G42' : '';
    this.droTool.textContent = `T${state.toolNumber}${compStr}`;

    const label = motionLabel(state);
    this.droMode.textContent = label;
    this.droMode.className = 'dro-value ' + this._modeClass(label);

    this.droUnits.textContent = state.unitMode === 21 ? 'mm' : 'inch';
    this.droDist.textContent  = state.distanceMode === 90 ? 'ABS' : 'INC';
  }

  private _modeClass(label: string): string {
    if (label === 'RAPID')  return 'orange';
    if (label.startsWith('ARC')) return 'cyan';
    if (label === 'FEED')   return 'cyan';
    if (label === 'END')    return '';
    return '';
  }
}
