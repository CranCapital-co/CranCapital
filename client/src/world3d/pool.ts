// Instanced drawing: one InstancedMesh per geometry, refilled every frame.
// Pools grow as needed, so a busy street costs the same draw calls as an
// empty one.
import * as THREE from 'three';

export class Pool {
  mesh: THREE.InstancedMesh;
  count = 0;
  private cap: number;
  private tinted: boolean;
  constructor(public scene: THREE.Scene, public geo: THREE.BufferGeometry, public material: THREE.Material, cap = 16, tinted = false) {
    this.cap = cap;
    this.tinted = tinted;
    this.mesh = this.make(cap);
  }
  private make(cap: number) {
    const m = new THREE.InstancedMesh(this.geo, this.material, cap);
    m.frustumCulled = false;
    m.count = 0;
    m.matrixAutoUpdate = false;
    if (this.tinted) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    this.scene.add(m);
    return m;
  }
  begin() {
    this.count = 0;
  }
  add(m: THREE.Matrix4, color?: THREE.Color) {
    if (this.count >= this.cap) this.grow();
    this.mesh.setMatrixAt(this.count, m);
    if (this.tinted && color) this.mesh.setColorAt(this.count, color);
    this.count++;
  }
  private grow() {
    const old = this.mesh;
    this.cap *= 2;
    this.mesh = this.make(this.cap);
    (this.mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    if (this.tinted && old.instanceColor) (this.mesh.instanceColor!.array as Float32Array).set(old.instanceColor.array as Float32Array);
    this.mesh.renderOrder = old.renderOrder;
    this.scene.remove(old);
    old.dispose();
  }
  end() {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  triangles() {
    return (this.geo.getAttribute('position').count / 3) * this.count;
  }
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

export class Pools {
  private map = new Map<string, Pool>();
  constructor(private scene: THREE.Scene, private materials: Record<string, THREE.Material>) {}
  get(key: string, make: () => THREE.BufferGeometry, material = 'solid', tinted = false) {
    let p = this.map.get(key);
    if (!p) {
      p = new Pool(this.scene, make(), this.materials[material], 16, tinted);
      this.map.set(key, p);
    }
    return p;
  }
  begin() {
    for (const p of this.map.values()) p.begin();
  }
  end() {
    for (const p of this.map.values()) p.end();
  }
  stats() {
    let calls = 0;
    let tris = 0;
    for (const p of this.map.values()) {
      if (p.count) {
        calls++;
        tris += p.triangles();
      }
    }
    return { calls, tris };
  }
  dispose() {
    for (const p of this.map.values()) p.dispose();
    this.map.clear();
  }
}
