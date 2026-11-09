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
import { BOARD } from '../data/board.ts';
import { BRIDGE_MODEL, bridgeRotation, crossingTile, riverCells, riverKeys, riverTile, roadSides, roadTile, TERRAIN_MODELS, type Tile } from './terrain.ts';
import { HEX_SIZE, HEX_WIDTH, hexAt, hexCenter, hexDistance, hexKey, type Hex } from './hex.ts';
import { escapeHtml } from './html.ts';
import { layoutArchitecture, pointAlong, type Layout, type Road } from './layout.ts';
import { ModelLibrary, type ModelId } from './models.ts';
import type { BuildingStyle, Shape, Theme } from './theme.ts';
import { journeyAt, type Journey, type Outcome } from './traffic.ts';

const MAX_VEHICLES_PER_KIND = 2500;
/** Écart entre les files : aller d'un côté du chemin, retour de l'autre, un rang par type. */
const LANE = 0.12;
/** Les tuiles sont un peu réduites : le joint entre elles dessine la grille. */
const TILE_SCALE = 0.94;
/** Un bâtiment tient dans sa case : au-delà de cette largeur, il est réduit. */
const BUILDING_SPAN = HEX_WIDTH * 0.95;
/** Durée de vie d'une pastille +1 / −1, en ticks : elle monte et s'efface. */
const POP_LIFE = 0.9;
/** Au-delà, les pastilles les plus anciennes ne sont plus affichées : on garde la scène lisible. */
const MAX_POPS = 60;
const POP_TEXT: Record<Outcome['result'], { text: string; className: string }> = {
  served: { text: '+1 👍', className: 'pop ok' },
  refused: { text: '−1 👎', className: 'pop ko' },
  repelled: { text: '🛡', className: 'pop shield' },
};
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
  belfry: ['building_church_blue', 'flag_blue'].map(K),
};
/** Décor du bord du plateau : reliefs et grands bois, pour fermer le paysage. */
const EDGE_DECOR = ['mountain_A_grass_trees', 'hills_A_trees', 'trees_A_large', 'trees_B_medium', 'hill_single_A', 'trees_A_medium'];
/** Décor de l'intérieur, plus discret, pour laisser de la place à bâtir. */
const INNER_DECOR = ['trees_A_small', 'trees_B_small', 'tree_single_A', 'tree_single_B', 'rock_single_A', 'rock_single_B', 'rock_single_C', 'hill_single_A'];
const SCENERY_MODELS: ModelId[] = ['hex_grass', ...new Set([...EDGE_DECOR, ...INNER_DECOR]), ...TERRAIN_MODELS].map(K);

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
  /** Hauteur du toit, pour placer étiquette et pastilles au-dessus. */
  top: number;
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
  /** Réserve d'étiquettes +1 / −1, réutilisées d'une image à l'autre. */
  private readonly pops: CSS2DObject[] = [];
  private hovered: Hex | undefined;
  private readonly raycaster = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private pressedAt: Vector2 | undefined;
  private frameId = 0;
  private last = performance.now();
  /** Cadrage visé par un recentrage en cours : la caméra glisse vers lui à chaque image. */
  private focus: { target: Vector3; zoom: number } | undefined;
  private readonly home = { target: new Vector3(), zoom: 1 };

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
    this.scene.add(this.dynamic);
    this.addTerrain();
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
    this.addTerrain();
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

  /** Recentre doucement la vue sur un bâtiment (zoom avant), ou sur tout le plateau. */
  focusOn(nodeId: string | undefined, zoom = 1.8): void {
    const at = nodeId ? this.layout.nodes[nodeId] : undefined;
    this.focus = at ? { target: new Vector3(at.x, 0, at.z), zoom } : { target: this.home.target.clone(), zoom: this.home.zoom };
  }

  /** Affiche l'état du tick courant et les véhicules en route à l'instant `time`. */
  showTick(time: number, tick: TickMetrics | undefined, journeys: Journey[], outcomes: Outcome[] = []): void {
    this.updateBuildings(tick);
    this.updateTravellers(time, journeys);
    this.updatePops(time, outcomes);
  }

  /** Une pastille par requête servie (+1), refusée (−1) ou pillard repoussé, qui monte et s'efface. */
  private updatePops(time: number, outcomes: Outcome[]): void {
    const live = outcomes.filter((o) => time >= o.at && time - o.at < POP_LIFE).slice(-MAX_POPS);
    while (this.pops.length < live.length) {
      const el = document.createElement('div');
      const pop = new CSS2DObject(el);
      this.pops.push(pop);
      this.scene.add(pop);
    }
    this.pops.forEach((pop, i) => {
      const o = live[i];
      const b = o && this.buildings.get(o.node);
      const at = o && this.layout.nodes[o.node];
      pop.visible = Boolean(o && at);
      if (!o || !at) return;
      const age = (time - o.at) / POP_LIFE;
      // Petit décalage fixe par pastille : plusieurs +1 simultanés ne s'empilent pas exactement.
      const jitter = hash(o.at * 977.3) - 0.5;
      // Au-dessus de l'étiquette du bâtiment, pour ne pas la masquer.
      pop.position.set(at.x + jitter * 0.8, (b?.top ?? 1) + 1.3 + age * 1.2, at.z + jitter * 0.4);
      const style = POP_TEXT[o.result];
      if (pop.element.textContent !== style.text) pop.element.textContent = style.text;
      pop.element.className = style.className;
      pop.element.style.opacity = String(1 - age);
    });
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
    this.glideToFocus(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this.frame);
  };

  /** Rapproche cible et zoom du cadrage visé ; la caméra garde son angle isométrique. */
  private glideToFocus(dt: number): void {
    if (!this.focus) return;
    const k = Math.min(1, dt * 4);
    const delta = this.focus.target.clone().sub(this.controls.target).multiplyScalar(k);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.camera.zoom += (this.focus.zoom - this.camera.zoom) * k;
    this.camera.updateProjectionMatrix();
    if (delta.length() < 1e-3 && Math.abs(this.focus.zoom - this.camera.zoom) < 1e-3) this.focus = undefined;
  }

  private resetView(): void {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Vue isométrique : la caméra regarde le centre depuis la diagonale, en hauteur.
    const d = 40;
    this.camera.position.set(cx + d, d * 0.82, cz + d);
    this.controls.target.set(cx, 0, cz);
    this.camera.lookAt(cx, 0, cz);
    this.home.target.set(cx, 0, cz);
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

  /** Cases du sol : exactement le plateau jouable, un grand hexagone. */
  private groundCells(): Hex[] {
    const { center, radius } = BOARD;
    const cells: Hex[] = [];
    for (let dq = -radius; dq <= radius; dq++) {
      for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
        cells.push({ q: center.q + dq, r: center.r + dr });
      }
    }
    return cells;
  }

  /**
   * Le sol du plateau, une tuile KayKit par case, avec un joint visible entre elles : la
   * rivière, les chemins (la tuile de route qui relie exactement les côtés empruntés, un
   * pont là où ils franchissent la rivière), et l'herbe partout ailleurs, instanciée.
   */
  private addTerrain(): void {
    const roads = roadSides(this.layout.roads.map((r) => r.cells));
    const river = riverCells();
    const tile = (cell: Hex, t: Tile | undefined) => {
      if (!t) return;
      const p = hexCenter(cell);
      this.put(this.dynamic, K(t.model), { x: p.x, z: p.z, rotate: (t.turns * Math.PI) / 3, scale: TILE_SCALE });
    };
    for (const [k, { cell, sides }] of river) {
      const road = roads.get(k);
      const crossing = road && crossingTile(sides, road.sides);
      tile(cell, crossing ?? riverTile(sides));
      if (crossing && road) {
        const p = hexCenter(cell);
        this.put(this.dynamic, K(BRIDGE_MODEL), { x: p.x, z: p.z, rotate: bridgeRotation(road.sides), scale: TILE_SCALE });
      }
    }
    for (const [k, { cell, sides }] of roads) if (!river.has(k)) tile(cell, roadTile(sides));

    const cells = this.groundCells().filter((c) => !roads.has(hexKey(c)) && !river.has(hexKey(c)));
    const source = this.models.mesh(K('hex_grass'));
    const material = Array.isArray(source.material) ? source.material.map((m) => m.clone()) : source.material.clone();
    const tiles = new InstancedMesh(source.geometry, material, cells.length);
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
    this.dynamic.add(tiles);
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
      top: 1,
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
    b.top = top;
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

      case 'belfry':
        // Le clocher du crieur, et son fanion.
        this.put(g, K('building_church_blue'), {}, b);
        this.put(g, K('flag_blue'), { x: 0.9, z: 0.5, scale: 0.8 }, b);
        break;

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
   * Le décor, une chance par case, toujours la même : le paysage ne change pas d'un rejeu
   * à l'autre. Reliefs et grands bois sur les deux rangées du bord, quelques arbres et
   * rochers à l'intérieur. Jamais sur un bâtiment ni sur un chemin, ni près des clients,
   * pour que l'entrée du trafic reste dégagée.
   */
  private addTrees(): void {
    const taken = new Set([
      ...Object.values(this.layout.cells).map(hexKey),
      ...this.layout.roads.flatMap((r) => r.cells.map(hexKey)),
      ...riverKeys(),
    ]);
    const sources = Object.entries(this.layout.cells)
      .filter(([id]) => this.buildings.get(id)?.node.type === 'traffic-source')
      .map(([, c]) => c);
    for (const cell of this.groundCells()) {
      if (taken.has(hexKey(cell)) || sources.some((s) => hexDistance(s, cell) <= 1)) continue;
      const edge = hexDistance(cell, BOARD.center) >= BOARD.radius - 1;
      const roll = hash(cell.q * 73.1 + cell.r * 37.7);
      if (roll > (edge ? 0.45 : 0.08)) continue;
      const kinds = edge ? EDGE_DECOR : INNER_DECOR;
      const pick = Math.floor(hash(cell.q * 11.3 - cell.r * 5.9) * kinds.length);
      const p = hexCenter(cell);
      // Les reliefs gardent l'orientation de la grille ; les arbres tournent librement.
      const rotate = kinds[pick]!.includes('hill') || kinds[pick]!.includes('mountain') ? Math.floor(roll * 60) * (Math.PI / 3) : roll * 40;
      this.put(this.dynamic, K(kinds[pick]!), { x: p.x, z: p.z, rotate });
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
        `<b>${escapeHtml(b.techName)}</b><span>${escapeHtml(b.metaphor)}</span>` +
        (n?.down ? `<em class="hot">⚡ ${n.down} instance${n.down > 1 ? 's' : ''} en panne</em>` : '') +
        // La charge n'apparaît que quand elle compte : moins d'étiquettes qui se chevauchent.
        (n?.down && n.instances === 0
          ? '<em class="hot">hors service</em>'
          : u > 0.6 ? `<em class="${u > 1 ? 'hot' : ''}">charge ${Math.round(u * 100)} %</em>` : '') +
        (failed > 0 ? `<em class="hot">✕ ${Math.round(failed)} req/s en échec</em>` : '') +
        (shed > 0 ? `<em>🛡 ${Math.round(shed)} req/s abusives repoussées</em>` : '');
    }
  }

  private updateTravellers(time: number, journeys: Journey[]): void {
    const counts = new Map<RequestKind, number>(REQUEST_KINDS.map((k) => [k, 0]));
    let wrecked = 0;
    let repelled = 0;
    for (const j of journeys) {
      const at = journeyAt(j, time);
      const road = at && this.roads.get(at.link);
      if (!at || !road) continue;
      // Un pillard reste un pillard ; une requête refusée ne rougit qu'en repartant.
      const fleet = j.hostile ? this.hostiles : at.failed ? this.wrecks : this.fleets.get(j.kind);
      const i = j.hostile ? repelled : at.failed ? wrecked : counts.get(j.kind)!;
      if (!fleet || i >= MAX_VEHICLES_PER_KIND) continue;

      const { point, angle } = pointAlong(road.path, at.f);
      // L'aller tient la droite, le retour l'autre côté : les deux sens se croisent sans se gêner.
      const lane = (0.18 + REQUEST_KINDS.indexOf(j.kind) * LANE) * (at.returning ? -1 : 1);
      const [, h] = this.theme.vehicles[j.kind].size;
      // Les personnages ont les pieds à zéro et sautillent en marchant ; une boîte est centrée.
      const hop = Math.abs(Math.sin((time + j.start * 7.3) * 9)) * 0.06;
      const y = fleet.userData.grounded ? 0.06 + hop : 0.04 + h / 2;
      this.dummy.position.set(point.x + Math.cos(angle) * lane, y, point.z - Math.sin(angle) * lane);
      this.dummy.rotation.set(0, at.returning ? angle + Math.PI : angle, 0);
      this.dummy.updateMatrix();
      fleet.setMatrixAt(i, this.dummy.matrix);
      if (j.hostile) repelled++;
      else if (at.failed) wrecked++;
      else counts.set(j.kind, i + 1);
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
