export type DirIndex = 0 | 1 | 2 | 3 | 4 | 5;

export const DIRS: readonly [number, number, number][] = [
  [1, 0, 0],  // 0: +X
  [-1, 0, 0], // 1: -X
  [0, 1, 0],  // 2: +Y
  [0, -1, 0], // 3: -Y
  [0, 0, 1],  // 4: +Z
  [0, 0, -1], // 5: -Z
];

export interface CellData {
  id: number;
  x: number;
  y: number;
  z: number;
  dir: DirIndex;
  colorIndex: number;
}

export interface LevelParams {
  size: number;
  fillRatio: number;
  carveMode: 'solid' | 'octant-procedural';
  title: string;
}

export interface GeneratedLevel {
  levelNumber: number;
  seed: number;
  title: string;
  size: number;
  fillPercent: number;
  cells: CellData[];
}

/**
 * Deterministic 32-bit seed hash from level number.
 * Ensures Level N always produces the exact same layout.
 */
export function hashLevelSeed(levelNumber: number): number {
  let h = (levelNumber * 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Formula-based difficulty progression:
 * - Levels 1-3:   3x3x3, low density (~30% -> 62%) for onboarding
 * - Levels 4-10:  4x4x4, medium density (~48% -> 84%) + symmetrical cutouts from level 7+
 * - Levels 11-20: 5x5x5, high density (~74% -> 92%) + procedural 3D cutouts
 * - Levels 21+:   6x6x6, high density (~80% -> 95%) + procedural 3D cutouts
 */
export function getLevelParams(levelNumber: number): LevelParams {
  const lvl = Math.max(1, Math.floor(levelNumber));

  if (lvl <= 3) {
    const fillRatio = 0.30 + (lvl - 1) * 0.16; // 0.30, 0.46, 0.62
    return {
      size: 3,
      fillRatio,
      carveMode: 'solid',
      title: '3×3×3',
    };
  }

  if (lvl <= 10) {
    const t = (lvl - 4) / 6; // 0..1
    const fillRatio = 0.48 + t * 0.36; // 0.48..0.84
    return {
      size: 4,
      fillRatio,
      carveMode: lvl >= 7 ? 'octant-procedural' : 'solid',
      title: '4×4×4',
    };
  }

  if (lvl <= 20) {
    const fillRatio = 0.92 - 0.18 * Math.exp(-(lvl - 11) * 0.18); // ~0.74..0.89
    return {
      size: 5,
      fillRatio,
      carveMode: 'octant-procedural',
      title: '5×5×5',
    };
  }

  const fillRatio = 0.95 - 0.16 * Math.exp(-(lvl - 21) * 0.12); // ~0.79..0.95
  return {
    size: 6,
    fillRatio,
    carveMode: 'octant-procedural',
    title: '6×6×6',
  };
}

/**
 * Generates a deterministic, 8-way symmetrical procedural 3D shape mask
 * so higher levels introduce tunnels, hollow cores, chamfered corners, and arches.
 */
function buildProceduralMask(size: number, carveMode: LevelParams['carveMode'], rand: () => number): [number, number, number][] {
  const center = (size - 1) / 2;

  if (carveMode === 'solid') {
    const coords: [number, number, number][] = [];
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) {
          coords.push([x, y, z]);
        }
      }
    }
    return coords;
  }

  // Generate symmetrical carve pattern in octant space (0 <= dx <= dy <= dz)
  const carveCorners = rand() < 0.7;
  const carveHollowCore = rand() < 0.45;
  const carveAxisTunnel = rand() < 0.55;
  const tunnelAxis = Math.floor(rand() * 3); // 0:X, 1:Y, 2:Z
  const maxRadiusSq = size >= 5 ? (center * center * (2.15 + rand() * 0.75)) : Infinity;

  const coords: [number, number, number][] = [];
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const dx = Math.abs(x - center);
        const dy = Math.abs(y - center);
        const dz = Math.abs(z - center);

        if (carveCorners && dx >= center - 0.1 && dy >= center - 0.1 && dz >= center - 0.1) {
          continue;
        }
        if (carveHollowCore && dx < 0.8 && dy < 0.8 && dz < 0.8) {
          continue;
        }
        if (carveAxisTunnel) {
          const onTunnel =
            (tunnelAxis === 0 && dy < 0.8 && dz < 0.8) ||
            (tunnelAxis === 1 && dx < 0.8 && dz < 0.8) ||
            (tunnelAxis === 2 && dx < 0.8 && dy < 0.8);
          if (onTunnel) continue;
        }
        if (dx * dx + dy * dy + dz * dz > maxRadiusSq) {
          continue;
        }

        coords.push([x, y, z]);
      }
    }
  }

  // Ensure enough cells remain for meaningful puzzles
  if (coords.length < size * size * 2) {
    const fallback: [number, number, number][] = [];
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) {
          fallback.push([x, y, z]);
        }
      }
    }
    return fallback;
  }

  return coords;
}

