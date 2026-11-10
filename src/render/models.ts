import {
  AnimationMixer,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  SkinnedMesh,
  Vector3,
  type AnimationClip,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Identifiant d'un modèle : son chemin sous `public/models/`. Sans extension, c'est un
 * `.gltf` (les bâtiments) ; les personnages sont des `.glb` et la portent.
 */
export type ModelId = string;

interface Loaded {
  scene: Object3D;
  animations: AnimationClip[];
}

/**
 * Modèles 3D chargés une fois par rejeu, puis clonés à chaque pose. Chaque clone a ses
 * propres matériaux : un bâtiment saturé rougit sans teinter ses voisins.
 */
export class ModelLibrary {
  private readonly models: Map<ModelId, Loaded>;

  private constructor(models: Map<ModelId, Loaded>) {
    this.models = models;
  }

  static async load(ids: ModelId[], baseUrl: string): Promise<ModelLibrary> {
    const loader = new GLTFLoader();
    const entries = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const file = /\.(glb|gltf)$/.test(id) ? id : `${id}.gltf`;
        const gltf = await loader.loadAsync(`${baseUrl}models/${file}`);
        return [id, { scene: gltf.scene, animations: gltf.animations }] as const;
      }),
    );
    return new ModelLibrary(new Map(entries));
  }

  /**
   * Géométrie et matériau du premier maillage d'un modèle, pour l'instancier en masse
   * (le sol en tuiles) sans un objet par copie.
   */
  mesh(id: ModelId): Mesh {
    let found: Mesh | undefined;
    this.models.get(id)?.scene.traverse((o) => {
      if (!found && o instanceof Mesh) found = o;
    });
    if (!found) throw new Error(`Modèle sans maillage : ${id}`);
    return found;
  }

  /** Une copie posable du modèle, et la liste de ses matériaux pour la teinte d'alerte. */
  place(id: ModelId): { object: Object3D; materials: Material[] } {
    const source = this.models.get(id);
    if (!source) throw new Error(`Modèle non chargé : ${id}`);
    const object = source.scene.clone(true);
    const materials: Material[] = [];
    object.traverse((o) => {
      if (o instanceof Mesh) {
        o.material = Array.isArray(o.material) ? o.material.map((m: Material) => m.clone()) : o.material.clone();
        materials.push(...(Array.isArray(o.material) ? o.material : [o.material]));
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return { object, materials };
  }

  /** Un personnage figé dans une seule pose de sa marche (voir `bakeWalk`). */
  bakeCharacter(id: ModelId, height: number, poseAt = 0.25): { geometry: BufferGeometry; materials: Material[] } {
    const { frames, materials } = this.bakeWalk(id, height, 1, poseAt);
    return { geometry: frames[0]!, materials };
  }

  /**
   * Fige un personnage animé dans `count` poses régulièrement réparties sur sa première
   * animation (la marche), chacune fusionnée en une seule géométrie (un groupe par matériau).
   * Des centaines de personnages squelettés coûteraient trop cher ; quelques poses figées
   * s'instancient comme de simples boîtes, et les alterner fait marcher. Toutes les poses
   * sont ramenées à la hauteur voulue avec la même transformation, celle de la première :
   * sinon le personnage tressauterait d'une pose à l'autre.
   */
  bakeWalk(id: ModelId, height: number, count: number, firstPose = 0): { frames: BufferGeometry[]; materials: Material[] } {
    const source = this.models.get(id);
    if (!source) throw new Error(`Modèle non chargé : ${id}`);
    let materials: Material[] = [];
    const posed = Array.from({ length: count }, (_, i) => {
      const baked = this.pose(source, (firstPose + i / count) % 1, id);
      materials = baked.materials;
      return baked.geometry;
    });
    const box = new Box3().setFromBufferAttribute(posed[0]!.getAttribute('position') as BufferAttribute);
    const scale = height / (box.max.y - box.min.y);
    const center = box.getCenter(new Vector3());
    for (const g of posed) {
      g.translate(-center.x, -box.min.y, -center.z);
      g.scale(scale, scale, scale);
    }
    return { frames: posed, materials };
  }

  private pose(source: Loaded, poseAt: number, id: ModelId): { geometry: BufferGeometry; materials: Material[] } {
    const scene = source.scene;
    const clip = source.animations[0];
    if (clip) {
      const mixer = new AnimationMixer(scene);
      mixer.clipAction(clip).play();
      mixer.setTime(clip.duration * poseAt);
    }
    scene.updateMatrixWorld(true);

    const parts: BufferGeometry[] = [];
    const materials: Material[] = [];
    const v = new Vector3();
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = o.geometry.clone() as BufferGeometry;
      const position = g.getAttribute('position');
      if (o instanceof SkinnedMesh) {
        // Pose figée : chaque sommet est déplacé par ses os, puis mis en coordonnées du monde.
        o.skeleton.update();
        const moved = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i++) {
          v.fromBufferAttribute(position, i);
          o.applyBoneTransform(i, v);
          v.applyMatrix4(o.matrixWorld);
          moved.set([v.x, v.y, v.z], i * 3);
        }
        g.setAttribute('position', new BufferAttribute(moved, 3));
      } else {
        g.applyMatrix4(o.matrixWorld);
      }
      // Seuls position, normale et UV survivent à la fusion : les os ne servent plus.
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      const flat = g.index ? g.toNonIndexed() : g;
      flat.computeVertexNormals();
      // La fusion exige les mêmes attributs partout : une pièce sans texture (les yeux d'un
      // squelette) reçoit des coordonnées nulles, sans effet sur sa couleur unie.
      if (!flat.getAttribute('uv')) {
        flat.setAttribute('uv', new BufferAttribute(new Float32Array(flat.getAttribute('position').count * 2), 2));
      }
      parts.push(flat);
      materials.push(Array.isArray(o.material) ? o.material[0]! : o.material);
    });

    const geometry = mergeGeometries(parts, true);
    if (!geometry) throw new Error(`Impossible de fusionner le personnage : ${id}`);
    return { geometry, materials };
  }
}
