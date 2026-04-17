// ─── View Cube ────────────────────────────────────────────────────────────────
// A small overlay canvas in the corner showing an orientation cube.
// Clicking a face snaps the main camera to that view.

import * as THREE from 'three';

type Face = 'top' | 'front' | 'back' | 'right' | 'left' | 'bottom';

interface FaceDef {
  face: Face;
  label: string;
  color: number;
  position: [number, number, number];
  rotation: [number, number, number]; // Euler XYZ
}

const S = 0.5; // half-size
const FACES: FaceDef[] = [
  { face: 'top',    label: 'TOP',   color: 0x2255cc, position: [ 0,  S,  0], rotation: [-Math.PI/2, 0, 0] },
  { face: 'bottom', label: 'BTM',   color: 0x224499, position: [ 0, -S,  0], rotation: [ Math.PI/2, 0, 0] },
  { face: 'front',  label: 'FRONT', color: 0x226622, position: [ 0,  0,  S], rotation: [0, 0, 0] },
  { face: 'back',   label: 'BACK',  color: 0x1a4d1a, position: [ 0,  0, -S], rotation: [0, Math.PI, 0] },
  { face: 'right',  label: 'RIGHT', color: 0x882222, position: [ S,  0,  0], rotation: [0,  Math.PI/2, 0] },
  { face: 'left',   label: 'LEFT',  color: 0x661a1a, position: [-S,  0,  0], rotation: [0, -Math.PI/2, 0] },
];

export class ViewCube {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private faceMeshes: THREE.Mesh[] = [];
  private onFaceClick: (face: Face) => void;

  constructor(container: HTMLElement, size: number, onFaceClick: (face: Face) => void, onIso?: () => void) {
    this.onFaceClick = onFaceClick;

    this.canvas = document.createElement('canvas');
    this.canvas.width  = size;
    this.canvas.height = size;
    this.canvas.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      width: ${size}px;
      height: ${size}px;
      cursor: pointer;
      border-radius: 4px;
    `;
    container.appendChild(this.canvas);

    // Iso button directly below the cube
    if (onIso) {
      const btn = document.createElement('button');
      btn.textContent = 'ISO';
      btn.title = 'Isometric View';
      btn.style.cssText = `
        position: absolute;
        top: ${8 + size + 4}px;
        right: 8px;
        width: ${size}px;
        padding: 5px 0;
        background: rgba(20,30,50,0.90);
        color: #c8d8ff;
        border: 1px solid #3a5080;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 2px;
        cursor: pointer;
        text-align: center;
      `;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(40,80,160,0.90)'; btn.style.color = '#ffffff'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(20,30,50,0.90)'; btn.style.color = '#c8d8ff'; });
      btn.addEventListener('click', onIso);
      container.appendChild(btn);
    }

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(size, size);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(3, 3, 3);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(5, 8, 5);
    this.scene.add(dir);

    // 6 plane faces — each at its correct position/rotation so raycasting works
    for (const fd of FACES) {
      const geo  = new THREE.PlaneGeometry(0.96, 0.96);
      const mat  = new THREE.MeshLambertMaterial({ color: fd.color, side: THREE.FrontSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...fd.position);
      mesh.rotation.set(...fd.rotation);
      mesh.userData['face'] = fd.face;
      this.faceMeshes.push(mesh);
      this.scene.add(mesh);

      // Label sprite centered on each face
      const sprite = this._makeLabel(fd.label);
      sprite.position.set(...fd.position);
      // Push sprite slightly in front of the plane so it's always visible
      const normal = new THREE.Vector3(...fd.position).normalize().multiplyScalar(0.02);
      sprite.position.add(normal);
      sprite.scale.setScalar(fd.label.length > 3 ? 0.38 : 0.32);
      this.scene.add(sprite);
    }

    // Wireframe outline
    const edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.scene.add(new THREE.LineSegments(
      edgesGeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
    ));

    // Axis lines
    const axes: [THREE.Vector3, number][] = [
      [new THREE.Vector3(1, 0, 0), 0xff4444],
      [new THREE.Vector3(0, 1, 0), 0x44ff44],
      [new THREE.Vector3(0, 0, 1), 0x4488ff],
    ];
    for (const [dir2, color] of axes) {
      const pts = [new THREE.Vector3(0,0,0), dir2.clone().multiplyScalar(1.5)];
      this.scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color }),
      ));
    }

    // Axis letter labels
    const letters: [string, THREE.Vector3][] = [
      ['X', new THREE.Vector3(1.7, 0, 0)],
      ['Y', new THREE.Vector3(0, 1.7, 0)],
      ['Z', new THREE.Vector3(0, 0, 1.7)],
    ];
    for (const [text, pos] of letters) {
      const s = this._makeLabel(text);
      s.position.copy(pos);
      s.scale.setScalar(0.40);
      this.scene.add(s);
    }

    this.canvas.addEventListener('click', (e) => this._onClick(e));

    const loop = () => {
      requestAnimationFrame(loop);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  syncRotation(mainCamera: THREE.Camera, target: THREE.Vector3): void {
    const dir = mainCamera.position.clone().sub(target).normalize();
    this.camera.position.copy(dir.multiplyScalar(3.5));
    this.camera.lookAt(0, 0, 0);
  }

  private _makeLabel(text: string): THREE.Sprite {
    const cvs = document.createElement('canvas');
    cvs.width = 128; cvs.height = 64;
    const ctx = cvs.getContext('2d')!;
    ctx.clearRect(0, 0, 128, 64);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 32);
    const tex = new THREE.CanvasTexture(cvs);
    return new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
    );
  }

  private _onClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x =  ((e.clientX - rect.left)  / rect.width)  * 2 - 1;
    const y = -((e.clientY - rect.top)   / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hits = raycaster.intersectObjects(this.faceMeshes);
    if (hits.length > 0) {
      this.onFaceClick(hits[0].object.userData['face'] as Face);
    }
  }
}
