import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
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
  Shape as Outline,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
} from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Architecture, ArchNode, Catalog, RequestKind, TickMetrics } from '../engine/types.ts';
import { REQUEST_KINDS } from '../engine/types.ts';
import { BOARD } from '../data/board.ts';
import { BRIDGE_MODEL, bridgeRotation, crossingTile, isRiver, riverCells, riverKeys, riverTile, roadSides, roadTile, TERRAIN_MODELS, type Tile } from './terrain.ts';
import { HEX_SIZE, HEX_WIDTH, hexAt, hexCenter, hexDistance, hexKey, hexNeighbours, type Hex } from './hex.ts';
import { escapeHtml } from './html.ts';
import { pict } from './pict.ts';
import { Effects } from './effects.ts';
import { Fleet, WALK_FRAMES, type FleetStyle } from './fleet.ts';
import { layoutArchitecture, pathLength, pointAlong, type Layout, type Road } from './layout.ts';
import { ModelLibrary, type ModelId } from './models.ts';
import { nodeNames, type BuildingStyle, type Shape, type Theme } from './theme.ts';
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
/** Une tour en panne noircit vers cette teinte : elle brûle. */
const CHARRED = new Color('#3b302b');
/** Au plus autant de coursiers en attente devant une file : au-delà, la jauge parle. */
const MAX_WAITING = 6;
const DUPLICATE_TINT = new Color('#9b5de5');
/** Au-delà, les pastilles les plus anciennes ne sont plus affichées : on garde la scène lisible. */
const MAX_POPS = 60;
const POP_TEXT: Record<Outcome['result'], { html: string; className: string }> = {
  served: { html: `${pict('check')} +1`, className: 'pop ok' },
  refused: { html: '✕ −1', className: 'pop ko' },
  repelled: { html: pict('barrier'), className: 'pop shield' },
  twice: { html: '×2', className: 'pop ko' },
  ignored: { html: `${pict('seal')} déjà reçu`, className: 'pop dedup' },
  requeued: { html: '↩ en file', className: 'pop dedup' },
};
/** Distance d'un panneau de sens au milieu de la route : sur le bas-côté. */
const SIGN_OFFSET = 0.5;
/** Un glisser de moins de quelques pixels reste un clic (le glisser déplace la vue). */
const CLICK_TOLERANCE_PX = 5;

const K = (name: string): ModelId => `kaykit/${name}`;
/** La courbe sRGB, d'une valeur linéaire sur 8 bits à sa valeur affichée. */
const SRGB = Uint8Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
});

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
  'counting-house': ['building_home_B_blue', 'sack', 'crate_A_small', 'flag_blue'].map(K),
  dovecote: ['building_tower_B_blue', 'flag_blue', 'crate_A_small'].map(K),
  tollhouse: ['building_home_A_blue', 'fence_wood_straight', 'flag_blue', 'crate_A_small'].map(K),
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
  /** Les clients : ils émettent le trafic, ils n'ont pas de charge. */
  source: boolean;
  /** Hauteur du toit, pour placer étiquette et pastilles au-dessus. */
  top: number;
  /** Position sur sa case : un bâtiment saturé tremble autour d'elle. */
  home: Vector3;
  /**
   * Autoscaling : une place par instance à la demande, sur une case voisine. Les fondations
   * attendent ; au rejeu, un chantier se dresse le temps du démarrage, puis la tour sert.
   */
  slots: { scaffold: Object3D; tower: Object3D }[];
  /** Icônes des évolutions achetées, sous le nom du bâtiment. */
  badges: string;
  /** La barrière de la guérite du disjoncteur : levée, elle s'abaisse quand le circuit s'ouvre. */
  gate?: Object3D;
}

export type SceneMode = 'build' | 'replay';

/** Ce que l'interface veut savoir du plateau en mode construction. */
export interface BoardEvents {
  /** La case survolée, et si l'action en cours y est possible (teinte du curseur). */
  canUse?: (cell: Hex) => boolean;
  onClick?: (cell: Hex) => void;
  /** Peut-on saisir ce qui est sur cette case pour le glisser ? Le plateau ne défile plus alors. */
  canDrag?: (cell: Hex) => boolean;
  /** Le glisser commence vraiment (au-delà de quelques pixels), puis se lâche sur une case. */
  onDragStart?: (cell: Hex) => void;
  onDrop?: (cell: Hex | undefined) => void;
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
  private readonly fleets = new Map<RequestKind, Fleet>();
  /** Véhicules qui font demi-tour : une flotte à part, à la couleur d'alerte du thème. */
  private wrecks!: Fleet;
  /** Trafic abusif repoussé, à la couleur de l'ennemi. */
  private hostiles!: Fleet;
  private readonly dummy = new Object3D();
  private readonly effects: Effects;
  /** Coursiers arrêtés devant une file qui déborde. */
  private waiters!: Fleet;
  /** Paiements figés devant une dépendance lente : la cascade en train de se faire. */
  private stuck!: Fleet;
  /** Latence visée par la vague (ms) : au-delà, le bâtiment le plus lent montre son sablier. */
  slaLatencyMs: number | undefined;
  /** Objectifs propres à un type de requête (la commande payée, M15) : le sablier les lit aussi. */
  slaLatencyByKind: Partial<Record<RequestKind, number>> = {};
  private readonly alert: Color;
  private readonly host: HTMLElement;
  private readonly theme: Theme;
  private readonly models: ModelLibrary;
  private catalog: Catalog;
  private layout: Layout;
  /** Case voisine où un serveur range ses instances à la demande (autoscaling). */
  private annexes = new Map<string, Hex>();
  private mode: SceneMode = 'build';

