// Central tunables. Quality tiers pick counts and render features; everything
// else is shared world constants that many systems must agree on.

export const WATER_LEVEL = 0;

export const QUALITY_TIERS = {
  low: {
    name: 'low',
    dprCap: 1.0,
    shadowMap: 1024,
    reflection: 256,
    bloom: true,
    ssao: false,
    godrays: false,
    waterSegments: 96,
    reedCount: 2400,
    grassCount: 6000,
    treeCount: 40,
    fishCount: 26,
    bubbleCount: 400,
    causticsSize: 256,
    anisotropy: 4,
    softShadows: false,
  },
  medium: {
    name: 'medium',
    dprCap: 1.25,
    shadowMap: 2048,
    reflection: 512,
    bloom: true,
    ssao: false,
    godrays: true,
    waterSegments: 144,
    reedCount: 5200,
    grassCount: 18000,
    treeCount: 80,
    fishCount: 48,
    bubbleCount: 900,
    causticsSize: 512,
    anisotropy: 8,
    softShadows: true,
  },
  high: {
    name: 'high',
    dprCap: 1.75,
    shadowMap: 3072,
    reflection: 1024,
    bloom: true,
    ssao: true,
    godrays: true,
    waterSegments: 200,
    reedCount: 9000,
    grassCount: 38000,
    treeCount: 130,
    fishCount: 72,
    bubbleCount: 1600,
    causticsSize: 1024,
    anisotropy: 16,
    softShadows: true,
  },
};

export const settings = {
  quality: QUALITY_TIERS.high,
  // Camera
  fov: 55,
  near: 0.08,
  far: 900,
  // Physics
  gravity: 14.0,
  buoyancy: 26.0,
  waterDrag: 3.4,
  airDrag: 0.25,
  // Gameplay
  swimSpeed: 4.6,
  sprintSpeed: 7.8,
  diveSpeed: 4.2,
  breathSeconds: 16,
  // Time of day, 0..1 across a full day. 0.28 = golden mid-morning.
  timeOfDay: 0.3,
  // Debug
  showStats: false,
  freeCam: false,
};

/** Pick a starting tier from a quick hardware sniff. */
export function autoDetectQuality() {
  const dpr = window.devicePixelRatio || 1;
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile || cores <= 2) return QUALITY_TIERS.low;
  if (cores <= 4 || mem <= 4 || dpr > 2.5) return QUALITY_TIERS.medium;
  return QUALITY_TIERS.high;
}