function isRayClear(
  grid: (DirIndex | null)[][][],
  x: number,
  y: number,
  z: number,
  dir: DirIndex,
  n: number
): boolean {
  const [dx, dy, dz] = DIRS[dir];
  let cx = x + dx;
  let cy = y + dy;
  let cz = z + dz;
  while (cx >= 0 && cx < n && cy >= 0 && cy < n && cz >= 0 && cz < n) {
    if (grid[cx][cy][cz] !== null) {
      return false;
    }
    cx += dx;
    cy += dy;
    cz += dz;
  }
  return true;
}

/**
 * Verifies 100% forward solvability by simulating greedy extraction until grid is empty.
 */
export function verifySolvable(cells: CellData[], n: number): boolean {
  const grid: (DirIndex | null)[][][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => Array<DirIndex | null>(n).fill(null))
  );

  for (const c of cells) {
    grid[c.x][c.y][c.z] = c.dir;
  }

  let remaining = cells.length;
  let progress = true;

  while (remaining > 0 && progress) {
    progress = false;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        for (let z = 0; z < n; z++) {
          const dir = grid[x][y][z];
          if (dir !== null && isRayClear(grid, x, y, z, dir, n)) {
            grid[x][y][z] = null;
            remaining--;
            progress = true;
          }
        }
      }
    }
  }

  return remaining === 0;
}

/**
 * Deterministic Reverse-Construction Level Generator:
 * 1. Derives size, target fill percentage, and sculpted mask from `levelNumber` + Seeded PRNG.
 * 2. Starts from an empty N x N x N grid and places blocks one-by-one from inner shells outward.
 * 3. Assigns each cell an arrow direction whose ray to the cube edge crosses ZERO already-placed blocks.
 * 4. Stops once the target block count (fillRatio * maskCells) is reached and verifies 100% solvability.
 */
