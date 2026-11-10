import {
  BoxGeometry,
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Matrix4,
  type Scene,
} from 'three';
import type { ModelLibrary } from './models.ts';

/** Poses de marche par personnage : assez pour que le pas se lise, peu pour rester léger. */
export const WALK_FRAMES = 6;

export interface FleetStyle {
  color: string;
  /** Largeur, hauteur, longueur, en unités de la grille. */
  size: [number, number, number];
  model?: string;
}

/**
 * Tous les voyageurs d'une même sorte : une géométrie instanciée par pose de marche, et
 * leurs disques au sol à la couleur de la légende. Chaque image, on y range les voyageurs
 * du moment (`begin`, `add`, `end`) ; chacun prend la pose de son pas.
 */
export class Fleet {
  readonly frames: InstancedMesh[];
  readonly disc: InstancedMesh;
  /** Un personnage a les pieds à zéro ; une boîte de secours est centrée. */
  readonly grounded: boolean;
  private readonly max: number;
  private readonly used: number[];
  private discs = 0;

  constructor(scene: Scene, models: ModelLibrary, style: FleetStyle, max: number, tint?: string) {
    this.max = max;
    const [w, h, l] = style.size;
    if (style.model) {
      const { frames, materials } = models.bakeWalk(style.model, h, WALK_FRAMES);
      // Les requêtes en échec reprennent le messager, recoloré.
      const own = materials.map((m) => {
        const c = m.clone();
        if (tint && 'color' in c && c.color instanceof Color) c.color.set(tint);
        return c;
      });
      this.frames = frames.map((g) => new InstancedMesh(g, own, max));
      this.grounded = true;
    } else {
      this.frames = [new InstancedMesh(new BoxGeometry(w, h, l), new MeshLambertMaterial({ color: tint ?? style.color }), max)];
      this.grounded = false;
    }
    // Les personnages gardent leurs couleurs : c'est le disque à leurs pieds qui dit le type
    // de requête, aux couleurs de la légende.
    this.disc = new InstancedMesh(
      new CircleGeometry(w * 0.75, 16).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: tint ?? style.color, transparent: true, opacity: 0.85, depthWrite: false }),
      max,
    );
    for (const m of [...this.frames, this.disc]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      // Three calcule une fois pour toutes la sphère englobante d'un maillage instancié, d'après
      // les positions du moment : les voyageurs bougent, et au zoom toute la flotte était
      // jugée hors champ et disparaissait. Ils sont toujours sur le plateau : on ne découpe pas.
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    for (const m of this.frames) m.castShadow = true;
    this.used = this.frames.map(() => 0);
  }

  begin(): void {
    this.used.fill(0);
    this.discs = 0;
  }

  /** Range un voyageur : son corps dans la pose `frame`, son disque au sol. */
  add(body: Matrix4, frame: number, disc: Matrix4): void {
    const f = ((frame % this.frames.length) + this.frames.length) % this.frames.length;
    if (this.used[f]! >= this.max || this.discs >= this.max) return;
    this.frames[f]!.setMatrixAt(this.used[f]!++, body);
    this.disc.setMatrixAt(this.discs++, disc);
  }

  end(): void {
    this.frames.forEach((m, i) => {
      m.count = this.used[i]!;
      m.instanceMatrix.needsUpdate = true;
    });
    this.disc.count = this.discs;
    this.disc.instanceMatrix.needsUpdate = true;
  }
}
