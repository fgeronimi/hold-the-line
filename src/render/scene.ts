import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DynamicDrawUsage,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Architecture, ArchNode, Catalog, RequestKind, TickMetrics } from '../engine/types.ts';
import { REQUEST_KINDS } from '../engine/types.ts';
import { HEX_ROW, HEX_SIZE, HEX_WIDTH, hexAt, hexCenter, hexKey, type Hex } from './hex.ts';
import { escapeHtml } from './html.ts';
import { layoutArchitecture, pointAlong, type Layout, type Road } from './layout.ts';
import { ModelLibrary, type ModelId } from './models.ts';
import type { BuildingStyle, Shape, Theme } from './theme.ts';
import { isReturning, progressAt, type Vehicle } from './traffic.ts';

const MAX_VEHICLES_PER_KIND = 2500;
/** Écart entre les voies : chaque type de requête roule sur sa file, pour rester lisible. */
const LANE = 0.2;
/** Les tuiles sont un peu réduites : le joint entre elles dessine la grille. */
const TILE_SCALE = 0.94;
/** Un bâtiment tient dans sa case : au-delà de cette largeur, il est réduit. */
const BUILDING_SPAN = HEX_WIDTH * 0.95;
/** Un glisser de moins de quelques pixels reste un clic (le glisser déplace la vue). */
const CLICK_TOLERANCE_PX = 5;

const K = (name: string): ModelId => `kaykit/${name}`;

/** Les modèles KayKit dont chaque forme a besoin. */
const SHAPE_MODELS: Record<Shape, ModelId[]> = {
  hamlet: ['building_home_A_blue', 'building_home_B_blue', 'building_well_blue'].map(K),
  watchtower: ['building_tower_A_blue', 'flag_blue'].map(K),
  gatehouse: ['wall_straight_gate', 'building_tower_base_blue', 'building_barracks_blue', 'flag_blue'].map(K),
  tower: ['building_tower_A_blue', 'building_tower_B_blue'].map(K),
  lectern: ['building_market_blue', 'sack'].map(K),
  keep: ['building_castle_blue', 'building_tower_base_blue'].map(K),
  stables: ['building_tavern_blue', 'fence_wood_straight', 'crate_A_small', 'sack'].map(K),
};
const SCENERY_MODELS: ModelId[] = ['hex_grass', 'trees_A_medium', 'trees_A_small', 'tree_single_B', 'rock_single_A'].map(K);

interface Building {
  node: ArchNode;
  group: Group;
  /** Matériaux qui rougissent quand le nœud sature. */
  tintable: Material[];
  /** Un bâtiment par instance possible ; seuls les premiers sont visibles selon le tick. */
  instances: Object3D[];
  /** Coursiers en attente : leur nombre suit l'arriéré de la file. */
  parked: Object3D[];
  label: HTMLElement;
  techName: string;
  metaphor: string;
}

export type SceneMode = 'build' | 'replay';

/** Ce que l'interface veut savoir du plateau en mode construction. */
export interface BoardEvents {
  /** La case survolée, et si l'action en cours y est possible (teinte du curseur). */
  canUse?: (cell: Hex) => boolean;
  onClick?: (cell: Hex) => void;
}

/**
 * La cité en 3D isométrique, sur son plateau hexagonal. Elle est créée une fois : la
 * construction la modifie par `setArchitecture`, le rejeu l'anime par `showTick`. Elle ne
 * simule rien : elle affiche un tick calculé par le moteur et des véhicules que
 * `traffic.ts` a déjà décidés.
 */
export class CityScene {
  private readonly renderer: WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly controls: MapControls;
  /** Bâtiments, chemins et arbres : tout ce que la construction refait. */
  private readonly dynamic = new Group();
  private readonly buildings = new Map<string, Building>();
  private readonly roads = new Map<string, Road>();
  private readonly fleets = new Map<RequestKind, InstancedMesh>();
  /** Véhicules qui font demi-tour : une flotte à part, à la couleur d'alerte du thème. */
  private wrecks!: InstancedMesh;
  /** Trafic abusif repoussé, à la couleur de l'ennemi. */
  private hostiles!: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly alert: Color;
  private readonly host: HTMLElement;
  private readonly theme: Theme;
  private readonly models: ModelLibrary;
  private catalog: Catalog;
  private layout: Layout;
  private mode: SceneMode = 'build';