  private readonly cursor: Mesh;
  private readonly marker: Mesh;
  private ghost: Group | undefined;
  /** Les pastilles d'évolution du bâtiment sélectionné, et leur HTML déjà posé. */
  private readonly pips: CSS2DObject;
  private pipsHtml = '';
  private pipsFor: string | undefined;
  /** Les portraits déjà rendus, par type de bâtiment. */
  private readonly portraits: Record<string, string> = {};
  /** Réserve d'étiquettes +1 / −1, réutilisées d'une image à l'autre. */
  private readonly pops: CSS2DObject[] = [];
  private hovered: Hex | undefined;
  private readonly raycaster = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private pressedAt: Vector2 | undefined;
  /** Case du bâtiment saisi, et si le glisser a vraiment commencé. */
  private grabbed: { cell: Hex; dragging: boolean } | undefined;
  private frameId = 0;
  /**
   * Hors rejeu, rien ne bouge tant que personne n'y touche : on ne rend que si ce drapeau est
   * levé. Toute modification visible du plateau passe par `invalidate()` ; dans le doute on
   * lève le drapeau, une image de trop ne coûte rien, une image manquante se voit.
   */
  private dirty = true;
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
    const pips = document.createElement('div');
    pips.className = 'city-pips';
    this.pips = new CSS2DObject(pips);
    this.pips.visible = false;
    this.scene.add(this.pips);
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
    this.effects = new Effects(this.scene);
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
    // En capture : décider avant MapControls si l'on saisit un bâtiment ou si l'on fait défiler.
    canvas.addEventListener('pointerdown', this.pointerDown, { capture: true });
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    // Le glisser et le zoom de la caméra (et son amortissement, s'il est activé) passent par là.
    this.controls.addEventListener('change', this.invalidate);
    document.addEventListener('visibilitychange', this.invalidate);
    this.frameId = requestAnimationFrame(this.frame);
  }

  private readonly invalidate = () => {
    this.dirty = true;
  };

  /** Remplace bâtiments, chemins et arbres par ceux de l'architecture. */
  setArchitecture(arch: Architecture, catalog: Catalog): void {
    this.invalidate();
    this.catalog = catalog;
    this.clearDynamic();
    this.layout = layoutArchitecture(arch);
    for (const road of this.layout.roads) this.roads.set(road.key, road);
    this.annexes = this.findAnnexes(arch);
    this.addTerrain();
    this.addArrows();
    for (const node of arch.nodes) this.addBuilding(node);
    this.addTrees();
    this.showTick(0, undefined, []);
  }

  setMode(mode: SceneMode): void {
    this.invalidate();
    this.mode = mode;
    this.cursor.visible = false;
    if (this.ghost) this.ghost.visible = false;
    if (mode === 'replay') {
      this.marker.visible = false;
      this.pips.visible = false;
    }
  }

  /** Bâtiment fantôme à poser sous le curseur, ou aucun. */
  setGhost(type: string | undefined): void {
    this.invalidate();
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
    this.setMarkedAt(nodeId ? this.layout.cells[nodeId] : undefined, color);
  }

  /** Marque une case, bâtie ou non : la case vide où l'on s'apprête à construire. */
  setMarkedAt(cell: Hex | undefined, color = '#ffd166'): void {
    this.invalidate();
    this.marker.visible = cell !== undefined && this.mode === 'build';
    if (!cell) return;
    const p = hexCenter(cell);
    this.marker.position.set(p.x, 0.05, p.z);
    (this.marker.material as MeshBasicMaterial).color.set(color);
  }

  /**
   * Pose les pastilles d'évolution au pied d'un bâtiment, côté caméra, dans sa case. Le HTML
   * n'est remplacé que s'il change : une pastille survolée garde son infobulle.
   */
  setPips(nodeId: string | undefined, html: string): void {
    this.invalidate();
    const at = nodeId ? this.buildings.get(nodeId)?.home : undefined;
    this.pipsFor = at && html && this.mode === 'build' ? nodeId : undefined;
    this.pips.visible = this.pipsFor !== undefined;
    if (!at || !this.pips.visible) return;
    if (html !== this.pipsHtml) {
      this.pips.element.innerHTML = html;
      this.pipsHtml = html;
    }
    // La caméra regarde depuis +x, +z : le pied du bâtiment de ce côté reste dans sa case.
    this.pips.position.set(at.x - 0.25, 0.35, at.z + 0.65);
  }

  /**
   * Le portrait de chaque bâtiment sur sa tuile d'herbe, pour les cartes de l'interface.
   * Rendu une fois hors écran par le renderer du plateau, sous le même angle et la même
   * lumière : pas de second contexte WebGL, et la carte montre ce que le plateau posera.
   */
  thumbnails(types: string[], size = 320): Record<string, string> {
    for (const type of types) {
      const style = this.theme.buildings[type];
      if (!style || this.portraits[type]) continue;
      const stage = new Group();
      const b = this.newBuilding({ id: '__portrait__', type });
      this.build(b, style);
      this.fitToCell(b.group);
      // Les colis du relais sont cachés tant que la file est vide : le portrait en montre quelques-uns.
      b.parked.slice(0, 5).forEach((o) => (o.visible = true));
      stage.add(b.group);
      this.put(stage, K('hex_grass'), { scale: TILE_SCALE });
      this.portraits[type] = this.portrait(stage, size);
      stage.traverse((o) => {
        if (o instanceof Mesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Material) => m.dispose());
      });
    }
    this.invalidate();
    return { ...this.portraits };
  }

  /** Rend un objet seul, cadré serré sur fond transparent, et le renvoie en image. */
  private portrait(subject: Object3D, size: number): string {
    const stage = new Scene();
    stage.add(new HemisphereLight('#ffffff', '#6f8f5a', 0.8), new AmbientLight('#ffffff', 0.25));
    const sun = new DirectionalLight('#ffffff', 1.7);
    sun.position.set(-10, 25, 18);
    stage.add(sun, subject);

    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    camera.position.set(40, 40 * 0.82, 40);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    // L'emprise du sujet vue par la caméra : les huit coins de sa boîte, dans le repère de la caméra.
    const box = new Box3().setFromObject(subject);
    const seen = new Box3();
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) seen.expandByPoint(new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
    const centre = seen.getCenter(new Vector3());
    const half = (Math.max(seen.max.x - seen.min.x, seen.max.y - seen.min.y) / 2) * 1.04;
    Object.assign(camera, { left: centre.x - half, right: centre.x + half, top: centre.y + half, bottom: centre.y - half });
    camera.updateProjectionMatrix();

    const target = new WebGLRenderTarget(size, size, { samples: 4 });
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearAlpha(0);
    this.renderer.setRenderTarget(target);
    this.renderer.render(stage, camera);
    const pixels = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearAlpha(alpha);
    target.dispose();
    stage.remove(subject);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      // La cible se lit de bas en haut, l'image s'écrit de haut en bas.
      const from = (size - 1 - y) * size * 4;
      const to = y * size * 4;
      for (let x = 0; x < size * 4; x += 4) {
        const opacity = pixels[from + x + 3]! / 255;
        // Une cible hors écran reste en lumière linéaire et prémultipliée : l'image attend du sRGB droit.
        for (let c = 0; c < 3; c++) image.data[to + x + c] = opacity > 0 ? SRGB[Math.min(255, Math.round(pixels[from + x + c]! / opacity))]! : 0;
        image.data[to + x + 3] = pixels[from + x + 3]!;
      }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  /** Recentre doucement la vue sur un bâtiment (zoom avant), ou sur tout le plateau. */
  focusOn(nodeId: string | undefined, zoom = 1.8): void {
    this.invalidate();
    const at = nodeId ? this.layout.nodes[nodeId] : undefined;
    this.focus = at ? { target: new Vector3(at.x, 0, at.z), zoom } : { target: this.home.target.clone(), zoom: this.home.zoom };
  }

  /** Affiche l'état du tick courant et les véhicules en route à l'instant `time`. */
  showTick(time: number, tick: TickMetrics | undefined, journeys: Journey[], outcomes: Outcome[] = []): void {
    this.invalidate();
    this.effects.begin(performance.now() / 1000);
    this.updateBuildings(tick);
    this.updateWaiting(tick);
    this.updateTravellers(time, journeys);
    this.updatePops(time, outcomes);
    this.effects.end();
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
      // Comparé par la clé : relire `innerHTML` à chaque image coûterait plus que de l'écrire.
      if (pop.element.dataset.result !== o.result) {
        pop.element.dataset.result = o.result;
        pop.element.innerHTML = style.html;
      }
      pop.element.className = style.className;
      pop.element.style.opacity = String(1 - age);
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('resize', this.fit);
    document.removeEventListener('visibilitychange', this.invalidate);
    this.controls.removeEventListener('change', this.invalidate);
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
    // Le recentrage bouge la caméra à chaque image jusqu'à son arrivée, dernière image comprise.
    if (this.focus) this.dirty = true;
    this.glideToFocus(dt);
    // Peut lever le drapeau (événement `change`) : à lire après.
    this.controls.update();
    // Un rejeu anime à chaque image (flammes, fumée, pas des voyageurs) : rendu continu.
    if (this.dirty || this.onFrame || this.mode === 'replay') {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    }
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
    this.invalidate();
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
  /** Case sous un point de l'écran, pour un glisser parti d'ailleurs (la palette). */
  cellAt(clientX: number, clientY: number): Hex | undefined {
    return this.cellUnder({ clientX, clientY });
  }

  private cellUnder(e: { clientX: number; clientY: number }): Hex | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.ground, new Vector3());
    return hit ? hexAt({ x: hit.x, z: hit.z }) : undefined;
  }

  private readonly pointerMove = (e: PointerEvent) => {
    if (this.mode !== 'build') return;
    if (this.grabbed && !this.grabbed.dragging && this.pressedAt && this.pressedAt.distanceTo(new Vector2(e.clientX, e.clientY)) > CLICK_TOLERANCE_PX) {
      this.grabbed.dragging = true;
      this.events.onDragStart?.(this.grabbed.cell);
    }
    this.invalidate();
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
    const cell = this.mode === 'build' ? this.cellUnder(e) : undefined;
    if (cell && this.events.canDrag?.(cell)) {
      this.grabbed = { cell, dragging: false };
      this.controls.enabled = false;
      // Lâché hors du plateau, le bâtiment doit quand même retomber quelque part.
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
  };

  private readonly pointerUp = (e: PointerEvent) => {
    const grabbed = this.grabbed;
    this.grabbed = undefined;
    this.controls.enabled = true;
    if (grabbed?.dragging) {
      this.pressedAt = undefined;
      this.events.onDrop?.(this.cellUnder(e));
      return;
    }
    const moved = this.pressedAt ? this.pressedAt.distanceTo(new Vector2(e.clientX, e.clientY)) : Infinity;
    this.pressedAt = undefined;
    if (this.mode !== 'build' || moved > CLICK_TOLERANCE_PX) return;
    const cell = this.cellUnder(e);
    if (cell) this.events.onClick?.(cell);
  };

  private readonly pointerLeave = () => {
    this.invalidate();
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
  /**
   * Des panneaux au bord de chaque chemin, flèche tournée vers l'arrivée : le sens du lien se
   * lit sans relancer la vague. Un panneau en sortie de départ, un second sur un long chemin ;
   * jamais sur un pont. Ils se plantent sur le bas-côté tourné vers la caméra.
   */
  private addArrows(): void {
    const signs: { x: number; z: number; angle: number }[] = [];
    for (const road of this.layout.roads) {
      const length = pathLength(road.path);
      if (length < HEX_WIDTH * 0.9) continue;
      // Le premier emplacement hors de l'eau, en partant du départ ; un second sur un long chemin.
      const candidates = Array.from({ length: 9 }, (_, i) => (i + 1) / 10).map((f) => pointAlong(road.path, f));
      const dry = candidates.filter((c) => !isRiver(hexAt(c.point)));
      const picks = length > HEX_WIDTH * 4 ? [dry[0], dry.at(-2)] : [dry[Math.floor(dry.length / 3)]];
      for (const pick of picks) {
        if (!pick) continue;
        const { point, angle } = pick;
        let side = new Vector3(Math.cos(angle), 0, -Math.sin(angle));
        if (side.x + side.z < 0) side = side.negate();
        signs.push({ x: point.x + side.x * SIGN_OFFSET, z: point.z + side.z * SIGN_OFFSET, angle });
      }
    }
    if (signs.length === 0) return;
    // La planche, en flèche vers +x, épaissie en z ; tournée pour pointer vers +z.
    const board = new Outline();
    board.moveTo(-0.36, -0.12);
    board.lineTo(0.18, -0.12);
    board.lineTo(0.36, 0);
    board.lineTo(0.18, 0.12);
    board.lineTo(-0.36, 0.12);
    board.closePath();
    const boardGeometry = new ExtrudeGeometry(board, { depth: 0.05, bevelEnabled: false }).translate(0, 0, -0.025).rotateY(-Math.PI / 2);
    const boards = new InstancedMesh(boardGeometry, new MeshLambertMaterial({ color: '#efe0b9' }), signs.length);
    const posts = new InstancedMesh(new BoxGeometry(0.07, 0.75, 0.07).translate(0, 0.375, 0), new MeshLambertMaterial({ color: '#6b4226' }), signs.length);
    signs.forEach((s, i) => {
      this.dummy.rotation.set(0, s.angle, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.position.set(s.x, 0, s.z);
      this.dummy.updateMatrix();
      posts.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(s.x, 0.66, s.z);
      this.dummy.updateMatrix();
      boards.setMatrixAt(i, this.dummy.matrix);
    });
    for (const m of [posts, boards]) {
      m.castShadow = true;
      this.dynamic.add(m);
    }
  }

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
      techName: nodeNames(node, this.catalog, this.theme).tech,
      metaphor: nodeNames(node, this.catalog, this.theme).metaphor,
      source: def?.behavior === 'source',
      top: 1,
      home: new Vector3(),
      slots: [],
      badges: '',
    };
  }

  private addBuilding(node: ArchNode): void {
    const at = this.layout.nodes[node.id];
    const style = this.theme.buildings[node.type];
    if (!at || !style) return;
    const b = this.newBuilding(node);
    b.group.position.set(at.x, 0, at.z);
    b.home.set(at.x, 0, at.z);
    this.build(b, style);
    this.fitToCell(b.group);
    this.addAnnex(b);
    this.addGuardHut(b);
    b.badges = Object.entries(node.upgrades ?? {})
      .filter(([, level]) => level > 0)
      .map(([id]) => this.theme.upgradeIcons[id])
      .filter((icon): icon is string => icon !== undefined)
      // Un renvoi au sprite de l'interface (I18), posé dans la page au démarrage.
      .map((icon) => `<svg class="ico" viewBox="0 0 48 48" aria-hidden="true"><use href="#hl-${icon}"/></svg>`)
      .join('');

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

  private levelOf(node: ArchNode, effect: string): number {
    return Object.entries(node.upgrades ?? {}).reduce((a, [u, l]) => a + (this.catalog.upgrades[u]?.effect.type === effect ? l : 0), 0);
  }

  /**
   * Une case voisine libre pour chaque serveur en autoscaling : ni bâtiment, ni chemin, ni
   * rivière, de préférence côté caméra. Sans case libre, ses tours restent dans sa case.
   * La case n'est pas réservée : un bâtiment posé dessus la reprend, l'annexe se déplace.
   */
  private findAnnexes(arch: Architecture): Map<string, Hex> {
    const taken = new Set([...Object.values(this.layout.cells).map(hexKey), ...this.layout.roads.flatMap((r) => r.cells.map(hexKey)), ...riverKeys()]);
    const out = new Map<string, Hex>();
    for (const node of arch.nodes) {
      const cell = this.layout.cells[node.id];
      if (!cell || this.levelOf(node, 'autoscaling') === 0) continue;
      const free = hexNeighbours(cell)
        .filter((h) => !taken.has(hexKey(h)) && hexDistance(h, BOARD.center) <= BOARD.radius)
        .sort((a, b) => hexCenter(b).x + hexCenter(b).z - (hexCenter(a).x + hexCenter(a).z))[0];
      if (!free) continue;
      out.set(node.id, free);
      taken.add(hexKey(free));
    }
    return out;
  }

  /** Les fondations de l'autoscaling sur la case voisine, une par instance à la demande. */
  private addAnnex(b: Building): void {
    const cell = this.annexes.get(b.node.id);
    const count = this.levelOf(b.node, 'autoscaling');
    if (!cell || count === 0) return;
    const p = hexCenter(cell);
    const annex = new Group();
    annex.position.set(p.x, 0, p.z);
    const cols = Math.ceil(Math.sqrt(count));
    const spread = Math.min(1.1, 2.2 / cols);
    for (let i = 0; i < count; i++) {
      const slot = new Group();
      slot.position.set(((i % cols) - (cols - 1) / 2) * spread, 0, (Math.floor(i / cols) - (Math.ceil(count / cols) - 1) / 2) * spread);
      slot.scale.setScalar(Math.min(1, spread / 1.1));
      this.put(slot, K('building_tower_base_blue'), { scale: 0.45, y: -0.2 }, b);
      const scaffold = new Group();
      for (const [x, z, r] of [[-0.45, 0, Math.PI / 2], [0.45, 0, Math.PI / 2], [0, -0.45, 0], [0, 0.45, 0]] as const) {
        this.put(scaffold, K('fence_wood_straight'), { x, z, rotate: r, scale: 0.6 });
      }
      this.put(scaffold, K('crate_A_small'), { x: 0.5, z: 0.5, scale: 1.8 });
      const tower = new Group();
      this.put(tower, K(i % 2 === 0 ? 'building_tower_A_blue' : 'building_tower_B_blue'), { scale: 0.75 }, b);
      scaffold.visible = false;
      tower.visible = false;
      slot.add(scaffold, tower);
      annex.add(slot);
      b.slots.push({ scaffold, tower });
    }
    this.dynamic.add(annex);
  }

  /** Le circuit breaker : une guérite au bord de la case, sur la route de la première dépendance. */
  private addGuardHut(b: Building): void {
    if (this.levelOf(b.node, 'circuitBreaker') === 0) return;
    const road = [...this.roads.values()].find((r) => r.from === b.node.id && r.path.length > 1);
    const next = road?.path[1];
    const along = next ? new Vector3(next.x - b.home.x, 0, next.z - b.home.z).normalize() : new Vector3(1, 0, 0);
    // Le bas-côté tourné vers la caméra (+x, +z), pour que les tours ne la cachent pas.
    let side = new Vector3(-along.z, 0, along.x);
    if (side.x + side.z < 0) side = side.negate();
    const hut = new Group();
    this.put(hut, K('building_tower_base_blue'), { scale: 0.42 }, b);
    this.put(hut, K('flag_blue'), { y: 0.5, scale: 0.7 }, b);
    // La barrière, en travers de la route quand elle tombe : un poteau blanc, un bras rouge.
    const post = new Mesh(new BoxGeometry(0.07, 0.34, 0.07), new MeshLambertMaterial({ color: '#f4f1de' }));
    post.position.set(-side.x * 0.3, 0.17, -side.z * 0.3);
    const gate = new Group();
    gate.position.set(-side.x * 0.3, 0.32, -side.z * 0.3);
    gate.rotation.y = Math.atan2(-side.x, -side.z);
    const arm = new Mesh(new BoxGeometry(0.06, 0.06, 0.8), new MeshLambertMaterial({ color: '#d62828' }));
    arm.position.z = 0.4;
    gate.add(arm);
    hut.add(post, gate);
    b.gate = gate;
    hut.position.copy(b.home).addScaledVector(along, 0.7).addScaledVector(side, 0.5);
    this.dynamic.add(hut);
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
        // Les instances à la demande vont sur la case voisine quand il y en a une de libre.
        const max = 1 + levelOf('instances') + (this.annexes.has(b.node.id) ? 0 : levelOf('autoscaling'));
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

      case 'counting-house':
        // La maison du banquier, ses sacs d'écus et son coffre.
        this.put(g, K('building_home_B_blue'), { x: -0.3 }, b);
        for (const [x, z] of [[0.7, 0.5], [0.9, 0.1], [0.6, -0.3]] as const) this.put(g, K('sack'), { x, z, scale: 2.2 }, b);
        this.put(g, K('crate_A_small'), { x: 0.5, z: 0.9, scale: 2 }, b);
        this.put(g, K('flag_blue'), { x: -0.3, y: 1.3, scale: 1.6 }, b);
        break;

      case 'dovecote':
        // Le colombier : une tour étroite, et les fanions des pigeons partis porter les billets.
        this.put(g, K('building_tower_B_blue'), { scale: 0.9 }, b);
        for (const [x, z] of [[0.7, 0.4], [-0.6, 0.6]] as const) this.put(g, K('flag_blue'), { x, z, scale: 0.9 }, b);
        this.put(g, K('crate_A_small'), { x: 0.6, z: -0.6, scale: 2 }, b);
        break;

      case 'tollhouse':
        // Le bureau des laissez-passer : sa maison, la barrière en travers de la route, le fanion
        // qu'on voit de loin, et le registre des laissez-passer délivrés.
        this.put(g, K('building_home_A_blue'), { x: -0.5, z: -0.3, scale: 0.85 }, b);
        for (const z of [-0.45, 0.45]) this.put(g, K('fence_wood_straight'), { x: 0.6, z, rotate: Math.PI / 2 }, b);
        this.put(g, K('flag_blue'), { x: 0.6, z: -0.9, scale: 1.4 }, b);
        this.put(g, K('crate_A_small'), { x: -0.2, z: 0.8, scale: 2 }, b);
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
      ...[...this.annexes.values()].map(hexKey),
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

  /** Une flotte par sorte de voyageur ; `tint` recolore le personnage (les requêtes en échec). */
  private fleet(style: FleetStyle, tint?: string): Fleet {
    return new Fleet(this.scene, this.models, style, MAX_VEHICLES_PER_KIND, tint);
  }

  private addFleets(): void {
    for (const kind of REQUEST_KINDS) this.fleets.set(kind, this.fleet(this.theme.vehicles[kind]));
    this.wrecks = this.fleet(this.theme.vehicles.read, this.theme.alert);
    const [w, h, l] = this.theme.vehicles.read.size;
    this.hostiles = this.fleet({ ...this.theme.hostile, size: [w * 1.2, h * 1.1, l] });
    this.waiters = this.fleet(this.theme.vehicles.write);
    this.stuck = this.fleet(this.theme.vehicles.async);
  }

  private updateBuildings(tick: TickMetrics | undefined): void {
    const fx = this.effects;
    const slowest = this.slowestNode(tick);
    for (const [id, b] of this.buildings) {
      const n = tick?.nodes[id];
      const u = n?.utilization ?? 0;
      const failed = n?.failed ?? 0;
      const shed = n?.shed ?? 0;
      const over = u > 1;
      const roof = new Vector3(b.home.x, b.top, b.home.z);

      // Saturé, le bâtiment tremble et fume ; un refus ou un doublon fait clignoter sa porte.
      b.group.position.set(b.home.x + (over ? Math.sin(fx.now * 61) * 0.03 : 0), 0, b.home.z + (over ? Math.cos(fx.now * 47) * 0.025 : 0));
      if (over) fx.steam(roof.clone().setY(b.top - 0.2));
      const blink = 0.5 + 0.5 * Math.sin(fx.now * 8);
      const refusing = failed > 0 && !b.source ? 0.2 + 0.25 * blink : 0;
      // Le bâtiment rougit à l'approche de la saturation, franchement au-delà.
      const heat = Math.max(Math.min(Math.max((u - 0.8) / 0.4, 0), 1), refusing);
      for (const m of b.tintable) {
        if ('emissive' in m && m.emissive instanceof Color) m.emissive.copy(this.alert).multiplyScalar(heat * 0.6);
      }

      // Une tour en panne reste debout et brûle ; les autres continuent de servir.
      const inService = tick ? (n?.instances ?? 1) : b.instances.length;
      const down = n?.down ?? 0;
      b.instances.forEach((o, i) => {
        const burning = i >= inService && i < inService + down;
        o.visible = i < inService || burning;
        this.char(o, burning);
        if (burning) {
          const p = o.getWorldPosition(new Vector3());
          fx.flames(p.clone().setY(b.top * 0.7));
          fx.smoke(p.clone().setY(b.top));
        }
      });
      if (b.gate) b.gate.rotation.x = n?.open ? 0 : -1.25;
      // Les instances à la demande, sur leur case voisine : servies, en chantier, ou en attente.
      const autoActive = tick ? Math.max(0, (n?.instances ?? 0) - Math.max(0, b.instances.length - down)) : 0;
      const starting = tick ? (n?.starting ?? 0) : 0;
      b.slots.forEach((s, i) => {
        const serving = i < autoActive;
        const rising = !serving && i < autoActive + starting;
        s.tower.visible = serving || rising;
        s.scaffold.visible = rising;
        s.tower.scale.set(1, rising ? 0.3 + 0.3 * (0.5 + 0.5 * Math.sin(fx.now * 3 + i)) : 1, 1);
      });
      if (down > 0 && b.instances.length === 0) {
        fx.flames(roof.clone().setY(b.top * 0.6));
        fx.smoke(roof);
      }

      if ((n?.duplicates ?? 0) > 0) fx.puff(roof.clone().setY(b.top * 0.5), DUPLICATE_TINT);
      if ((n?.lost ?? 0) > 0) {
        const out = [...this.roads.values()].find((r) => r.from === id);
        const next = out?.path[1];
        const along = next ? new Vector3(next.x - b.home.x, 0, next.z - b.home.z).normalize() : new Vector3(1, 0, 0);
        fx.letter(b.home.clone().addScaledVector(along, 0.6), along);
        fx.puff(b.home.clone().addScaledVector(along, 0.9).setY(0.4));
      }
      // Le consommateur plante sur un message empoisonné ; la file range à côté ce qu'elle a mis de côté (S25).
      if ((n?.poisoned ?? 0) > 0) fx.poison(roof.clone().setY(b.top * 0.6));
      if ((n?.deadLetters ?? 0) > 0) fx.deadLetters(new Vector3(b.home.x + 0.55, 0.05, b.home.z + 0.35), n!.deadLetters!, (n?.deadLettered ?? 0) > 0);
      if (shed > 0) fx.shield(b.home, 1.05, shed / Math.max(1, n?.rps ?? 1) + 0.3);
      // Circuit coupé : une barrière tombe en travers de la route, juste à la sortie du serveur.
      for (const cut of n?.open ?? []) {
        const road = this.roads.get(`${id}→${cut}`);
        if (!road) continue;
        const { point, angle } = pointAlong(road.path, Math.min(0.5, 1.1 / Math.max(pathLength(road.path), 1e-6)));
        fx.barrier(new Vector3(point.x, 0.05, point.z), angle);
      }

      // Partition : une barrière tombe entre les archives et leurs copistes (S21).
      if (n?.partitioned) fx.barrier(new Vector3(b.home.x, 0.05, b.home.z + 0.9), 0);
      // Les relances repartent des hameaux : plus il y en a, plus la poussière monte.
      const retries = b.source ? (tick?.retries ?? 0) : 0;
      const storming = retries > 0.5 * Math.max(1, (tick?.offered ?? 0) - retries);
      if (storming) fx.puff(roof.clone().setY(b.top * 0.6));

      const backlog = n?.backlog ?? 0;
      const parked = backlog > 0 ? Math.min(b.parked.length, Math.ceil(Math.log10(1 + backlog) * 3)) : 0;
      b.parked.forEach((o, i) => (o.visible = i < parked));

      const em = (text: string, hot = false) => `<em class="${hot ? 'hot' : ''}">${text}</em>`;
      const rounded = (x: number) => Math.round(x);
      b.label.innerHTML =
        `<b>${escapeHtml(b.techName)}</b><span>${escapeHtml(b.metaphor)}</span>` +
        (b.badges ? `<span class="badges">${b.badges}</span>` : '') +
        (starting > 0 ? em(`${pict('autoscale')} ${starting} instance${starting > 1 ? 's' : ''} en démarrage`, true) : '') +
        (down > 0 ? em(`${pict('warn')} ${down} instance${down > 1 ? 's' : ''} en panne`, true) : '') +
        // Au rejeu, chaque bâtiment montre ce qu'il reçoit et sa charge : de quoi dimensionner.
        (down > 0 && n?.instances === 0
          ? em('hors service', true)
          : n && n.rps > 0 ? em(`${rounded(n.rps)} req/s${b.source ? ' émises' : ` · charge ${rounded(u * 100)} %`}`, over) : '') +
        (id === slowest && n ? em(`<span class="hourglass">${pict('hourglass')}</span> ${rounded(n.latencyMs)} ms`, true) : '') +
        // La cascade : les fils du serveur attendent une dépendance ; le disjoncteur la coupe.
        ((n?.threads ?? 0) > 0.8 ? em(`${pict('cog')} fils occupés ${rounded((n?.threads ?? 0) * 100)} %`, (n?.threads ?? 0) > 1) : '') +
        (retries > 0 ? em(`↻ ${rounded(retries)} relances/s`, storming) : '') +
        (n?.partitioned ? em('✂ réplicas coupés du primaire', (n.stale ?? 0) > 0) : '') +
        ((n?.stale ?? 0) > 0 ? em(`≠ ${rounded(n!.stale!)} lectures périmées`, true) : '') +
        (n?.open ? em(`${pict('switch')} circuit coupé : ${n.open.map((t) => escapeHtml(this.buildings.get(t)?.techName ?? t)).join(', ')}`) : '') +
        (backlog > 0 ? em(`arriéré ${rounded(backlog)} <span class="gauge"><i style="width:${Math.min(100, (Math.log10(1 + backlog) / 4) * 100)}%"></i></span>`) : '') +
        // L'âge du plus vieux message, ce qu'on surveille vraiment sur une file (M13).
        ((n?.backlogAge ?? 0) > 0 ? em(`⌛ le plus vieux attend depuis ${n!.backlogAge} min`, (n!.backlogAge ?? 0) >= 10) : '') +
        ((n?.duplicates ?? 0) > 0 ? em(`×2 ${rounded(n!.duplicates!)} req/s traitées deux fois`, true) : '') +
        ((n?.deduplicated ?? 0) > 0 ? em(`${pict('seal')} ${rounded(n!.deduplicated!)} doublons écartés`) : '') +
        ((n?.lost ?? 0) > 0 ? em(`✉ ${rounded(n!.lost!)} événements perdus`, true) : '') +
        ((n?.poisoned ?? 0) > 0 ? em(`☠ ${rounded(n!.poisoned!)} messages empoisonnés rendus à la file`, true) : '') +
        ((n?.deadLetters ?? 0) > 0 ? em(`${pict('mailbox')} ${rounded(n!.deadLetters!)} lettres mortes à examiner`, (n?.deadLettered ?? 0) > 0) : '') +
        (failed > 0 ? em(`✕ ${rounded(failed)} req/s en échec`, true) : '') +
        (shed > 0 ? em(`${pict('barrier')} ${rounded(shed)} req/s abusives repoussées`) : '');
    }
  }

  /**
   * Le bâtiment qui fait attendre : le plus lent de ceux qui reçoivent du trafic, quand la
   * latence du tick dépasse le SLA. Le rendu ne recalcule pas le chemin critique : il montre
   * où regarder, la latence exacte reste dans la barre et les courbes.
   */
  private slowestNode(tick: TickMetrics | undefined): string | undefined {
    if (!tick || this.slaLatencyMs === undefined) return undefined;
    const general = tick.slaLatencyMs > this.slaLatencyMs;
    const ownGoal = Object.entries(tick.latencyByKind ?? {}).some(([k, l]) => l && l.p95Ms > (this.slaLatencyByKind[k as RequestKind] ?? Infinity));
    if (!general && !ownGoal) return undefined;
    let best: string | undefined;
    let worst = 0;
    for (const [id, n] of Object.entries(tick.nodes)) {
      if (n.rps > 0 && n.latencyMs > worst && !this.buildings.get(id)?.source) {
        worst = n.latencyMs;
        best = id;
      }
    }
    return best;
  }

  /** Noircit une tour en feu, et lui rend ses couleurs ensuite. */
  private char(o: Object3D, burning: boolean): void {
    if (!burning && !o.userData.charred) return;
    o.traverse((m) => {
      if (!(m instanceof Mesh)) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!('color' in mat) || !(mat.color instanceof Color)) continue;
        mat.userData.color ??= mat.color.clone();
        mat.color.copy(mat.userData.color as Color);
        if (burning) mat.color.lerp(CHARRED, 0.8);
      }
    });
    o.userData.charred = burning;
  }

  /** Une file qui déborde : les coursiers attendent en rang sur le chemin qui y mène. */
  /**
   * Ceux qui attendent, en rang au bout d'un chemin : les coursiers devant une file qui
   * déborde, et les mages figés devant une dépendance lente qui retient les fils du serveur.
   */
  private updateWaiting(tick: TickMetrics | undefined): void {
    this.waiters.begin();
    this.stuck.begin();
    for (const [id, n] of Object.entries(tick?.nodes ?? {})) {
      const backlog = n.backlog ?? 0;
      const into = backlog > 0 ? [...this.roads.values()].find((r) => r.to === id) : undefined;
      if (into) this.queueUp(this.waiters, into, Math.min(MAX_WAITING, Math.ceil(Math.log10(1 + backlog) * 2)));
      const stalled = n.waitingOn ? this.roads.get(`${id}→${n.waitingOn}`) : undefined;
      if (stalled) this.queueUp(this.stuck, stalled, Math.min(MAX_WAITING, 2 + Math.ceil(((n.threads ?? 1) - 1) * 10)));
    }
    this.waiters.end();
    this.stuck.end();
  }

  private queueUp(fleet: Fleet, road: Road, count: number): void {
    const length = pathLength(road.path);
    for (let k = 0; k < count; k++) {
      const f = 1 - (0.95 + k * 0.42) / length;
      if (f <= 0) break;
      const { point, angle } = pointAlong(road.path, f);
      const bob = Math.abs(Math.sin(this.effects.now * 3 + k)) * 0.015;
      this.dummy.position.set(point.x + Math.cos(angle) * 0.18, 0.06 + bob, point.z - Math.sin(angle) * 0.18);
      this.dummy.rotation.set(0, angle, 0);
      this.dummy.updateMatrix();
      // Ils attendent : une seule pose, celle du premier pas.
      fleet.add(this.dummy.matrix, 0, this.dummy.matrix.clone().setPosition(this.dummy.position.x, 0.065, this.dummy.position.z));
    }
  }

  private updateTravellers(time: number, journeys: Journey[]): void {
    const all = [...this.fleets.values(), this.wrecks, this.hostiles];
    for (const f of all) f.begin();
    for (const j of journeys) {
      const at = journeyAt(j, time);
      const road = at && this.roads.get(at.link);
      if (!at || !road) continue;
      // Un pillard reste un pillard ; une requête refusée ne rougit qu'en repartant.
      const fleet = j.hostile ? this.hostiles : at.failed ? this.wrecks : this.fleets.get(j.kind);
      if (!fleet) continue;

      const { point, angle } = pointAlong(road.path, at.f);
      // L'aller tient la droite, le retour l'autre côté : les deux sens se croisent sans se gêner.
      // Une copie marche à côté de l'original, sur la file voisine.
      const lane = (0.18 + REQUEST_KINDS.indexOf(j.kind) * LANE + (at.copy ? 0.22 : 0)) * (at.returning ? -1 : 1);
      const [, h] = this.theme.vehicles[j.kind].size;
      // Les personnages ont les pieds à zéro ; une boîte de secours est centrée.
      const y = fleet.grounded ? 0.06 : 0.04 + h / 2;
      // Chacun marche à son pas : la pose avance avec le temps du rejeu, décalée par voyageur.
      const stride = time * 0.75 + j.start * 3.1;
      const frame = Math.floor((stride - Math.floor(stride)) * WALK_FRAMES);
      this.dummy.position.set(point.x + Math.cos(angle) * lane, y, point.z - Math.sin(angle) * lane);
      // Un pillard repoussé culbute en arrière en quittant le bouclier.
      // Au retour, f va de 1 à 0 : la culbute occupe le premier tiers du chemin.
      const back = (1 - at.f) * 3;
      const tumble = j.hostile && at.returning && back < 1 ? back : 0;
      this.dummy.rotation.set(-tumble * Math.PI * 2, at.returning ? angle + Math.PI : angle, 0, 'YXZ');
      if (tumble > 0) this.dummy.position.y += Math.sin(tumble * Math.PI) * 0.4;
      // Refoulé, il se cogne à la porte et rebondit avant de repartir.
      if (at.bounce !== undefined) {
        this.dummy.position.y += Math.sin(at.bounce * Math.PI) * 0.22;
        this.dummy.rotation.x = -Math.sin(at.bounce * Math.PI) * 0.5;
      }
      // Perdu, il s'évapore ; une copie de doublon apparaît en grandissant, dans un nuage violet.
      const size = at.vanish !== undefined ? 1 - at.vanish : at.split !== undefined ? 0.3 + 0.7 * at.split : 1;
      this.dummy.scale.setScalar(Math.max(0.01, size));
      if ((at.vanish ?? 0) > 0) this.effects.puff(this.dummy.position.clone().setY(0.35));
      if (at.split !== undefined) this.effects.puff(this.dummy.position.clone().setY(0.3), DUPLICATE_TINT);
      this.dummy.updateMatrix();
      const body = this.dummy.matrix.clone();
      this.dummy.rotation.set(0, this.dummy.rotation.y, 0, 'XYZ');
      this.dummy.scale.setScalar(Math.max(0.01, size));
      // Le disque reste au sol pendant que le personnage sautille.
      this.dummy.position.y = 0.065;
      this.dummy.updateMatrix();
      fleet.add(body, frame, this.dummy.matrix);
      this.dummy.scale.setScalar(1);
    }
    for (const f of all) f.end();
  }
}

/** Pseudo-aléatoire déterministe dans [0, 1[, sans corrélation visible entre indices voisins. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
