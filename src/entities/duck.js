// STUB — awaiting implementation. See CONTRACT.md "Duck model contract".
// Shape is real so dependent systems can be written against it now.
import * as THREE from 'three';

export const DUCK_PALETTES = {
  mallardDrake: {},
  mallardHen: {},
  duckling: {},
};

export function createDuck({ variant = 'adult', scale = 1, palette, seed = 1 } = {}) {
  const object = new THREE.Object3D();
  const bones = {
    head: new THREE.Object3D(), neck: new THREE.Object3D(), body: new THREE.Object3D(),
    tailFeathers: new THREE.Object3D(), wingL: new THREE.Object3D(), wingR: new THREE.Object3D(),
    footL: new THREE.Object3D(), footR: new THREE.Object3D(), beak: new THREE.Object3D(),
  };
  return {
    stub: true,
    object,
    bones,
    variant,
    scale,
    update() {},
    setPose() {},
    dispose() {},
  };
}