  private readonly cursor: Mesh;
  private readonly marker: Mesh;
  private ghost: Group | undefined;
  private hovered: Hex | undefined;
  private readonly raycaster = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private pressedAt: Vector2 | undefined;
  private frameId = 0;
  private last = performance.now();

  /** Appelé à chaque image, avant le rendu : c'est par là que le rejeu avance. */
  onFrame: ((dt: number) => void) | undefined;
  events: BoardEvents = {};

  /** Charge tous les modèles du thème une seule fois, puis construit le plateau vide. */
  static async create(host: HTMLElement, catalog: Catalog, theme: Theme, baseUrl: string): Promise<CityScene> {
    const characters = [...Object.values(theme.vehicles).map((v) => v.model), theme.hostile.model].filter(
      (m): m is string => m !== undefined,
    );
    const models = await ModelLibrary.load([...SCENERY_MODELS, ...Object.values(SHAPE_MODELS).flat(), ...characters], baseUrl);
    return new CityScene(host, catalog, theme, models);
  }

  private constructor(host: HTMLElement, catalog: Catalog, theme: Theme, models: ModelLibrary) {
    this.host = host;
    this.theme = theme;
    this.models = models;
    this.catalog = catalog;
    this.layout = layoutArchitecture({ nodes: [], links: [] });
    this.alert = new Color(theme.alert);
    this.scene.background = new Color('#e8eef3');

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'city-labels';
    host.appendChild(this.labels.domElement);

    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    // On garde la vue isométrique : on se déplace et on zoome, on ne tourne pas.
    this.controls.enableRotate = false;
    this.controls.zoomToCursor = true;
    this.controls.minZoom = 0.6;
    this.controls.maxZoom = 3;

    this.addLights();
    this.addGround();
    this.scene.add(this.dynamic);
    this.addFleets();

    // Le curseur hexagonal sous la souris, et le repère du bâtiment sélectionné.
    const hex = new CylinderGeometry(HEX_SIZE * TILE_SCALE, HEX_SIZE * TILE_SCALE, 0.04, 6);
    this.cursor = new Mesh(hex, new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45 }));
    this.marker = new Mesh(hex, new MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.7 }));
    this.cursor.visible = false;
    this.marker.visible = false;
    this.scene.add(this.cursor, this.marker);

    this.resetView();
    this.fit();
    window.addEventListener('resize', this.fit);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    this.frameId = requestAnimationFrame(this.frame);
  }

  /** Remplace bâtiments, chemins et arbres par ceux de l'architecture. */
  setArchitecture(arch: Architecture, catalog: Catalog): void {
    this.catalog = catalog;
    this.clearDynamic();
    this.layout = layoutArchitecture(arch);
    for (const road of this.layout.roads) this.roads.set(road.key, road);
    this.addPaths();
    for (const node of arch.nodes) this.addBuilding(node);
    this.addTrees();
    this.showTick(0, undefined, []);
  }

  setMode(mode: SceneMode): void {
    this.mode = mode;
    this.cursor.visible = false;
    if (this.ghost) this.ghost.visible = false;
    if (mode === 'replay') this.marker.visible = false;
  }

  /** Bâtiment fantôme à poser sous le curseur, ou aucun. */
  setGhost(type: string | undefined): void {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.disposeTree(this.ghost);
      this.ghost = undefined;
    }
    const style = type ? this.theme.buildings[type] : undefined;
    if (!type || !style) return;
    const b = this.newBuilding({ id: '__ghost__', type });
    this.build(b, style);
    this.fitToCell(b.group);
    b.group.traverse((o) => {
      if (o instanceof Mesh) {
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of materials) Object.assign(m, { transparent: true, opacity: 0.55, depthWrite: false });
        o.castShadow = false;
      }
    });
    b.group.visible = false;
    this.ghost = b.group;
    this.scene.add(this.ghost);
  }

  /** Repère sous un bâtiment : celui qu'on a sélectionné, ou le départ d'un lien en cours. */
  setMarked(nodeId: string | undefined, color = '#ffd166'): void {
    const cell = nodeId ? this.layout.cells[nodeId] : undefined;
    this.marker.visible = cell !== undefined && this.mode === 'build';
    if (!cell) return;
    const p = hexCenter(cell);
    this.marker.position.set(p.x, 0.05, p.z);
    (this.marker.material as MeshBasicMaterial).color.set(color);
  }

  /** Affiche l'état du tick courant et les véhicules en route à l'instant `time`. */
  showTick(time: number, tick: TickMetrics | undefined, vehicles: Vehicle[]): void {
    this.updateBuildings(tick);
    this.updateVehicles(time, vehicles);
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('resize', this.fit);
    this.controls.dispose();
    this.disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private readonly frame = (now: number) => {
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.onFrame?.(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this.frame);
  };

  private resetView(): void {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Vue isométrique : la caméra regarde le centre depuis la diagonale, en hauteur.
    const d = 40;
    this.camera.position.set(cx + d, d * 0.82, cz + d);
    this.controls.target.set(cx, 0, cz);
    this.camera.lookAt(cx, 0, cz);
  }

  private readonly fit = () => {
    const { clientWidth: w, clientHeight: h } = this.host;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    // L'emprise projetée d'un rectangle vu à 45° : on cadre sur sa diagonale.
    const span = Math.max(maxX - minX, maxZ - minZ) + 6;
    const aspect = w / Math.max(h, 1);
    const half = (span * 0.5) / Math.min(aspect, 1.6);
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  };

  /** Case du plateau sous un point de l'écran : rayon de la caméra contre le sol (y = 0). */
  private cellUnder(e: PointerEvent): Hex | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.ground, new Vector3());
    return hit ? hexAt({ x: hit.x, z: hit.z }) : undefined;
  }

  private readonly pointerMove = (e: PointerEvent) => {
    if (this.mode !== 'build') return;
    this.hovered = this.cellUnder(e);
    if (!this.hovered) return this.pointerLeave();
    const ok = this.events.canUse?.(this.hovered) ?? true;
    const p = hexCenter(this.hovered);
    this.cursor.position.set(p.x, 0.06, p.z);
    (this.cursor.material as MeshBasicMaterial).color.set(ok ? '#ffffff' : this.theme.alert);
    this.cursor.visible = true;
    if (this.ghost) {
      this.ghost.position.set(p.x, 0, p.z);
      this.ghost.visible = ok;
    }
  };

  private readonly pointerDown = (e: PointerEvent) => {
    this.pressedAt = new Vector2(e.clientX, e.clientY);
  };

  private readonly pointerUp = (e: PointerEvent) => {
    const moved = this.pressedAt ? this.pressedAt.distanceTo(new Vector2(e.clientX, e.clientY)) : Infinity;
    this.pressedAt = undefined;
    if (this.mode !== 'build' || moved > CLICK_TOLERANCE_PX) return;
    const cell = this.cellUnder(e);
    if (cell) this.events.onClick?.(cell);
  };

  private readonly pointerLeave = () => {
    this.hovered = undefined;
    this.cursor.visible = false;
    if (this.ghost) this.ghost.visible = false;
  };

  private addLights(): void {
    // Lumière neutre : les couleurs du pack KayKit sont déjà chaudes, une lumière teintée les fausse.
    this.scene.add(new HemisphereLight('#ffffff', '#6f8f5a', 0.8));
    this.scene.add(new AmbientLight('#ffffff', 0.25));
    const sun = new DirectionalLight('#ffffff', 1.7);
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    sun.position.set(cx - 10, 25, cz + 18);
    sun.target.position.set(cx, 0, cz);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const r = Math.max(maxX - minX, maxZ - minZ) / 2 + 8;
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 80 });
    this.scene.add(sun, sun.target);
  }

  /** Cases du sol : le plateau jouable et une bordure autour. */
  private groundCells(): Hex[] {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const [x0, x1, z0, z1] = [minX - 8, maxX + 8, minZ - 7, maxZ + 7];
    const cells: Hex[] = [];
    for (let r = Math.floor(z0 / HEX_ROW); r <= Math.ceil(z1 / HEX_ROW); r++) {
      for (let q = Math.ceil(x0 / HEX_WIDTH - r / 2); q <= Math.floor(x1 / HEX_WIDTH - r / 2); q++) cells.push({ q, r });
    }
    return cells;
  }

  /**
   * Le sol est le plateau hexagonal où le joueur bâtit : une tuile d'herbe KayKit par case,
   * instanciées, avec un joint visible entre elles. Il ne change jamais.
   */
  private addGround(): void {
    const cells = this.groundCells();
    const source = this.models.mesh(K('hex_grass'));
    const tiles = new InstancedMesh(source.geometry, source.material, cells.length);
    cells.forEach((c, i) => {
      const p = hexCenter(c);
      this.dummy.position.set(p.x, 0, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(TILE_SCALE, 1, TILE_SCALE);
      this.dummy.updateMatrix();
      tiles.setMatrixAt(i, this.dummy.matrix);
    });
    this.dummy.scale.set(1, 1, 1);
    tiles.receiveShadow = true;
    this.scene.add(tiles);

    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    // Sous les tuiles, un fond sombre : il remplit les joints et les fait ressortir.
    const under = new Mesh(
      new PlaneGeometry(maxX - minX + 20, maxZ - minZ + 18),
      new MeshLambertMaterial({ color: this.theme.ground }),
    );
    under.rotation.x = -Math.PI / 2;
    under.position.set((minX + maxX) / 2, -0.3, (minZ + maxZ) / 2);
    this.scene.add(under);
  }

  /** Vide la partie variable. Les géométries des modèles sont partagées : on ne libère que ce qui est propre. */
  private clearDynamic(): void {
    for (const child of [...this.dynamic.children]) {
      this.dynamic.remove(child);
      child.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        if (o instanceof Mesh || o instanceof InstancedMesh) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
          if (o.userData.ownGeometry) o.geometry.dispose();
        }
      });
    }
    this.buildings.clear();
    this.roads.clear();
  }

  private disposeTree(root: Object3D): void {
    root.traverse((o) => {
      if (o instanceof Mesh || o instanceof InstancedMesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
  }

  /** Un chemin est une suite de cases pavées de terre, du bâtiment de départ à celui d'arrivée. */
  private addPaths(): void {
    const paved = new Map<string, Hex>();
    for (const road of this.layout.roads) for (const c of road.cells) paved.set(hexKey(c), c);
    if (paved.size === 0) return;
    // Six segments, premier sommet sur l'axe z : la même orientation « pointe en haut » que les tuiles.
    const geometry = new CylinderGeometry(HEX_SIZE * TILE_SCALE, HEX_SIZE * TILE_SCALE, 0.06, 6);
    const tiles = new InstancedMesh(geometry, new MeshLambertMaterial({ color: this.theme.road }), paved.size);
    tiles.userData.ownGeometry = true;
    [...paved.values()].forEach((c, i) => {
      const p = hexCenter(c);
      this.dummy.position.set(p.x, 0.03, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      tiles.setMatrixAt(i, this.dummy.matrix);
    });
    tiles.receiveShadow = true;
    this.dynamic.add(tiles);
  }

  private newBuilding(node: ArchNode): Building {
    const def = this.catalog.components[node.type];
    return {
      node,
      group: new Group(),
      tintable: [],
      instances: [],
      parked: [],
      label: document.createElement('div'),
      techName: def?.techName ?? node.type,
      metaphor: this.theme.buildings[node.type]?.metaphor ?? node.type,
    };
  }

  private addBuilding(node: ArchNode): void {
    const at = this.layout.nodes[node.id];
    const style = this.theme.buildings[node.type];
    if (!at || !style) return;
    const b = this.newBuilding(node);
    b.group.position.set(at.x, 0, at.z);
    this.build(b, style);
    this.fitToCell(b.group);

    b.label.className = 'city-label';
    const label = new CSS2DObject(b.label);
    const top = new Box3().setFromObject(b.group).max.y;
    // L'étiquette est enfant du groupe réduit : on compense l'échelle pour la placer au-dessus.
    label.position.set(0, (top + 0.5) / b.group.scale.y, 0);
    b.group.add(label);

    this.dynamic.add(b.group);
    this.buildings.set(node.id, b);
  }

  /** Réduit un bâtiment qui déborderait de sa case sur ses voisines. */
  private fitToCell(group: Group): void {
    const size = new Box3().setFromObject(group).getSize(new Vector3());
    const span = Math.max(size.x, size.z);
    if (span > BUILDING_SPAN) group.scale.setScalar(BUILDING_SPAN / span);
  }

  /**
   * Pose un modèle dans `parent`. Ses matériaux rougissent avec le bâtiment `b` ; le décor
   * (arbres, rochers) n'en a pas et ne rougit jamais.
   */
  private put(
    parent: Object3D,
    id: ModelId,
    at: { x?: number; y?: number; z?: number; scale?: number; rotate?: number } = {},
    b?: Building,
  ): Object3D {
    const { object, materials } = this.models.place(id);
    object.position.set(at.x ?? 0, at.y ?? 0, at.z ?? 0);
    object.scale.setScalar(at.scale ?? 1);
    object.rotation.y = at.rotate ?? 0;
    b?.tintable.push(...materials);
    parent.add(object);
    return object;
  }

  /** Assemble les pièces KayKit qui forment ce composant dans la métaphore. */
  private build(b: Building, style: BuildingStyle): void {
    const g = b.group;
    const levelOf = (effect: string) =>
      Object.entries(b.node.upgrades ?? {}).reduce((a, [u, l]) => a + (this.catalog.upgrades[u]?.effect.type === effect ? l : 0), 0);

    switch (style.shape) {
      case 'hamlet':
        this.put(g, K('building_home_A_blue'), { x: -0.7, z: -0.7, rotate: 0.3 }, b);
        this.put(g, K('building_home_B_blue'), { x: 0.8, z: -0.5, rotate: -0.4 }, b);
        this.put(g, K('building_home_A_blue'), { x: -0.4, z: 0.9, rotate: 2.6 }, b);
        this.put(g, K('building_well_blue'), { x: 0.7, z: 0.8 }, b);
        break;

      case 'watchtower':
        this.put(g, K('building_tower_A_blue'), {}, b);
        this.put(g, K('flag_blue'), { y: 2.2, scale: 2 }, b);
        break;

      case 'gatehouse':
        // La porte est un mur percé, flanqué de deux tours : la route passe dessous.
        this.put(g, K('wall_straight_gate'), { rotate: Math.PI / 2 }, b);
        for (const z of [-1.3, 1.3]) this.put(g, K('building_tower_base_blue'), { z }, b);
        this.put(g, K('flag_blue'), { y: 1.4, scale: 2.5 }, b);
        // Le rate limiting devient la caserne de la garde, accolée à la porte.
        if (levelOf('rateLimit') > 0) this.put(g, K('building_barracks_blue'), { x: 1.1, z: 0, rotate: Math.PI, scale: 0.7 }, b);
        break;

      case 'tower': {
        // Une tour par instance possible : le scaling fixe et le plafond d'autoscaling.
        const max = 1 + levelOf('instances') + levelOf('autoscaling');
        const cols = Math.ceil(Math.sqrt(max));
        for (let i = 0; i < max; i++) {
          const tower = this.put(
            g,
            K(i % 2 === 0 ? 'building_tower_A_blue' : 'building_tower_B_blue'),
            {
              x: ((i % cols) - (cols - 1) / 2) * 1.1,
              z: (Math.floor(i / cols) - (Math.ceil(max / cols) - 1) / 2) * 1.1,
              scale: 0.8,
              rotate: (i * 1.3) % (Math.PI * 2),
            },
            b,
          );
          // En construction, toutes les tours possibles sont visibles : le joueur voit ce qu'il paie.
          b.instances.push(tower);
        }
        break;
      }

      case 'lectern':
        // Le comptoir du marché : le scribe y trouve la réponse sans aller jusqu'aux archives.
        this.put(g, K('building_market_blue'), { scale: 0.9 }, b);
        this.put(g, K('sack'), { x: 0.9, z: 0.5, scale: 2 }, b);
        break;

      case 'keep': {
        this.put(g, K('building_castle_blue'), { scale: 0.9 }, b);
        // Une tour annexe par réplica en lecture.
        const replicas = levelOf('readReplicas');
        for (let i = 0; i < replicas; i++) {
          this.put(g, K('building_tower_base_blue'), { x: -1.4 + (i % 3) * 0.9, z: 1.3 + Math.floor(i / 3) * 0.9, scale: 0.6 }, b);
        }
        break;
      }

      case 'stables':
        // La taverne du relais et son enclos : les colis en attente s'y empilent.
        this.put(g, K('building_tavern_blue'), { x: -0.8 }, b);
        for (const z of [-0.5, 0.5]) this.put(g, K('fence_wood_straight'), { x: 1.1, z }, b);
        for (let i = 0; i < 12; i++) {
          const parcel = this.put(
            g,
            K(i % 3 === 0 ? 'sack' : 'crate_A_small'),
            { x: 0.1 + (i % 3) * 0.3, z: -0.6 + Math.floor(i / 3) * 0.4, scale: 2 },
            b,
          );
          parcel.visible = false;
          b.parked.push(parcel);
        }
        break;
    }
  }

  /**
   * Bosquets et rochers, une chance par case, toujours la même : le paysage ne change pas
   * d'un rejeu à l'autre. Jamais sur un bâtiment ni sur un chemin, et plus rares sur le
   * plateau jouable, pour laisser de la place à bâtir.
   */
  private addTrees(): void {
    const taken = new Set([...Object.values(this.layout.cells).map(hexKey), ...this.layout.roads.flatMap((r) => r.cells.map(hexKey))]);
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const kinds = ['trees_A_medium', 'trees_A_small', 'tree_single_B', 'rock_single_A'];
    for (const cell of this.groundCells()) {
      if (taken.has(hexKey(cell))) continue;
      const p = hexCenter(cell);
      const onBoard = p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ;
      const roll = hash(cell.q * 73.1 + cell.r * 37.7);
      if (roll > (onBoard ? 0.05 : 0.3)) continue;
      const pick = Math.floor(hash(cell.q * 11.3 - cell.r * 5.9) * kinds.length);
      this.put(this.dynamic, K(kinds[pick]!), { x: p.x, z: p.z, rotate: roll * 40 });
    }
  }

  /**
   * Une flotte instanciée par sorte de voyageur : le personnage du thème figé en pleine
   * marche, ou une boîte de couleur s'il n'en a pas. `tint` recolore le personnage
   * (les requêtes en échec reprennent le messager, en rouge).
   */
  private fleet(style: { color: string; size: [number, number, number]; model?: string }, tint?: string): InstancedMesh {
    const [w, h, l] = style.size;
    let mesh: InstancedMesh;
    if (style.model) {
      const { geometry, materials } = this.models.bakeCharacter(style.model, h);
      const own = materials.map((m) => {
        const c = m.clone();
        if (tint && 'color' in c && c.color instanceof Color) c.color.set(tint);
        return c;
      });
      mesh = new InstancedMesh(geometry, own, MAX_VEHICLES_PER_KIND);
      mesh.userData.grounded = true;
    } else {
      mesh = new InstancedMesh(new BoxGeometry(w, h, l), new MeshLambertMaterial({ color: tint ?? style.color }), MAX_VEHICLES_PER_KIND);
    }
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.count = 0;
    this.scene.add(mesh);
    return mesh;
  }

  private addFleets(): void {
    for (const kind of REQUEST_KINDS) this.fleets.set(kind, this.fleet(this.theme.vehicles[kind]));
    this.wrecks = this.fleet(this.theme.vehicles.read, this.theme.alert);
    const [w, h, l] = this.theme.vehicles.read.size;
    this.hostiles = this.fleet({ ...this.theme.hostile, size: [w * 1.2, h * 1.1, l] });
  }

  private updateBuildings(tick: TickMetrics | undefined): void {
    for (const [id, b] of this.buildings) {
      const n = tick?.nodes[id];
      const u = n?.utilization ?? 0;
      // Le bâtiment rougit à l'approche de la saturation, franchement au-delà.
      const heat = Math.min(Math.max((u - 0.8) / 0.4, 0), 1);
      for (const m of b.tintable) {
        if ('emissive' in m && m.emissive instanceof Color) m.emissive.copy(this.alert).multiplyScalar(heat * 0.6);
      }

      // En construction, toutes les tours payées sont visibles ; au rejeu, celles en service.
      const visible = tick ? (n?.instances ?? 1) : b.instances.length;
      b.instances.forEach((o, i) => (o.visible = i < visible));

      const backlog = n?.backlog ?? 0;
      const parked = backlog > 0 ? Math.min(b.parked.length, Math.ceil(Math.log10(1 + backlog) * 3)) : 0;
      b.parked.forEach((o, i) => (o.visible = i < parked));

      const failed = n?.failed ?? 0;
      const shed = n?.shed ?? 0;
      b.label.innerHTML =
        `<b>${escapeHtml(b.metaphor)}</b><span>${escapeHtml(b.techName)} · ${escapeHtml(id)}</span>` +
        // La charge n'apparaît que quand elle compte : moins d'étiquettes qui se chevauchent.
        (u > 0.6 ? `<em class="${u > 1 ? 'hot' : ''}">charge ${Math.round(u * 100)} %</em>` : '') +
        (failed > 0 ? `<em class="hot">✕ ${Math.round(failed)} req/s en échec</em>` : '') +
        (shed > 0 ? `<em>🛡 ${Math.round(shed)} req/s abusives repoussées</em>` : '');
    }
  }

  private updateVehicles(time: number, vehicles: Vehicle[]): void {
    const counts = new Map<RequestKind, number>(REQUEST_KINDS.map((k) => [k, 0]));
    let wrecked = 0;
    let repelled = 0;
    for (const v of vehicles) {
      const f = progressAt(v, time);
      const road = this.roads.get(v.link);
      if (f === undefined || !road) continue;
      const fleet = v.hostile ? this.hostiles : v.failed ? this.wrecks : this.fleets.get(v.kind);
      const i = v.hostile ? repelled : v.failed ? wrecked : counts.get(v.kind)!;
      if (!fleet || i >= MAX_VEHICLES_PER_KIND) continue;

      // Un demi-tour ne va qu'aux trois quarts de la route : il est refoulé avant d'arriver.
      const turned = v.failed || v.hostile;
      const { point, angle } = pointAlong(road.path, turned ? 0.25 + f * 0.75 : f);
      const lane = v.hostile ? 2 * LANE : v.failed ? -2 * LANE : (REQUEST_KINDS.indexOf(v.kind) - 1) * LANE;
      const [, h] = this.theme.vehicles[v.kind].size;
      // Les personnages ont les pieds à zéro et sautillent en marchant ; une boîte est centrée.
      const hop = Math.abs(Math.sin((time + v.start * 7.3) * 9)) * 0.06;
      const y = fleet.userData.grounded ? 0.06 + hop : 0.04 + h / 2;
      this.dummy.position.set(point.x + Math.cos(angle) * lane, y, point.z - Math.sin(angle) * lane);
      this.dummy.rotation.set(0, isReturning(v, time) ? angle + Math.PI : angle, 0);
      this.dummy.updateMatrix();
      fleet.setMatrixAt(i, this.dummy.matrix);
      if (v.hostile) repelled++;
      else if (v.failed) wrecked++;
      else counts.set(v.kind, i + 1);
    }
    for (const [kind, fleet] of this.fleets) {
      fleet.count = counts.get(kind)!;
      fleet.instanceMatrix.needsUpdate = true;
    }
    this.wrecks.count = wrecked;
    this.wrecks.instanceMatrix.needsUpdate = true;
    this.hostiles.count = repelled;
    this.hostiles.instanceMatrix.needsUpdate = true;
  }
}

/** Pseudo-aléatoire déterministe dans [0, 1[, sans corrélation visible entre indices voisins. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
