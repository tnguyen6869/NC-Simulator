// ─── 3D Renderer ─────────────────────────────────────────────────────────────
// Manages the Three.js scene, camera, controls, and toolpath geometry.

import * as THREE from 'three';
type ToolType = 'endmill' | 'ballmill' | 'drill' | 'spotdrill' | 'chamfer' | 'bullnose' | 'facemill';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ToolpathData } from './ToolpathBuilder.ts';
import type { MachineMode } from '../simulator/MachineState.ts';

export class Renderer3D {
  private renderer:   THREE.WebGLRenderer;
  private scene:      THREE.Scene;
  private camera:     THREE.PerspectiveCamera;
  private controls:   OrbitControls;
  private rafId:      number = 0;

  // Toolpath line objects
  private rapidLines: THREE.LineSegments | null = null;
  private cutLines:   THREE.LineSegments | null = null;

  // Tool position indicator
  private toolGroup:  THREE.Group;

  // Grid / axes
  private grid:   THREE.GridHelper;
  private axes:   THREE.Group;

  // Stock objects
  private stockTopMesh:  THREE.Mesh          | null = null; // dynamic height-map surface
  private stockBodyMesh: THREE.Mesh          | null = null; // solid sides/bottom
  private stockWire:     THREE.LineSegments  | null = null; // outline
  // Stash stock params for resetStockSurface
  private _stockTopZ = 0;
  private _stockRes  = 128;

  private toolDiameterMm: number = 6;
  private toolLocMm: number = 21;
  private _toolType: ToolType = 'endmill';
  private _cornerRadiusMm: number = 0;
  private _zeroRing:     THREE.Mesh | null = null;
  /** Orange cylinder from Z=0 down to tool tip — shows active cut depth */
  private _depthCyl:     THREE.Mesh | null = null;
  /** Thin vertical line from fixed height down to tip — makes Z motion clear */
  private _spindleLine:  THREE.Line | null = null;
  private _toolGcodeZ:   number = 0;
  private _toolGcodeX:   number = 0;
  private _toolGcodeY:   number = 0;

  // Current draw state
  private tpData: ToolpathData | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    // ── Renderer ────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // ── Scene ───────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c12);
    this.scene.fog = new THREE.Fog(0x0a0c12, 1000, 3000);

    // ── Camera ──────────────────────────────────────────────
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
    this.camera.position.set(80, 80, 120);

    // ── Controls ────────────────────────────────────────────
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping   = true;
    this.controls.dampingFactor   = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance     = 0.5;
    this.controls.maxDistance     = 2000;

    // ── Grid ────────────────────────────────────────────────
    this.grid = new THREE.GridHelper(300, 30, 0x1a2030, 0x131c28);
    this.scene.add(this.grid);

    // ── G-code axes (X/Y/Z labels match G-code convention) ──
    // Mapping: scene X = G-code X, scene Y = G-code Z, scene -Z = G-code Y
    this.axes = this._createGCodeAxes(25);
    this.scene.add(this.axes);

