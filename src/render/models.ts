import { Mesh, type Material, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Identifiant d'un modèle : son chemin sous `public/models/`, sans extension. */
export type ModelId = string;

/**
 * Modèles 3D chargés une fois par rejeu, puis clonés à chaque pose. Chaque clone a ses
 * propres matériaux : un bâtiment saturé rougit sans teinter ses voisins.
 */
export class ModelLibrary {
  private readonly models: Map<ModelId, Object3D>;

  private constructor(models: Map<ModelId, Object3D>) {
    this.models = models;
  }

  static async load(ids: ModelId[], baseUrl: string): Promise<ModelLibrary> {
    const loader = new GLTFLoader();
    const entries = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const gltf = await loader.loadAsync(`${baseUrl}models/${id}.glb`);
        return [id, gltf.scene] as const;
      }),
    );
    return new ModelLibrary(new Map(entries));
  }

  /** Une copie posable du modèle, et la liste de ses matériaux pour la teinte d'alerte. */
  place(id: ModelId): { object: Object3D; materials: Material[] } {
    const source = this.models.get(id);
    if (!source) throw new Error(`Modèle non chargé : ${id}`);
    const object = source.clone(true);
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
}
