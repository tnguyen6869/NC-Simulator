# G-Code Simulator — Architecture Decisions

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Build Tool | Vite + TypeScript | Fast HMR, tree-shaking, native ES modules |
| 3D Rendering | Three.js r162 | BufferGeometry handles millions of vertices; OrbitControls |
| Code Editor | CodeMirror 6 | Virtual DOM rendering; handles multi-million line files |
| UI Framework | Vanilla TypeScript | No overhead for a focused single-page tool |
| Styling | CSS custom properties | Dark theme, responsive grid layout |

## Project Structure

```
src/
├── main.ts                  # Entry: wires all modules, demo G-code
├── styles/main.css          # Dark-theme, CSS grid layout
├── parser/
│   └── GCodeParser.ts       # Stateless regex line parser → GCodeCommand[]
├── simulator/
│   ├── MachineState.ts      # Position, modal state types + factory
│   └── Simulator.ts         # RAF-based step engine, adjustable speed
├── renderer/
│   ├── ToolpathBuilder.ts   # Commands → Float32Array geometry + line maps
│   └── Renderer3D.ts        # Three.js scene, camera, OrbitControls, reveal
├── editor/
│   └── GCodeEditor.ts       # CodeMirror 6 + custom G-code StreamLanguage
└── ui/
    ├── DRO.ts               # Digital Read Out panel (X Y Z A B C F S T)
    └── Controls.ts          # Play/pause/stop/step + speed slider
```

## Key Design Decisions

### Performance for Large Files
- **Geometry**: All toolpath vertices pre-allocated into flat `Float32Array`.
  `geometry.setDrawRange(0, N)` reveals the toolpath O(1) per sim step.
- **Line map**: `commandRapidEnd[i]` / `commandCutEnd[i]` are prefix-sum arrays
  mapping command index → cumulative vertex count. No per-step search needed.
- **Editor**: CodeMirror 6 lazy-renders lines; never touches DOM for off-screen content.

### Simulation Engine
- `requestAnimationFrame` loop with a floating-point accumulator for
  frame-rate-independent speed control.
- Speed unit: **steps/second** (range 1–10 000).
- At high speeds, batches multiple steps per frame before a single render.

### Arc Tessellation (G2/G3)
- Segments per arc: `max(8, ceil(arcLength / 0.5))`  — half-mm resolution.
- Supports G17 (XY), G18 (XZ), G19 (YZ) planes.
- Handles helical motion (linear Z interpolated along arc sweep).
- Full-circle detection: start == end → 2π sweep.

### Machine Modes
| Mode | Camera | Coordinate Display |
|------|--------|-------------------|
| Mill | Isometric XYZ | Standard XYZ |
| Lathe | Side view (XZ) | X = diameter |
| 3D Printer | Top-down + iso | Z = layer; vertex colors by height |

### Privacy
All processing is client-side (parser, renderer, simulator). No data leaves the browser.
CDN dependencies are bundled by Vite at build time.
