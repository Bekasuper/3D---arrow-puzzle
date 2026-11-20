import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CellData, DIRS, DirIndex, GeneratedLevel } from './levelGenerator';
import { soundEngine } from './soundEngine';

export interface EngineCallbacks {
  onBlockRemoved: (remaining: number, total: number, moves: number) => void;
  onMistake: (livesLeft: number, mistakes: number) => void;
  onWin: (moves: number, mistakes: number, elapsedSec: number) => void;
  onLose: (moves: number, mistakes: number) => void;
  onWebGLContextError?: (message: string) => void;
}

type BlockStatus = 'active' | 'flying' | 'done';

interface BlockState {
  index: number;
  id: number;
  gx: number;
  gy: number;
  gz: number;
  dir: DirIndex;
  status: BlockStatus;
  baseColor: THREE.Color;
  basePos: THREE.Vector3;
  localQuat: THREE.Quaternion;
  localDir: THREE.Vector3;
  // Spawn & hit bounce animations
  spawnScale: number;
  spawnDelay: number;
  hitActive: boolean;
  hitTime: number;
  hitDuration: number;
  hitMaxOffset: number;
  isHinted: boolean;
  // World-space flight state (kept inside same InstancedMesh!)
  worldPos: THREE.Vector3;
  worldVel: THREE.Vector3;
  worldQuat: THREE.Quaternion;
  flyAge: number;
}

interface BurstParticle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  quat: THREE.Quaternion;
  color: THREE.Color;
  age: number;
  life: number;
}

const PASTEL_PALETTE = [
  0xff8e7e, // Coral Peach
  0x6bb6ff, // Sky Cerulean
  0x5cd6b3, // Mint Jade
  0xffcf66, // Butter Gold
  0xa98cff, // Soft Lavender
  0xf28db2, // Rose Blossom
];

const BLOCK_SIZE = 0.88;
const GRID_SPACING = 1.02;
const MAX_PARTICLES = 42;
const DRAG_THRESHOLD_PX = 8;

// Pre-allocated math helpers (zero GC inside animation loop & handlers)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _scaleVec = new THREE.Vector3(1, 1, 1);
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _hiddenPos = new THREE.Vector3(0, -9999, 0);
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _invPivotQuat = new THREE.Quaternion();
const _localQuatTmp = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();
const _invPivotMat = new THREE.Matrix4();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _upVec = new THREE.Vector3(0, 1, 0);
const _raycaster = new THREE.Raycaster();
const _pointerNdc = new THREE.Vector2();
const _tmpColor = new THREE.Color();
const _errColor = new THREE.Color(0xff2e43);
const _hintColor = new THREE.Color(0x10b981);
const _whiteColor = new THREE.Color(0xffffff);
const _targetAlignDir = new THREE.Vector3(0.25, 0.25, 0.93).normalize();

function detectSoftwareWebGL(): boolean {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function detectMobileDevice(): boolean {
  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    ) || window.matchMedia?.('(pointer: coarse)').matches === true
  );
}

function createArrowSideTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 28;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(0, 62);
  ctx.lineTo(0, -48);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-48, -10);
  ctx.lineTo(0, -58);
  ctx.lineTo(48, -10);
  ctx.stroke();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function createNoseCapTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(0, 0, 44, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function createTailCapTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(0, 0, 28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    12,
    size / 2,
    size / 2,
    size / 2
  );
  grad.addColorStop(0, 'rgba(30, 41, 59, 0.24)');
  grad.addColorStop(0.5, 'rgba(30, 41, 59, 0.09)');
  grad.addColorStop(1, 'rgba(30, 41, 59, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Merges the 4 lateral arrow quads (+Z, -Z, +X, -X) into a single BufferGeometry
 * so all lateral arrows across all cubes render in ONE InstancedMesh draw call.
 */
function createMergedSideArrowsGeometry(faceDist: number): THREE.BufferGeometry {
  const configs: [number, number, number, number][] = [
    [0, 0, faceDist, 0],
    [0, 0, -faceDist, Math.PI],
    [faceDist, 0, 0, Math.PI / 2],
    [-faceDist, 0, 0, -Math.PI / 2],
  ];

  const parts = configs.map(([px, py, pz, rotY]) => {
    const g = new THREE.PlaneGeometry(0.56, 0.56);
    if (rotY !== 0) g.rotateY(rotY);
    g.translate(px, py, pz);
    return g;
  });

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

export class CubeEngine {
  private container: HTMLElement;
  private callbacks: EngineCallbacks;
  private isSoftwareGl: boolean;
  private isMobile: boolean;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private envTexture: THREE.Texture;

  private pivotGroup: THREE.Group;
  private shadowPlane: THREE.Mesh;

  // Shared geometries, materials & textures (reused across all levels)
  private blockGeo: RoundedBoxGeometry;
  private sideArrowsGeo: THREE.BufferGeometry;
  private noseGeo: THREE.PlaneGeometry;
  private tailGeo: THREE.PlaneGeometry;
  private particleGeo: THREE.BoxGeometry;

  private bodyMat: THREE.MeshStandardMaterial;
  private sideDecalMat: THREE.MeshStandardMaterial;
  private noseDecalMat: THREE.MeshStandardMaterial;
  private tailDecalMat: THREE.MeshStandardMaterial;
  private particleMat: THREE.MeshStandardMaterial;

  private arrowTex: THREE.CanvasTexture;
  private noseTex: THREE.CanvasTexture;
  private tailTex: THREE.CanvasTexture;
  private shadowTex: THREE.CanvasTexture;

  // Instanced meshes (rebuilt cleanly per level; geometries & materials reused)
  private bodyInstanced: THREE.InstancedMesh | null = null;
  private sideArrowsInstanced: THREE.InstancedMesh | null = null;
  private noseInstanced: THREE.InstancedMesh | null = null;
  private tailInstanced: THREE.InstancedMesh | null = null;
  private particleInstanced: THREE.InstancedMesh;

  // Game state
  private gridSize = 2;
  private grid: (BlockState | null)[][][] = [];
  private blockList: BlockState[] = [];
  private particles: BurstParticle[] = [];
  private activeParticleCount = 0;

  private totalBlocks = 0;
  private remainingBlocks = 0;
  private lives = 3;
  private moves = 0;
  private mistakes = 0;
  private levelStartTime = 0;
  private gameEnded = false;
  private hintedBlockIndex = -1;

  // Camera & rotation inertia
  private targetCamDist = 6.5;
  private currentCamDist = 6.5;
  private velYaw = 0;
  private velPitch = 0;
  private pivotRecoil = new THREE.Vector3();
  private pivotRecoilVel = new THREE.Vector3();
  private targetAutoQuat: THREE.Quaternion | null = null;

  // Pointer tracking (drag vs tap + pinch zoom)
  private activePointers = new Map<number, { x: number; y: number }>();
  private dragPointerId: number | null = null;
  private pointerDownPos = { x: 0, y: 0 };
  private prevPointerPos = { x: 0, y: 0 };
  private pointerDownTime = 0;
  private hasDragged = false;
  private prevPinchDist = 0;

  // Loop management
  private clock = new THREE.Clock();
  private frameId = 0;
  private disposed = false;

  constructor(container: HTMLElement, callbacks: EngineCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareWebGL();
    this.isMobile = detectMobileDevice();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      alpha: true,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;

    // Limit pixelRatio so high-DPI mobile / 4K screens maintain smooth 60 FPS
    const maxDpr = this.isMobile ? 1.5 : 2;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, maxDpr)
    );

    // Skip expensive extra shadow-map pass on software WebGL & low-end mobile devices
    const useShadows = !this.isSoftwareGl && !this.isMobile;
    this.renderer.shadowMap.enabled = useShadows;
    if (useShadows) {
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    const dom = this.renderer.domElement;
    dom.style.display = 'block';
    dom.style.width = '100%';
    dom.style.height = '100%';
    dom.style.touchAction = 'none';
    dom.style.cursor = 'grab';
    container.appendChild(dom);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 120);
    this.camera.position.set(0, 0.25, this.currentCamDist);
    this.camera.lookAt(0, 0, 0);

    // Studio environment reflection
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();

    // 3-point warm/cool studio lighting
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 0.9);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff9ee, 1.38);
    keyLight.position.set(6, 10, 8);
    keyLight.castShadow = useShadows;
    if (useShadows) {
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 30;
      const d = 6.8;
      keyLight.shadow.camera.left = -d;
      keyLight.shadow.camera.right = d;
      keyLight.shadow.camera.top = d;
      keyLight.shadow.camera.bottom = -d;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xdbeafe, 0.55);
    rimLight.position.set(-7, -5, -6);
    this.scene.add(rimLight);

    this.pivotGroup = new THREE.Group();
    this.scene.add(this.pivotGroup);

    // Contact shadow plane directly beneath puzzle
    this.shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(7.2, 7.2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.72,
    });
    this.shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = -3.2;
    this.scene.add(this.shadowPlane);

    // Shared geometries (2 bevel segments keeps mobile vertex load tiny while staying smooth)
    const faceDist = BLOCK_SIZE / 2 + 0.002;
    this.blockGeo = new RoundedBoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE, 2, 0.12);
    this.sideArrowsGeo = createMergedSideArrowsGeometry(faceDist);

    this.noseGeo = new THREE.PlaneGeometry(0.56, 0.56);
    this.noseGeo.rotateX(-Math.PI / 2);
    this.noseGeo.translate(0, faceDist, 0);

    this.tailGeo = new THREE.PlaneGeometry(0.56, 0.56);
    this.tailGeo.rotateX(Math.PI / 2);
    this.tailGeo.translate(0, -faceDist, 0);

    this.particleGeo = new THREE.BoxGeometry(0.11, 0.11, 0.11);

    // Shared textures & materials
    const maxAniso = Math.min(this.renderer.capabilities.getMaxAnisotropy(), this.isMobile ? 4 : 8);
    this.arrowTex = createArrowSideTexture(maxAniso);
    this.noseTex = createNoseCapTexture(maxAniso);
    this.tailTex = createTailCapTexture(maxAniso);

    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.34,
      metalness: 0.04,
    });

    this.sideDecalMat = new THREE.MeshStandardMaterial({
      map: this.arrowTex,
      transparent: true,
      roughness: 0.24,
      metalness: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.noseDecalMat = new THREE.MeshStandardMaterial({
      map: this.noseTex,
      transparent: true,
      roughness: 0.24,
      metalness: 0.02,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.tailDecalMat = new THREE.MeshStandardMaterial({
      map: this.tailTex,
      transparent: true,
      roughness: 0.28,
      metalness: 0.0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    // Pooled InstancedMesh for burst particles (zero allocations during gameplay)
    this.particleMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.35,
      metalness: 0.02,
    });
    this.particleInstanced = new THREE.InstancedMesh(
      this.particleGeo,
      this.particleMat,
      MAX_PARTICLES
    );
    this.particleInstanced.frustumCulled = false;
    this.particleInstanced.count = 0;
    this.scene.add(this.particleInstanced);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        quat: new THREE.Quaternion(),
        color: new THREE.Color(0xffffff),
        age: 0,
        life: 0.45,
      });
      _mat4.compose(_hiddenPos, _q1, _zeroScale);
      this.particleInstanced.setMatrixAt(i, _mat4);
      this.particleInstanced.setColorAt(i, _whiteColor);
    }
    this.particleInstanced.instanceMatrix.needsUpdate = true;
    if (this.particleInstanced.instanceColor) {
      this.particleInstanced.instanceColor.needsUpdate = true;
    }

    this.bindEvents();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.tick();
  }

  public loadLevel(level: GeneratedLevel) {
    this.disposeLevelInstancedMeshes();

    this.gridSize = level.size;
    this.totalBlocks = level.cells.length;
    this.remainingBlocks = level.cells.length;
    this.lives = 3;
    this.moves = 0;
    this.mistakes = 0;
    this.gameEnded = false;
    this.hintedBlockIndex = -1;
    this.levelStartTime = performance.now();

    // Reset particle pool
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i].active = false;
    }
    this.activeParticleCount = 0;
    this.particleInstanced.count = 0;

    // Reset cube orientation
    this.pivotGroup.quaternion.setFromEuler(new THREE.Euler(0.42, -0.62, 0.05, 'YXZ'));
    this.velYaw = 0;
    this.velPitch = 0;
    this.targetAutoQuat = null;
    this.pivotRecoil.set(0, 0, 0);
    this.pivotRecoilVel.set(0, 0, 0);
    this.pivotGroup.position.set(0, 0, 0);

    // Frame camera comfortably for N x N x N
    this.targetCamDist = level.size * 2.05 + 2.4;
    this.currentCamDist = this.targetCamDist;
    this.camera.position.set(0, 0.25, this.currentCamDist);
    this.camera.lookAt(0, 0, 0);

    const shadowScale = level.size * GRID_SPACING * 1.45;
    this.shadowPlane.scale.set(shadowScale / 7.2, shadowScale / 7.2, 1);
    this.shadowPlane.position.y = -(level.size * GRID_SPACING) * 0.68 - 0.6;

    const count = level.cells.length;
    const useShadows = this.renderer.shadowMap.enabled;

    this.bodyInstanced = new THREE.InstancedMesh(this.blockGeo, this.bodyMat, count);
    this.bodyInstanced.castShadow = useShadows;
    this.bodyInstanced.receiveShadow = useShadows;
    this.bodyInstanced.frustumCulled = false;

    this.sideArrowsInstanced = new THREE.InstancedMesh(this.sideArrowsGeo, this.sideDecalMat, count);
    this.sideArrowsInstanced.frustumCulled = false;

    this.noseInstanced = new THREE.InstancedMesh(this.noseGeo, this.noseDecalMat, count);
    this.noseInstanced.frustumCulled = false;

    this.tailInstanced = new THREE.InstancedMesh(this.tailGeo, this.tailDecalMat, count);
    this.tailInstanced.frustumCulled = false;

    this.pivotGroup.add(
      this.bodyInstanced,
      this.sideArrowsInstanced,
      this.noseInstanced,
      this.tailInstanced
    );

    const n = level.size;
    this.grid = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => Array<BlockState | null>(n).fill(null))
    );
    this.blockList = [];

    const halfOffset = (n - 1) / 2;

    level.cells.forEach((cell: CellData, idx: number) => {
      const baseColor = new THREE.Color(
        PASTEL_PALETTE[cell.colorIndex % PASTEL_PALETTE.length]
      );

      const [dx, dy, dz] = DIRS[cell.dir];
      const localDir = new THREE.Vector3(dx, dy, dz);
      const localQuat = new THREE.Quaternion();
      if (dy < -0.99) {
        localQuat.setFromAxisAngle(_axisX, Math.PI);
      } else {
        localQuat.setFromUnitVectors(_upVec, localDir);
      }

      const basePos = new THREE.Vector3(
        (cell.x - halfOffset) * GRID_SPACING,
        (cell.y - halfOffset) * GRID_SPACING,
        (cell.z - halfOffset) * GRID_SPACING
      );

      const state: BlockState = {
        index: idx,
        id: cell.id,
        gx: cell.x,
        gy: cell.y,
        gz: cell.z,
        dir: cell.dir,
        status: 'active',
        baseColor,
        basePos,
        localQuat,
        localDir,
        spawnScale: 0.01,
        spawnDelay: Math.min(idx * 0.008, 0.25),
        hitActive: false,
        hitTime: 0,
        hitDuration: 0.34,
        hitMaxOffset: 0.25,
        isHinted: false,
        worldPos: new THREE.Vector3(),
        worldVel: new THREE.Vector3(),
        worldQuat: new THREE.Quaternion(),
        flyAge: 0,
      };

      this.grid[cell.x][cell.y][cell.z] = state;
      this.blockList.push(state);

      this.bodyInstanced!.setColorAt(idx, baseColor);
      _scaleVec.setScalar(0.01);
      _mat4.compose(basePos, localQuat, _scaleVec);
      this.setBlockInstanceMatrix(idx, _mat4);
    });

    this.markInstanceMatricesDirty();
    if (this.bodyInstanced.instanceColor) {
      this.bodyInstanced.instanceColor.needsUpdate = true;
    }
  }

  private setBlockInstanceMatrix(idx: number, mat: THREE.Matrix4) {
    this.bodyInstanced!.setMatrixAt(idx, mat);
    this.sideArrowsInstanced!.setMatrixAt(idx, mat);
    this.noseInstanced!.setMatrixAt(idx, mat);
    this.tailInstanced!.setMatrixAt(idx, mat);
  }

  private markInstanceMatricesDirty() {
    if (!this.bodyInstanced) return;
    this.bodyInstanced.instanceMatrix.needsUpdate = true;
    this.sideArrowsInstanced!.instanceMatrix.needsUpdate = true;
    this.noseInstanced!.instanceMatrix.needsUpdate = true;
    this.tailInstanced!.instanceMatrix.needsUpdate = true;
  }

  private disposeLevelInstancedMeshes() {
    if (this.bodyInstanced) {
      this.pivotGroup.remove(this.bodyInstanced);
      this.bodyInstanced.dispose();
      this.bodyInstanced = null;
    }
    if (this.sideArrowsInstanced) {
      this.pivotGroup.remove(this.sideArrowsInstanced);
      this.sideArrowsInstanced.dispose();
      this.sideArrowsInstanced = null;
    }
    if (this.noseInstanced) {
      this.pivotGroup.remove(this.noseInstanced);
      this.noseInstanced.dispose();
      this.noseInstanced = null;
    }
    if (this.tailInstanced) {
      this.pivotGroup.remove(this.tailInstanced);
      this.tailInstanced.dispose();
      this.tailInstanced = null;
    }
    this.blockList = [];
  }

  public triggerHint(): boolean {
    if (this.gameEnded || this.remainingBlocks === 0) return false;

    if (this.hintedBlockIndex !== -1) {
      const prev = this.blockList[this.hintedBlockIndex];
      if (prev && prev.status === 'active') {
        prev.isHinted = false;
        if (this.bodyInstanced) {
          this.bodyInstanced.setColorAt(prev.index, prev.baseColor);
          if (this.bodyInstanced.instanceColor) {
            this.bodyInstanced.instanceColor.needsUpdate = true;
          }
          _scaleVec.setScalar(prev.spawnScale);
          _mat4.compose(prev.basePos, prev.localQuat, _scaleVec);
          this.setBlockInstanceMatrix(prev.index, _mat4);
          this.markInstanceMatricesDirty();
        }
      }
      this.hintedBlockIndex = -1;
    }

    const movable: BlockState[] = [];
    for (let i = 0; i < this.blockList.length; i++) {
      const b = this.blockList[i];
      if (b.status === 'active' && this.findBlockerSteps(b) === null) {
        movable.push(b);
      }
    }
    if (movable.length === 0) return false;

    const chosen = movable[Math.floor(Math.random() * movable.length)];
    chosen.isHinted = true;
    this.hintedBlockIndex = chosen.index;
    soundEngine.playHint();

    if (chosen.basePos.lengthSq() > 0.001) {
      _v1.copy(chosen.basePos).normalize();
      _q1.setFromUnitVectors(_v1, _targetAlignDir);
      this.targetAutoQuat = _q1.clone();
    }

    return true;
  }

  private findBlockerSteps(block: BlockState): number | null {
    const [dx, dy, dz] = DIRS[block.dir];
    let cx = block.gx + dx;
    let cy = block.gy + dy;
    let cz = block.gz + dz;
    let steps = 1;

    while (
      cx >= 0 && cx < this.gridSize &&
      cy >= 0 && cy < this.gridSize &&
      cz >= 0 && cz < this.gridSize
    ) {
      if (this.grid[cx][cy][cz] !== null) {
        return steps;
      }
      cx += dx;
      cy += dy;
      cz += dz;
      steps++;
    }
    return null;
  }

  private handleBlockTap(block: BlockState) {
    if (this.gameEnded || block.status !== 'active' || block.hitActive) return;

    this.moves++;
    const blockerSteps = this.findBlockerSteps(block);

    if (blockerSteps === null) {
      // Clear path -> launch block in world space using pre-allocated math helpers
      soundEngine.playWhoosh();
      this.grid[block.gx][block.gy][block.gz] = null;
      block.status = 'flying';
      block.flyAge = 0;

      if (this.hintedBlockIndex === block.index) {
        this.hintedBlockIndex = -1;
      }
      block.isHinted = false;
      if (this.bodyInstanced) {
        this.bodyInstanced.setColorAt(block.index, block.baseColor);
        if (this.bodyInstanced.instanceColor) {
          this.bodyInstanced.instanceColor.needsUpdate = true;
        }
      }

      this.pivotGroup.updateMatrixWorld(true);
      block.worldPos.copy(block.basePos).applyMatrix4(this.pivotGroup.matrixWorld);
      block.worldQuat.copy(this.pivotGroup.quaternion).multiply(block.localQuat);
      block.worldVel
        .copy(block.localDir)
        .applyQuaternion(this.pivotGroup.quaternion)
        .normalize()
        .multiplyScalar(7.2);

      this.spawnBurst(block.worldPos, block.baseColor);

      this.remainingBlocks--;
      this.callbacks.onBlockRemoved(this.remainingBlocks, this.totalBlocks, this.moves);

      if (this.remainingBlocks === 0) {
        this.gameEnded = true;
        const elapsed = Math.max(
          1,
          Math.round((performance.now() - this.levelStartTime) / 1000)
        );
        window.setTimeout(() => {
          if (!this.disposed) {
            soundEngine.playWin();
            this.callbacks.onWin(this.moves, this.mistakes, elapsed);
          }
        }, 260);
      }
    } else {
      // Blocked path -> nudge, red flash, recoil, lose 1 life
      soundEngine.playBlocked();
      block.hitActive = true;
      block.hitTime = 0;
      block.hitMaxOffset =
        blockerSteps === 1 ? 0.22 : (blockerSteps - 0.82) * GRID_SPACING;

      _v1.copy(block.localDir).applyQuaternion(this.pivotGroup.quaternion).normalize();
      this.pivotRecoilVel.addScaledVector(_v1, 1.35);

      this.mistakes++;
      this.lives = Math.max(0, this.lives - 1);
      this.callbacks.onMistake(this.lives, this.mistakes);

      if (this.lives <= 0) {
        this.gameEnded = true;
        window.setTimeout(() => {
          if (!this.disposed) {
            soundEngine.playLose();
            this.callbacks.onLose(this.moves, this.mistakes);
          }
        }, 320);
      }
    }
  }

  private spawnBurst(worldPos: THREE.Vector3, color: THREE.Color) {
    const count = this.isSoftwareGl || this.isMobile ? 4 : 6;
    let spawned = 0;

    for (let i = 0; i < MAX_PARTICLES && spawned < count; i++) {
      const p = this.particles[i];
      if (!p.active) {
        p.active = true;
        p.age = 0;
        p.life = 0.38 + Math.random() * 0.16;
        p.pos.copy(worldPos);
        p.vel.set(
          (Math.random() - 0.5) * 4.5,
          (Math.random() - 0.5) * 4.5 + 1.1,
          (Math.random() - 0.5) * 4.5
        );
        p.rot.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        p.color.copy(color);
        this.particleInstanced.setColorAt(i, p.color);
        spawned++;
      }
    }

    if (spawned > 0) {
      this.activeParticleCount = MAX_PARTICLES;
      this.particleInstanced.count = MAX_PARTICLES;
      if (this.particleInstanced.instanceColor) {
        this.particleInstanced.instanceColor.needsUpdate = true;
      }
    }
  }

  private bindEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('touchmove', this.onTouchMove, { passive: false });
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('resize', this.onResize);
    dom.addEventListener('webglcontextlost', this.onContextLost);
    dom.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.callbacks.onWebGLContextError?.('Контекст 3D-графики временно приостановлен.');
  };

  private onContextRestored = () => {
    this.callbacks.onWebGLContextError?.('');
  };

  private onPointerDown = (e: PointerEvent) => {
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size === 1) {
      this.dragPointerId = e.pointerId;
      this.pointerDownPos.x = e.clientX;
      this.pointerDownPos.y = e.clientY;
      this.prevPointerPos.x = e.clientX;
      this.prevPointerPos.y = e.clientY;
      this.pointerDownTime = performance.now();
      this.hasDragged = false;
      this.targetAutoQuat = null;
    } else if (this.activePointers.size === 2) {
      this.hasDragged = true;
      const iter = this.activePointers.values();
      const p0 = iter.next().value!;
      const p1 = iter.next().value!;
      this.prevPinchDist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const ptr = this.activePointers.get(e.pointerId);
    if (ptr) {
      ptr.x = e.clientX;
      ptr.y = e.clientY;
    }

    if (this.activePointers.size === 2) {
      const iter = this.activePointers.values();
      const p0 = iter.next().value!;
      const p1 = iter.next().value!;
      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      if (this.prevPinchDist > 0) {
        this.adjustZoom((this.prevPinchDist - dist) * 0.025);
      }
      this.prevPinchDist = dist;
      return;
    }

    if (this.dragPointerId === e.pointerId) {
      const totalMove = Math.hypot(
        e.clientX - this.pointerDownPos.x,
        e.clientY - this.pointerDownPos.y
      );
      if (totalMove > DRAG_THRESHOLD_PX) {
        this.hasDragged = true;
      }

      const dx = e.clientX - this.prevPointerPos.x;
      const dy = e.clientY - this.prevPointerPos.y;
      this.prevPointerPos.x = e.clientX;
      this.prevPointerPos.y = e.clientY;

      if (this.hasDragged) {
        const sens = 0.0068;
        const dYaw = dx * sens;
        const dPitch = dy * sens;
        this.applyWorldRotation(dYaw, dPitch);
        this.velYaw = dYaw * 52;
        this.velPitch = dPitch * 52;
        this.renderer.domElement.style.cursor = 'grabbing';
      }
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const wasDragPointer = this.dragPointerId === e.pointerId;
    this.activePointers.delete(e.pointerId);

    if (this.activePointers.size < 2) {
      this.prevPinchDist = 0;
    }

    if (wasDragPointer) {
      const elapsed = performance.now() - this.pointerDownTime;
      const moveDist = Math.hypot(
        e.clientX - this.pointerDownPos.x,
        e.clientY - this.pointerDownPos.y
      );

      this.dragPointerId = null;
      this.renderer.domElement.style.cursor = 'grab';

      // Perform raycasting ONLY on a confirmed tap/click (not per frame!)
      if (
        !this.hasDragged &&
        moveDist <= DRAG_THRESHOLD_PX &&
        elapsed < 380 &&
        e.button !== 2
      ) {
        const hitBlock = this.raycastBlock(e.clientX, e.clientY);
        if (hitBlock) {
          this.handleBlockTap(hitBlock);
        }
      }
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.adjustZoom(e.deltaY * 0.005);
  };

  private adjustZoom(delta: number) {
    const minDist = this.gridSize * 1.45 + 1.4;
    const maxDist = this.gridSize * 3.4 + 4.5;
    this.targetCamDist = THREE.MathUtils.clamp(this.targetCamDist + delta, minDist, maxDist);
  }

  private raycastBlock(clientX: number, clientY: number): BlockState | null {
    if (!this.bodyInstanced) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    _pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    _pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    _raycaster.setFromCamera(_pointerNdc, this.camera);
    const intersects = _raycaster.intersectObject(this.bodyInstanced, false);

    for (let i = 0; i < intersects.length; i++) {
      const instanceId = intersects[i].instanceId;
      if (instanceId !== undefined) {
        const block = this.blockList[instanceId];
        if (block && block.status === 'active') {
          return block;
        }
      }
    }
    return null;
  }

  private applyWorldRotation(yaw: number, pitch: number) {
    _q1.setFromAxisAngle(_axisY, yaw);
    _q2.setFromAxisAngle(_axisX, pitch);
    this.pivotGroup.quaternion.premultiply(_q1);
    this.pivotGroup.quaternion.premultiply(_q2);
    this.pivotGroup.quaternion.normalize();
  }

  private onResize = () => {
    if (this.disposed) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private afterDraw(cb: () => void) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (this.disposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          this.frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameId = window.setTimeout(cb, 80);
        }
      };
      this.frameId = window.setTimeout(poll, 5);
    } else {
      this.frameId = window.setTimeout(cb, 80);
    }
  }

  private tick = () => {
    if (this.disposed) return;

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    // 1. Frame-rate independent camera zoom damping
    this.currentCamDist = THREE.MathUtils.damp(
      this.currentCamDist,
      this.targetCamDist,
      10,
      dt
    );
    this.camera.position.z = this.currentCamDist;

    // 2. Smooth 360-degree inertia or auto-align to hinted block
    if (this.targetAutoQuat) {
      const alpha = 1 - Math.exp(-8 * dt);
      this.pivotGroup.quaternion.slerp(this.targetAutoQuat, alpha);
      if (this.pivotGroup.quaternion.angleTo(this.targetAutoQuat) < 0.01) {
        this.targetAutoQuat = null;
      }
    } else if (this.dragPointerId === null) {
      if (Math.abs(this.velYaw) > 0.002 || Math.abs(this.velPitch) > 0.002) {
        this.applyWorldRotation(this.velYaw * dt, this.velPitch * dt);
        const decay = Math.exp(-6.5 * dt);
        this.velYaw *= decay;
        this.velPitch *= decay;
      } else {
        this.velYaw = 0;
        this.velPitch = 0;
      }
    }

    // 3. Pivot recoil spring
    _v1.copy(this.pivotRecoil).multiplyScalar(-120);
    _v2.copy(this.pivotRecoilVel).multiplyScalar(-16);
    this.pivotRecoilVel.addScaledVector(_v1, dt).addScaledVector(_v2, dt);
    this.pivotRecoil.addScaledVector(this.pivotRecoilVel, dt);
    this.pivotGroup.position.copy(this.pivotRecoil);
    this.pivotGroup.updateMatrixWorld();

    // Prepare inverse pivot transforms once per frame for flying blocks
    _invPivotMat.copy(this.pivotGroup.matrixWorld).invert();
    _invPivotQuat.copy(this.pivotGroup.quaternion).invert();

    // 4. Update active & flying InstancedMesh transforms (zero GC!)
    if (this.bodyInstanced) {
      let matricesDirty = false;
      let colorsDirty = false;

      for (let i = 0; i < this.blockList.length; i++) {
        const block = this.blockList[i];

        if (block.status === 'active') {
          let needsMatrix = false;

          if (block.spawnDelay > 0) {
            block.spawnDelay = Math.max(0, block.spawnDelay - dt);
            needsMatrix = true;
          } else if (block.spawnScale < 1) {
            block.spawnScale = THREE.MathUtils.damp(block.spawnScale, 1, 14, dt);
            if (block.spawnScale > 0.996) block.spawnScale = 1;
            needsMatrix = true;
          }

          let scaleBoost = 1;
          if (block.isHinted) {
            const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5.2);
            scaleBoost = 1 + pulse * 0.065;
            _tmpColor.copy(block.baseColor).lerp(_hintColor, 0.35 + pulse * 0.45);
            this.bodyInstanced.setColorAt(i, _tmpColor);
            colorsDirty = true;
            needsMatrix = true;
          }

          if (block.hitActive) {
            block.hitTime += dt;
            const t = Math.min(block.hitTime / block.hitDuration, 1);
            const lunge =
              t < 0.28
                ? Math.sin((t / 0.28) * (Math.PI / 2))
                : Math.cos(((t - 0.28) / 0.72) * (Math.PI / 2));
            const flash = Math.max(0, 1 - t * 1.15);

            _v1
              .copy(block.basePos)
              .addScaledVector(block.localDir, lunge * block.hitMaxOffset);
            _tmpColor.copy(block.baseColor).lerp(_errColor, flash * 0.85);
            this.bodyInstanced.setColorAt(i, _tmpColor);
            colorsDirty = true;
            needsMatrix = true;

            if (t >= 1) {
              block.hitActive = false;
              _v1.copy(block.basePos);
              this.bodyInstanced.setColorAt(i, block.baseColor);
            }
          } else {
            _v1.copy(block.basePos);
          }

          if (needsMatrix) {
            _scaleVec.setScalar(block.spawnScale * scaleBoost);
            _mat4.compose(_v1, block.localQuat, _scaleVec);
            this.setBlockInstanceMatrix(i, _mat4);
            matricesDirty = true;
          }
        } else if (block.status === 'flying') {
          block.flyAge += dt;
          _v2.copy(block.worldVel).normalize();
          block.worldVel.addScaledVector(_v2, 34 * dt);
          block.worldPos.addScaledVector(block.worldVel, dt);

          if (block.flyAge >= 0.55) {
            block.status = 'done';
            _mat4.compose(_hiddenPos, block.localQuat, _zeroScale);
            this.setBlockInstanceMatrix(i, _mat4);
          } else {
            const fade =
              block.flyAge > 0.24
                ? Math.max(0.001, 1 - (block.flyAge - 0.24) / 0.31)
                : 1;
            _v3.copy(block.worldPos).applyMatrix4(_invPivotMat);
            _localQuatTmp.copy(_invPivotQuat).multiply(block.worldQuat);
            _scaleVec.setScalar(fade);
            _mat4.compose(_v3, _localQuatTmp, _scaleVec);
            this.setBlockInstanceMatrix(i, _mat4);
          }
          matricesDirty = true;
        }
      }

      if (matricesDirty) {
        this.markInstanceMatricesDirty();
      }
      if (colorsDirty && this.bodyInstanced.instanceColor) {
        this.bodyInstanced.instanceColor.needsUpdate = true;
      }
    }

    // 5. Update pooled InstancedMesh particles (zero GC!)
    if (this.activeParticleCount > 0) {
      let anyActive = false;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = this.particles[i];
        if (!p.active) continue;

        p.age += dt;
        if (p.age >= p.life) {
          p.active = false;
          _mat4.compose(_hiddenPos, _q1, _zeroScale);
          this.particleInstanced.setMatrixAt(i, _mat4);
        } else {
          anyActive = true;
          p.vel.y -= 7.5 * dt;
          p.pos.addScaledVector(p.vel, dt);
          p.rot.x += 5 * dt;
          p.rot.y += 4 * dt;
          p.quat.setFromEuler(p.rot);

          const scale = Math.max(0.001, 1 - p.age / p.life);
          _scaleVec.setScalar(scale);
          _mat4.compose(p.pos, p.quat, _scaleVec);
          this.particleInstanced.setMatrixAt(i, _mat4);
        }
      }
      this.particleInstanced.instanceMatrix.needsUpdate = true;
      if (!anyActive) {
        this.activeParticleCount = 0;
        this.particleInstanced.count = 0;
      }
    }

    this.renderer.render(this.scene, this.camera);

    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  };

  public dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);

    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('touchmove', this.onTouchMove);
    dom.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);
    dom.removeEventListener('webglcontextlost', this.onContextLost);
    dom.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.disposeLevelInstancedMeshes();

    this.scene.remove(this.particleInstanced);
    this.particleInstanced.dispose();

    this.blockGeo.dispose();
    this.sideArrowsGeo.dispose();
    this.noseGeo.dispose();
    this.tailGeo.dispose();
    this.particleGeo.dispose();

    this.bodyMat.dispose();
    this.sideDecalMat.dispose();
    this.noseDecalMat.dispose();
    this.tailDecalMat.dispose();
    this.particleMat.dispose();

    this.arrowTex.dispose();
    this.noseTex.dispose();
    this.tailTex.dispose();
    this.shadowTex.dispose();

    this.shadowPlane.geometry.dispose();
    (this.shadowPlane.material as THREE.Material).dispose();
    this.envTexture.dispose();

    this.renderer.dispose();
    if (dom.parentNode === this.container) {
      this.container.removeChild(dom);
    }
  }
}