    // ── Ambient + directional light (for solid meshes) ──────
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 2, 3);
    this.scene.add(dir);

    // ── Tool indicator (built via setToolGeometry) ──────────────────────────
    this.toolGroup = new THREE.Group();
    this.toolGroup.renderOrder = 10;
    this.scene.add(this.toolGroup);

    // Z=0 reference ring — stays at stock surface, tracks X/Y
    const zeroRing = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.06, 6, 32),
      new THREE.MeshBasicMaterial({ color: 0x00d4ff, depthTest: false }),
    );
    zeroRing.renderOrder = 11;
    zeroRing.rotation.x = Math.PI / 2;
    this._zeroRing = zeroRing;
    this.scene.add(zeroRing);

    // Depth-of-cut cylinder — bright solid red fill from Z=0 down to tool tip
    const depthCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 24),
      new THREE.MeshBasicMaterial({ color: 0xff2200, depthTest: false }),
    );
    depthCyl.renderOrder = 14;
    depthCyl.visible = false;
    this._depthCyl = depthCyl;
    this.scene.add(depthCyl);

    // Spindle line — thin vertical from LOC-height above Z=0 down to tip
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 1, 0),
    ]);
    const spindleLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    spindleLine.renderOrder = 12;
    this._spindleLine = spindleLine;
    this.scene.add(spindleLine);

    this._buildToolMeshes(this.toolDiameterMm, this.toolLocMm, this._toolType, this._cornerRadiusMm);

    // ── Resize observer ─────────────────────────────────────
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(canvas.parentElement!);
    this._resize();

    this._startLoop();
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Build axis arrows labelled with G-code axis names.
   * In scene space:  G-code X → scene +X,  G-code Y → scene -Z,  G-code Z → scene +Y
   */
  private _createGCodeAxes(size: number): THREE.Group {
    const group = new THREE.Group();

    const axes: Array<{ dir: THREE.Vector3; color: number; label: string }> = [
      { dir: new THREE.Vector3(1, 0,  0), color: 0xff4455, label: 'X' }, // G-code +X → scene +X
      { dir: new THREE.Vector3(0, 0, -1), color: 0x44ff55, label: 'Y' }, // G-code +Y → scene -Z
      { dir: new THREE.Vector3(0, 1,  0), color: 0x4499ff, label: 'Z' }, // G-code +Z → scene +Y
    ];

    for (const { dir, color, label } of axes) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0),
        size, color, size * 0.18, size * 0.1);
      group.add(arrow);

      // Canvas sprite label at tip
      const canvas = document.createElement('canvas');
      canvas.width = 48; canvas.height = 48;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.font = 'bold 36px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 24, 24);
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sprite.scale.setScalar(size * 0.35);
      sprite.position.copy(dir).multiplyScalar(size * 1.25);
      group.add(sprite);
    }

    return group;
  }

  /**
   * Convert a flat G-code position buffer [x,y,z,...] to Three.js Y-up space.
   * G-code: X right, Y forward, Z up
   * Three.js: X right, Y up, Z toward viewer
   * Mapping: Tjs.X = Gc.X,  Tjs.Y = Gc.Z,  Tjs.Z = -Gc.Y
   */
  private _toSceneSpace(src: Float32Array): Float32Array {
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      dst[i]     =  src[i];      // X → X
      dst[i + 1] =  src[i + 2]; // Z → Y (up)
      dst[i + 2] = -src[i + 1]; // Y → -Z
    }
    return dst;
  }

  /** Upload a built toolpath into GPU-ready BufferGeometry objects. */
  loadToolpath(data: ToolpathData): void {
    this.tpData = data;

    // Remove old lines
    if (this.rapidLines) { this.scene.remove(this.rapidLines); this.rapidLines.geometry.dispose(); }
    if (this.cutLines)   { this.scene.remove(this.cutLines);   this.cutLines.geometry.dispose();   }

    // ── Rapid lines (orange) ─────────────────────────────────
    const rapidGeo = new THREE.BufferGeometry();
    rapidGeo.setAttribute('position', new THREE.BufferAttribute(this._toSceneSpace(data.rapidPositions), 3));
    rapidGeo.setDrawRange(0, 0);
    this.rapidLines = new THREE.LineSegments(
      rapidGeo,
      new THREE.LineBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.7 }),
    );
    this.scene.add(this.rapidLines);

    // ── Cut lines (cyan / vertex-coloured for printer) ───────
    const cutGeo = new THREE.BufferGeometry();
    cutGeo.setAttribute('position', new THREE.BufferAttribute(this._toSceneSpace(data.cutPositions), 3));
    cutGeo.setAttribute('color',    new THREE.BufferAttribute(data.cutColors, 3));
    cutGeo.setDrawRange(0, 0);
    this.cutLines = new THREE.LineSegments(
      cutGeo,
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    this.scene.add(this.cutLines);
  }

  /** Reveal the toolpath up to the given command index (0-based). */
  revealUpTo(commandIndex: number): void {
    if (!this.tpData || !this.rapidLines || !this.cutLines) return;
    const d = this.tpData;
    const ci = Math.max(0, Math.min(commandIndex, d.rapidVertexCount.length - 1));

    this.rapidLines.geometry.setDrawRange(0, d.rapidVertexCount[ci]);
    this.cutLines.geometry.setDrawRange(0, d.cutVertexCount[ci]);
  }

  /** Show the full toolpath (all commands). */
  revealAll(): void {
    if (!this.tpData || !this.rapidLines || !this.cutLines) return;
    const n = this.tpData.rapidVertexCount.length - 1;
    this.revealUpTo(n);
  }

  /** Move the tool indicator to the given G-code position. */
  setToolPosition(x: number, y: number, z: number): void {
    this._toolGcodeX = x; this._toolGcodeY = y; this._toolGcodeZ = z;

    // Tool group tip at scene (x, z, -y)
    this.toolGroup.position.set(x, z, -y);

    // Zero-ring tracks X/Y at scene Y=0 (G-code Z=0)
    if (this._zeroRing) this._zeroRing.position.set(x, 0, -y);

    // Spindle line: vertical from shank top (loc*2 above tip) down to tool tip
    // This makes the absolute Z position unambiguous — the line gets longer as tool plunges
    if (this._spindleLine) {
      const shankTop = z + this.toolLocMm * 2; // top of the shank in G-code Z = scene Y
      const tip      = z;
      const pts = new Float32Array([x, shankTop, -y, x, tip, -y]);
      this._spindleLine.geometry.setAttribute(
        'position', new THREE.BufferAttribute(pts, 3),
      );
      this._spindleLine.geometry.attributes.position.needsUpdate = true;
    }

    // Depth-of-cut cylinder: solid red column from Z=0 down to tool tip
    // Geometry is built at radius=1, height=1 and scaled per-frame — no recreate needed
    if (this._depthCyl) {
      if (z < -0.001) {
        const depth = Math.abs(z);
        const r     = this.toolDiameterMm / 2;
        // Scale X/Z by radius, Y by depth; centre the cylinder between 0 and tip
        this._depthCyl.scale.set(r, depth, r);
        this._depthCyl.position.set(x, -depth / 2, -y);
        this._depthCyl.visible = true;
      } else {
        this._depthCyl.visible = false;
      }
    }
  }

  /**
   * Fit the camera to the toolpath bounding box.
   * Called automatically when a new toolpath is loaded.
   */
  fitCamera(machineMode: MachineMode): void {
    if (!this.tpData) return;
    const [minX, minY, minZ] = this.tpData.boundsMin;
    const [maxX, maxY, maxZ] = this.tpData.boundsMax;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const dist = span * 1.5;

    this.controls.target.set(cx, cz, -cy);

    if (machineMode === 'lathe') {
      // Side view: look along -Y (in scene = -Z in G-code)
      this.camera.position.set(cx, cz, -cy + dist);
    } else {
      // 3/4 view — enough elevation to see XY layout, enough side-angle to see Z plunges
      // scene Y = G-code Z: offset upward by 0.5×dist so Z motion is clearly visible
      this.camera.position.set(cx + dist * 0.8, cz + dist * 0.5, -cy + dist * 0.9);
    }

    // Scale grid to fit the toolpath span (no hardcoded unit minimum)
    const gridSize = span * 3;
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(gridSize, Math.min(40, Math.ceil(gridSize / 10)),
      0x1a2030, 0x131c28);
    this.grid.position.set(cx, 0, -cy);  // always at G-code Z=0 (scene Y=0)
    this.scene.add(this.grid);

    // Scale axes to fit scene
    const axesScale = Math.max(span / 8, 4);
    this.scene.remove(this.axes);
    this.axes = this._createGCodeAxes(axesScale);
    this.axes.position.set(0, 0, 0); // world origin = G-code origin
    this.scene.add(this.axes);

    this.controls.update();
  }

  resetCamera(): void {
    this.fitCamera(this.tpData?.machineMode ?? 'mill');
  }

  snapCameraTo(face: 'top' | 'front' | 'back' | 'right' | 'left' | 'bottom'): void {
    const t = this.controls.target.clone();
    const span = this.camera.position.distanceTo(t);
    const d = span;
    switch (face) {
      case 'top':    this.camera.position.set(t.x,       t.y + d, t.z      ); break;
      case 'bottom': this.camera.position.set(t.x,       t.y - d, t.z      ); break;
      case 'front':  this.camera.position.set(t.x,       t.y,     t.z + d  ); break;
      case 'back':   this.camera.position.set(t.x,       t.y,     t.z - d  ); break;
      case 'right':  this.camera.position.set(t.x + d,   t.y,     t.z      ); break;
      case 'left':   this.camera.position.set(t.x - d,   t.y,     t.z      ); break;
    }
    this.controls.update();
  }

  snapIsometric(): void {
    const t = this.controls.target.clone();
    const d = this.camera.position.distanceTo(t);
    // Classic isometric: equal 45° azimuth + ~35.26° elevation (1/√2 ratio)
    const h = d / Math.sqrt(3);
    this.camera.position.set(t.x + h, t.y + h, t.z + h);
    this.controls.update();
  }

  syncViewCube(cube: { syncRotation(cam: THREE.Camera, target: THREE.Vector3): void }): void {
    cube.syncRotation(this.camera, this.controls.target);
  }

  setAxesVisible(visible: boolean): void {
    this.axes.visible = visible;
  }

  setRapidsVisible(visible: boolean): void {
    if (this.rapidLines) this.rapidLines.visible = visible;
  }

  setToolVisible(visible: boolean): void {
    this.toolGroup.visible = visible;
    if (this._depthCyl)    this._depthCyl.visible    = visible && this.toolGroup.position.y < 0;
    if (this._spindleLine) this._spindleLine.visible  = visible;
    if (this._zeroRing)    this._zeroRing.visible     = visible;
  }

  /** Rebuild the tool indicator with the correct diameter and length of cut. */
  setToolGeometry(diameter: number, loc: number, toolType: ToolType = 'endmill', cornerRadius = 0): void {
    if (Math.abs(diameter - this.toolDiameterMm) > 1e-6 || toolType !== this._toolType) {
      console.log(`[Renderer3D] setToolGeometry: diameter=${diameter.toFixed(4)}, loc=${loc.toFixed(4)}, type=${toolType}, cr=${cornerRadius.toFixed(4)}`);
    }
    this.toolDiameterMm  = Math.max(0.01, diameter);
    this.toolLocMm       = Math.max(0.01, loc);
    this._toolType       = toolType;
    this._cornerRadiusMm = Math.max(0, cornerRadius);
    this._buildToolMeshes(this.toolDiameterMm, this.toolLocMm, toolType, this._cornerRadiusMm);
    if (this._zeroRing) this._zeroRing.scale.setScalar(this.toolDiameterMm / 2 * 1.4);
    this.setToolPosition(this._toolGcodeX, this._toolGcodeY, this._toolGcodeZ);
  }

  /**
   * Build (or rebuild) the tool meshes at actual mm scale.
   * All parts use depthTest:false so the tool renders through the stock.
   * Group origin = tool tip (G-code position). Everything extends upward (+Y in scene).
   *
   *   [tip]── loc mm ──[flute/shank boundary]── shank (1× loc) ──[top]
   *   Yellow = cutting zone (LOC), grey = shank
   */
  private _buildToolMeshes(diameter: number, loc: number, toolType: ToolType = 'endmill', cornerRadius = 0): void {
    // Dispose old children
    while (this.toolGroup.children.length > 0) {
      const c = this.toolGroup.children[0] as THREE.Mesh;
      c.geometry?.dispose();
      (c.material as THREE.Material)?.dispose();
      this.toolGroup.remove(c);
    }

    const r      = diameter / 2;
    const shankH = loc;

    const mat = (color: number, opacity = 1.0): THREE.Material =>
      new THREE.MeshBasicMaterial({
        color, transparent: opacity < 1, opacity, depthTest: false,
      });

    // Shared shank (above flute/tip zone)
    const shankR = r * 0.82;
    const shankMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(shankR, shankR, shankH, 20),
      mat(0x7080a0, 0.70),
    );
    shankMesh.renderOrder = 10;
    shankMesh.position.y  = loc + shankH / 2;

    // Edge ring at flute/shank boundary
    const edgePts: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      edgePts.push(new THREE.Vector3(Math.cos(a) * r, loc, Math.sin(a) * r));
    }
    const edgeLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(edgePts),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    edgeLine.renderOrder = 12;

    this.toolGroup.add(shankMesh, edgeLine);

    if (toolType === 'endmill') {
      // Flat bottom cylinder + face disc
      const flute = new THREE.Mesh(new THREE.CylinderGeometry(r, r, loc, 24), mat(0xf0c040, 0.85));
      flute.renderOrder = 10;
      flute.position.y  = loc / 2;
      const face = new THREE.Mesh(new THREE.CircleGeometry(r, 24),
        new THREE.MeshBasicMaterial({ color: 0xffee00, side: THREE.DoubleSide, depthTest: false }));
      face.renderOrder = 11;
      face.rotation.x  = Math.PI / 2;
      this.toolGroup.add(flute, face);

    } else if (toolType === 'ballmill') {
      // Cylinder down to sphere centre + bottom hemisphere
      const ballR = r;
      const cylinderH = Math.max(0.01, loc - ballR);
      const flute = new THREE.Mesh(new THREE.CylinderGeometry(r, r, cylinderH, 24), mat(0x40c0ff, 0.85));
      flute.renderOrder = 10;
      flute.position.y  = ballR + cylinderH / 2;
      // Full sphere at y=ballR; the cylinder hides the upper half visually
      const ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 24, 12), mat(0x20aaee, 0.90));
      ball.renderOrder = 10;
      ball.position.y  = ballR;
      this.toolGroup.add(flute, ball);

    } else if (toolType === 'bullnose') {
      // cr = actual corner radius, clamped to half of tool radius
      const cr = Math.min(Math.max(cornerRadius, 0.01), r * 0.49);
      // Straight flute from top of corner arc to top of LOC
      const fluteH = Math.max(0.01, loc - cr);
      const flute = new THREE.Mesh(new THREE.CylinderGeometry(r, r, fluteH, 24), mat(0xf07020, 0.85));
      flute.renderOrder = 10;
      flute.position.y  = cr + fluteH / 2;
      // Flat face in the centre of the tip (radius minus corner radius)
      const innerR = r - cr;
      if (innerR > 0.01) {
        const face = new THREE.Mesh(new THREE.CircleGeometry(innerR, 24),
          new THREE.MeshBasicMaterial({ color: 0xff9040, side: THREE.DoubleSide, depthTest: false }));
        face.renderOrder = 11;
        face.rotation.x  = Math.PI / 2;
        this.toolGroup.add(face);
      }
      // Corner torus at the tip edge — torusR = r - cr (centre of tube), tubeR = cr
      const cornerTorus = new THREE.Mesh(
        new THREE.TorusGeometry(r - cr, cr, 12, 32),
        mat(0xff9040, 0.90),
      );
      cornerTorus.renderOrder = 11;
      cornerTorus.rotation.x  = Math.PI / 2;
      cornerTorus.position.y  = cr; // bottom of torus tube touches y=0 (tip)
      this.toolGroup.add(flute, cornerTorus);

    } else if (toolType === 'drill') {
      // 118° included angle → 59° half-angle → coneH = r / tan(59°) ≈ r * 0.601
      const coneH = r / Math.tan(59 * Math.PI / 180);
      const fluteH = Math.max(0.01, loc - coneH);
      // Cone tip: CylinderGeometry(0=tip at top, r=base at bottom, coneH)
      // Tip of cylinder is at y=+coneH/2 by default; I want tip at y=0
      // So: place at y = coneH/2, then rotate 180° around Z to flip (tip down)
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0, r, coneH, 24), mat(0xc0c8d0, 0.90));
      cone.renderOrder = 10;
      cone.rotation.z  = Math.PI; // flip: tip now at y=-coneH/2, base at y=+coneH/2
      cone.position.y  = coneH / 2; // shift up so tip is at y=0
      // Flute above cone
      const flute = new THREE.Mesh(new THREE.CylinderGeometry(r, r, fluteH, 24), mat(0xa0a8b8, 0.85));
      flute.renderOrder = 10;
      flute.position.y  = coneH + fluteH / 2;
      this.toolGroup.add(cone, flute);

    } else if (toolType === 'spotdrill') {
      // 90° included angle → 45° half-angle → coneH = r
      const coneH = r;
      const fluteH = Math.max(0.01, loc - coneH);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0, r, coneH, 24), mat(0xe0e8f0, 0.90));
      cone.renderOrder = 10;
      cone.rotation.z  = Math.PI;
      cone.position.y  = coneH / 2;
      const flute = new THREE.Mesh(new THREE.CylinderGeometry(r, r, fluteH, 24), mat(0xb0b8c8, 0.85));
      flute.renderOrder = 10;
      flute.position.y  = coneH + fluteH / 2;
      this.toolGroup.add(cone, flute);

    } else if (toolType === 'chamfer') {
      // V-bit: tip at y=0, flares to full r at y=coneH (90° included)
      const coneH = r; // 45° half-angle
      const fluteH = Math.max(0.01, loc - coneH);
      // CylinderGeometry(topR, bottomR, h): top at y=+h/2, bottom at y=-h/2
      // Want: bottom at y=0 (tip, r=0), top at y=coneH (r=r)
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(r, 0, coneH, 24), mat(0xa060d0, 0.90));
      cone.renderOrder = 10;
      cone.position.y  = coneH / 2; // bottom of cone at y=0
      const flute = new THREE.Mesh(new THREE.CylinderGeometry(r, r, fluteH, 24), mat(0x8040b0, 0.85));
      flute.renderOrder = 10;
      flute.position.y  = coneH + fluteH / 2;
      this.toolGroup.add(cone, flute);

    } else if (toolType === 'facemill') {
      // Wide flat disc, short flute zone
      const fluteH = Math.min(loc, r * 0.5); // face mills are short relative to diameter
      const flute = new THREE.Mesh(new THREE.CylinderGeometry(r, r, fluteH, 32), mat(0x40d080, 0.85));
      flute.renderOrder = 10;
      flute.position.y  = fluteH / 2;
      const face = new THREE.Mesh(new THREE.CircleGeometry(r, 32),
        new THREE.MeshBasicMaterial({ color: 0x60f0a0, side: THREE.DoubleSide, depthTest: false }));
      face.renderOrder = 11;
      face.rotation.x  = Math.PI / 2;
      // Insert pockets around periphery (8 equally spaced marks)
      const insertPts: THREE.Vector3[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        insertPts.push(
          new THREE.Vector3(Math.cos(a) * r * 0.88, fluteH, Math.sin(a) * r * 0.88),
          new THREE.Vector3(Math.cos(a) * r,        fluteH, Math.sin(a) * r),
        );
      }
      const insertLines = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(insertPts),
        new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
      );
      insertLines.renderOrder = 12;
      this.toolGroup.add(flute, face, insertLines);
    }

    // Scale zero-ring to match diameter
    if (this._zeroRing) this._zeroRing.scale.setScalar(r * 1.4);
  }

  /**
   * Build the stock: solid body (sides + bottom), dynamic top-surface height map,
   * and a wireframe outline.
   * All values in G-code units. ox/oy/oz = corner closest to origin.
   */
  setStock(sx: number, sy: number, sz: number,
           ox: number, oy: number, oz: number,
           resolution = 128): void {
    // ── Tear down old stock ──────────────────────────────────
    for (const m of [this.stockTopMesh, this.stockBodyMesh, this.stockWire] as THREE.Object3D[]) {
      if (m) { this.scene.remove(m); (m as THREE.Mesh).geometry?.dispose(); }
    }
    this.stockTopMesh = this.stockBodyMesh = this.stockWire = null;

    if (sx <= 0 || sy <= 0 || sz <= 0) return;

    const topZ = oz + sz; // G-code Z of top surface
    this._stockTopZ = topZ;
    this._stockRes  = resolution;

    // ── 1. Top surface (dynamic height-map mesh, vertex-coloured) ────────────
    const topGeo = this._buildHeightMapGeo(resolution, sx, sy, ox, oy, topZ);
    this.stockTopMesh = new THREE.Mesh(
      topGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    );
    this.scene.add(this.stockTopMesh);

    // ── 2. Body — semi-transparent so the tool tip is always visible inside ──
    const bodyGeo = new THREE.BoxGeometry(sx, sz - 0.01, sy);
    this.stockBodyMesh = new THREE.Mesh(
      bodyGeo,
      new THREE.MeshLambertMaterial({ color: 0x8090a0, transparent: true, opacity: 0.35 }),
    );
    this.stockBodyMesh.position.set(
      ox + sx / 2,
      oz + (sz - 0.01) / 2,
      -(oy + sy / 2),
    );
    this.scene.add(this.stockBodyMesh);

    // ── 3. Wireframe outline ─────────────────────────────────
    const boxGeo  = new THREE.BoxGeometry(sx, sz, sy);
    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    this.stockWire = new THREE.LineSegments(
      edgesGeo,
      new THREE.LineBasicMaterial({ color: 0x55aaff, transparent: true, opacity: 0.5 }),
    );
    this.stockWire.position.set(ox + sx / 2, oz + sz / 2, -(oy + sy / 2));
    this.scene.add(this.stockWire);
  }

  /**
   * Push an updated height map (G-code Z values, one per cell) to the GPU.
   * Call this every frame when StockSimulator.dirty is true.
   * @param maxDepth  Depth (in the same G-code units as the heights) at which
   *                  the cut colour reaches its darkest shade. Pass 10/25.4 for
   *                  inch-unit scenes, 10 for mm-unit scenes.
   */
  updateStockSurface(heights: Float32Array, maxDepth = 10): void {
    if (!this.stockTopMesh) return;
    const geo = this.stockTopMesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color    as THREE.BufferAttribute;
    const topZ = this._stockTopZ;
    const [ur, ug, ub] = Renderer3D.COL_UNCUT;
    const [sr, sg, sb] = Renderer3D.COL_CUT_SHALLOW;
    const [dr, dg, db] = Renderer3D.COL_CUT_DEEP;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      pos.setY(i, h);
      const depth = topZ - h; // positive = below surface
      if (depth > 0.001) {
        // t: 0 = just grazed surface (bright orange), 1 = maxDepth (dark red)
        const t = Math.min(1, depth / maxDepth);
        col.setXYZ(i,
          sr + (dr - sr) * t,
          sg + (dg - sg) * t,
          sb + (db - sb) * t,
        );
      } else {
        col.setXYZ(i, ur, ug, ub);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** Reset the top surface back to the original flat top (e.g. after rewind). */
  resetStockSurface(): void {
    if (!this.stockTopMesh) return;
    const geo = this.stockTopMesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color    as THREE.BufferAttribute;
    const N = this._stockRes;
    const [ur, ug, ub] = Renderer3D.COL_UNCUT;
    for (let i = 0; i < N * N; i++) {
      pos.setY(i, this._stockTopZ);
      col.setXYZ(i, ur, ug, ub); // reset to uncut
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
  }

  setStockVisible(visible: boolean): void {
    this.setStockSolidVisible(visible);
    this.setStockWireVisible(visible);
  }

  setStockSolidVisible(visible: boolean): void {
    if (this.stockTopMesh)  this.stockTopMesh.visible  = visible;
    if (this.stockBodyMesh) this.stockBodyMesh.visible = visible;
  }

  setStockWireVisible(visible: boolean): void {
    if (this.stockWire) this.stockWire.visible = visible;
  }

  // ── Height-map geometry builder ──────────────────────────────────────────

  /**
   * N×N vertices in scene XZ plane (Y = height).
   * col i  → scene X = ox + i * sx/(N-1)
   * row j  → scene Z = -(oy + j * sy/(N-1))
   * height → scene Y = topZ initially
   */
  // Uncut stock surface: dark steel blue-gray
  private static readonly COL_UNCUT    = [0.22, 0.27, 0.35] as const;
  // Shallow cut: vivid orange
  private static readonly COL_CUT_SHALLOW = [1.00, 0.42, 0.05] as const;
  // Deep cut: dark red-brown
  private static readonly COL_CUT_DEEP    = [0.48, 0.08, 0.00] as const;

  private _buildHeightMapGeo(N: number, sx: number, sy: number,
                               ox: number, oy: number, topZ: number): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const verts = N * N;
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3); // RGB per vertex

    const [ur, ug, ub] = Renderer3D.COL_UNCUT;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        pos[k * 3]     = ox + i * sx / (N - 1);
        pos[k * 3 + 1] = topZ;
        pos[k * 3 + 2] = -(oy + j * sy / (N - 1));
        col[k * 3]     = ur;
        col[k * 3 + 1] = ug;
        col[k * 3 + 2] = ub;
      }
    }

    const idxCount = (N - 1) * (N - 1) * 6;
    const indices  = new Uint32Array(idxCount);
    let p = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
        indices[p++] = a; indices[p++] = b; indices[p++] = d;
        indices[p++] = a; indices[p++] = d; indices[p++] = c;
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    return geo;
  }

  // ── Private ──────────────────────────────────────────────────

  private _startLoop(): void {
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private _resize(): void {
    const container = this.canvas.parentElement;
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
