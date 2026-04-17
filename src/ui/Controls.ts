// ─── Playback Controls ────────────────────────────────────────────────────────
// Wires the bottom controls bar buttons, progress bar, and speed slider.

import type { Simulator, SimStatus } from '../simulator/Simulator.ts';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Map a linear slider value 0-100 to steps/sec on a log scale: 1 – 10 000 */
function sliderToSpeed(v: number): number {
  return Math.round(Math.pow(10, v / 100 * 4)); // 10^0 = 1 … 10^4 = 10000
}

function speedLabel(sps: number): string {
  if (sps >= 1000) return `${(sps / 1000).toFixed(sps >= 10000 ? 0 : 1)}k stp/s`;
  return `${sps} stp/s`;
}

export class Controls {
  private btnPlay     = el<HTMLButtonElement>('btn-play');
  private btnPause    = el<HTMLButtonElement>('btn-pause');
  private btnStop     = el<HTMLButtonElement>('btn-stop');
  private btnStepFwd  = el<HTMLButtonElement>('btn-step-fwd');
  private btnStepBack = el<HTMLButtonElement>('btn-step-back');
  private progressBar = el<HTMLInputElement>('progress-bar');
  private progressLbl = el('progress-label');
  private speedSlider = el<HTMLInputElement>('speed-slider');
  private speedValue  = el('speed-value');

  private sim: Simulator;
  private suppressProgressChange = false;

  constructor(sim: Simulator) {
    this.sim = sim;

    // ── Button events ────────────────────────────────────────
    this.btnPlay.addEventListener('click', () => sim.play());
    this.btnPause.addEventListener('click', () => sim.pause());
    this.btnStop.addEventListener('click',  () => { sim.stop(); sim.rewind(); });
    this.btnStepFwd.addEventListener('click',  () => sim.stepForward());
    this.btnStepBack.addEventListener('click', () => sim.stepBack());

    // ── Progress bar ─────────────────────────────────────────
    this.progressBar.addEventListener('input', () => {
      if (this.suppressProgressChange) return;
      const pct = parseInt(this.progressBar.value, 10);
      const idx = Math.round((pct / 100) * sim.totalLines);
      sim.seekTo(idx);
    });

    // ── Speed slider ─────────────────────────────────────────
    this.speedSlider.addEventListener('input', () => {
      const speed = sliderToSpeed(parseInt(this.speedSlider.value, 10));
      sim.speed = speed;
      this.speedValue.textContent = speedLabel(speed);
    });

    // Init speed display
    const initSpeed = sliderToSpeed(parseInt(this.speedSlider.value, 10));
    sim.speed = initSpeed;
    this.speedValue.textContent = speedLabel(initSpeed);

    // ── Keyboard shortcuts ───────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('.cm-editor')) return; // ignore in editor
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (sim.simStatus === 'playing') sim.pause();
          else sim.play();
          break;
        case 'Escape': sim.stop(); sim.rewind(); break;
        case 'ArrowRight':
          e.preventDefault();
          if (sim.simStatus !== 'playing') sim.stepForward();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (sim.simStatus !== 'playing') sim.stepBack();
          break;
      }
    });
  }

  /** Called whenever the sim emits a step event. */
  onStep(commandIndex: number): void {
    const total = this.sim.totalLines;
    const pct   = total > 0 ? Math.round((commandIndex / total) * 100) : 0;

    this.suppressProgressChange = true;
    this.progressBar.value = String(pct);
    this.suppressProgressChange = false;

    this.progressLbl.textContent = `Line ${commandIndex} / ${total}`;
  }

  /** Called when sim status changes. */
  onStatusChange(status: SimStatus): void {
    const playing = status === 'playing';
    const ended   = status === 'ended';

    this.btnPlay.disabled = playing;

    this.btnPause.disabled     = !playing;
    this.btnStepFwd.disabled   = playing || ended;
    this.btnStepBack.disabled  = playing;
  }

  /** Update total line count after loading a new file. */
  setTotal(total: number): void {
    this.progressBar.max    = '100';
    this.progressBar.value  = '0';
    this.progressLbl.textContent = `Line 0 / ${total}`;
  }
}