export function generateSolvableLevel(levelNumber: number): GeneratedLevel {
  const lvl = Math.max(1, Math.floor(levelNumber));
  const baseSeed = hashLevelSeed(lvl);
  const params = getLevelParams(lvl);
  const n = params.size;
  const center = (n - 1) / 2;

  const shapeRand = mulberry32(baseSeed);
  const maskCoords = buildProceduralMask(n, params.carveMode, shapeRand);
  const targetCount = Math.max(4, Math.min(maskCoords.length, Math.round(maskCoords.length * params.fillRatio)));
  const fillPercent = Math.round((targetCount / (n * n * n)) * 100);

  for (let attempt = 0; attempt < 24; attempt++) {
    const rand = mulberry32((baseSeed + attempt * 104729) >>> 0);
    const grid: (DirIndex | null)[][][] = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => Array<DirIndex | null>(n).fill(null))
    );

    const remaining = maskCoords.map(([x, y, z]) => {
      const chebyshev = Math.max(Math.abs(x - center), Math.abs(y - center), Math.abs(z - center));
      const euclid = Math.hypot(x - center, y - center, z - center);
      return { x, y, z, chebyshev, euclid };
    });

    const placed: CellData[] = [];
    let failed = false;

    while (placed.length < targetCount && remaining.length > 0) {
      let minChebyshev = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].chebyshev < minChebyshev) {
          minChebyshev = remaining[i].chebyshev;
        }
      }

      const candidates: {
        idx: number;
        validDirs: DirIndex[];
        score: number;
      }[] = [];

      for (let i = 0; i < remaining.length; i++) {
        const cell = remaining[i];
        if (cell.chebyshev > minChebyshev + 0.6) continue;

        const validDirs: DirIndex[] = [];
        for (let d = 0 as DirIndex; d < 6; d = (d + 1) as DirIndex) {
          if (isRayClear(grid, cell.x, cell.y, cell.z, d, n)) {
            validDirs.push(d);
          }
        }

        if (validDirs.length > 0) {
          const score = validDirs.length * 1.8 + cell.euclid + rand() * 1.1;
          candidates.push({ idx: i, validDirs, score });
        }
      }

      if (candidates.length === 0) {
        for (let i = 0; i < remaining.length; i++) {
          const cell = remaining[i];
          const validDirs: DirIndex[] = [];
          for (let d = 0 as DirIndex; d < 6; d = (d + 1) as DirIndex) {
            if (isRayClear(grid, cell.x, cell.y, cell.z, d, n)) {
              validDirs.push(d);
            }
          }
          if (validDirs.length > 0) {
            candidates.push({
              idx: i,
              validDirs,
              score: validDirs.length * 1.8 + cell.euclid + rand() * 1.1,
            });
          }
        }
      }

      if (candidates.length === 0) {
        failed = true;
        break;
      }

      candidates.sort((a, b) => a.score - b.score);
      const topPool = Math.min(candidates.length, 4);
      const chosen = candidates[Math.floor(rand() * topPool)];
      const cell = remaining.splice(chosen.idx, 1)[0];

      const dir = chosen.validDirs[Math.floor(rand() * chosen.validDirs.length)];
      grid[cell.x][cell.y][cell.z] = dir;

      const colorIndex = (cell.x * 3 + cell.y * 5 + cell.z * 7 + dir) % 6;
      placed.push({
        id: placed.length + 1,
        x: cell.x,
        y: cell.y,
        z: cell.z,
        dir,
        colorIndex,
      });
    }

    if (!failed && placed.length === targetCount && verifySolvable(placed, n)) {
      return {
        levelNumber: lvl,
        seed: baseSeed,
        title: params.title,
        size: n,
        fillPercent,
        cells: placed,
      };
    }
  }

  // Deterministic radial-outward fallback (mathematically always 100% solvable)
  const sortedMask = [...maskCoords].sort((a, b) => {
    const da = Math.hypot(a[0] - center, a[1] - center, a[2] - center);
    const db = Math.hypot(b[0] - center, b[1] - center, b[2] - center);
    return da - db;
  });

  const fallback: CellData[] = sortedMask.slice(0, targetCount).map(([x, y, z], idx) => {
    const dx = x - center;
    const dy = y - center;
    const dz = z - center;
    let dir: DirIndex = 2;
    if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)) {
      dir = dx >= 0 ? 0 : 1;
    } else if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) >= Math.abs(dz)) {
      dir = dy >= 0 ? 2 : 3;
    } else {
      dir = dz >= 0 ? 4 : 5;
    }
    return {
      id: idx + 1,
      x,
      y,
      z,
      dir,
      colorIndex: (x + y + z) % 6,
    };
  });

  return {
    levelNumber: lvl,
    seed: baseSeed,
    title: params.title,
    size: n,
    fillPercent,
    cells: fallback,
  };
}
