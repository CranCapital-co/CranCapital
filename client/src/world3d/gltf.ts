// Swapping in hand-made models. Every model in the game is built in code
// (models.ts, people.ts) so nothing needs downloading. A Blender model can
// replace one: export it as glTF (.glb), compress it with gltf-transform
// (meshopt), put it in client/public/models/ and list it in
// models/manifest.json as "kind" or "kind:level" -> file. Colours come from
// the shared palette texture (sampled per vertex) or each material's colour,
// so the model still uses the one shared material. See docs/MODELS.md.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const overrides = new Map<string, THREE.BufferGeometry>();
let loaded = false;

export async function loadModelOverrides(): Promise<number> {
  if (loaded) return overrides.size;
  loaded = true;
  const base = import.meta.env.BASE_URL;
  let list: Record<string, string>;
  try {
    const r = await fetch(`${base}models/manifest.json`);
    if (!r.ok) return 0;
    list = await r.json();
  } catch {
    return 0;
  }
  if (!Object.keys(list).length) return 0;
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  await Promise.all(
    Object.entries(list).map(async ([key, file]) => {
      try {
        const gltf = await loader.loadAsync(`${base}models/${file}`);
        const geo = await flatten(gltf.scene);
        if (geo) overrides.set(key, geo);
      } catch {
        /* keep the built-in model */
      }
    })
  );
  return overrides.size;
}

// One geometry with vertex colours from the whole glTF scene.
async function flatten(root: THREE.Object3D): Promise<THREE.BufferGeometry | null> {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    const uv = g.getAttribute('uv');
    const sample = mat.map && uv ? paletteSampler(mat.map) : null;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      if (sample) sample(uv!.getX(i), uv!.getY(i), c);
      else c.copy(mat.color ?? new THREE.Color('#ffffff'));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    parts.push(g);
  }
  return parts.length ? mergeGeometries(parts, false) : null;
}

function paletteSampler(tex: THREE.Texture) {
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  return (u: number, v: number, out: THREE.Color) => {
    const x = Math.min(cv.width - 1, Math.max(0, Math.floor(u * cv.width)));
    const y = Math.min(cv.height - 1, Math.max(0, Math.floor((tex.flipY ? 1 - v : v) * cv.height)));
    const i = (y * cv.width + x) * 4;
    out.setRGB(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, THREE.SRGBColorSpace);
  };
}
