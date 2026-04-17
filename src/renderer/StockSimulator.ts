// ─── Stock Simulator ─────────────────────────────────────────────────────────
// 2.5D height-map subtraction. A flat Float32Array (resolution × resolution)
// stores the current top-surface Z for each XY cell. As the tool sweeps through,
// cells within the tool radius are lowered to the effective cutting Z.
//
// For a bull nose end mill with corner radius CR and tool radius R:
//   - Cells at radial distance ρ ≤ (R - CR): flat bottom → cut to toolZ
//   - Cells at radial distance ρ > (R - CR):  corner arc  → cut to toolZ + CR - √(CR²-(ρ-(R-CR))²)
// For all other tool types cornerRadius = 0, which reduces to the flat case.

export const STOCK_RES = 512; // cells per axis  (512×512 = 262 144 cells)

export class StockSimulator {
  readonly resolution: number;
  /** G-code Z value at each cell — indexed [row * N + col] */
  readonly heightMap: Float32Array;
  dirty = false;

  private originX = 0;
  private originY = 0;
  private topZ    = 0;
  private cellW   = 1; // G-code units per column
  private cellH   = 1; // G-code units per row

  constructor(resolution = STOCK_RES) {
    this.resolution = resolution;
    this.heightMap  = new Float32Array(resolution * resolution);
  }

  reset(sx: number, sy: number, sz: number,
        ox: number, oy: number, oz: number): void {
    const N = this.resolution;
    this.originX = ox;
    this.originY = oy;
    this.topZ    = oz + sz;
    this.cellW   = sx / (N - 1);
    this.cellH   = sy / (N - 1);
    this.heightMap.fill(this.topZ);
    this.dirty = true;
  }

  /**
   * Apply tool at (x, y, z) with given radius and optional corner radius.
   * cornerRadius = 0 → flat end mill (default).
   * cornerRadius > 0 → bull nose: outer ring follows quarter-circle arc.
   */
  applyTool(x: number, y: number, z: number, radius: number, cornerRadius = 0): void {
    if (radius <= 0) return;
    const N   = this.resolution;
    const r2  = radius * radius;
    const cr  = Math.min(Math.max(cornerRadius, 0), radius * 0.49);
    const flatR = radius - cr; // radial extent of flat bottom

    const iMin = Math.max(0,   Math.floor((x - radius - this.originX) / this.cellW));
    const iMax = Math.min(N-1, Math.ceil ((x + radius - this.originX) / this.cellW));
    const jMin = Math.max(0,   Math.floor((y - radius - this.originY) / this.cellH));
    const jMax = Math.min(N-1, Math.ceil ((y + radius - this.originY) / this.cellH));

    for (let j = jMin; j <= jMax; j++) {
      const cy = this.originY + j * this.cellH;
      const dy = y - cy;
      const dy2 = dy * dy;
      for (let i = iMin; i <= iMax; i++) {
        const cx = this.originX + i * this.cellW;
        const dx = x - cx;
        const rho2 = dx * dx + dy2;
        if (rho2 > r2) continue;

        // Effective cut Z at this cell
        let cutZ = z;
        if (cr > 0) {
          const rho = Math.sqrt(rho2);
          if (rho > flatR) {
            // On the corner arc: rise = CR - √(CR² - (ρ-(R-CR))²)
            const d = rho - flatR;         // how far into the corner zone
            const rise = cr - Math.sqrt(Math.max(0, cr * cr - d * d));
            cutZ = z + rise;
          }
        }

        const idx = j * N + i;
        if (cutZ < this.heightMap[idx]) {
          this.heightMap[idx] = cutZ;
          this.dirty = true;
        }
      }
    }
  }

  /**
   * Sweep the tool along a line segment, sampling at half-cell intervals.
   */
  applySweep(x0: number, y0: number, z0: number,
             x1: number, y1: number, z1: number,
             radius: number, cornerRadius = 0): void {
    const dx = x1 - x0, dy = y1 - y0;
    const xyLen = Math.sqrt(dx * dx + dy * dy);
    const sampleDist = Math.min(this.cellW, this.cellH) * 0.5;
    const steps = Math.max(1, Math.ceil(xyLen / sampleDist));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.applyTool(x0 + t * dx, y0 + t * dy, z0 + t * (z1 - z0), radius, cornerRadius);
    }
  }

  clearDirty(): void { this.dirty = false; }
}
