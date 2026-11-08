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
  MeshLambertMaterial,
  Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
  type Material,
} from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Architecture, ArchNode, Catalog, RequestKind, TickMetrics } from '../engine/types.ts';
import { REQUEST_KINDS } from '../engine/types.ts';
import { escapeHtml } from './html.ts';
import { HEX_ROW, HEX_SIZE, HEX_WIDTH, hexCenter, hexKey, type Hex } from './hex.ts';
import { pointAlong, type Layout, type Point, type Road } from './layout.ts';
import { ModelLibrary, type ModelId } from './models.ts';
import type { BuildingStyle, Shape, Theme } from './theme.ts';
import { isReturning, progressAt, type Vehicle } from './traffic.ts';

const MAX_VEHICLES_PER_KIND = 2500;
/** Écart entre les voies : chaque type de requête roule sur sa file, pour rester lisible. */
const LANE = 0.2;
/** Les tuiles sont un peu réduites : le joint entre elles dessine la grille. */
const TILE_SCALE = 0.94;

const K = (name: string): ModelId => `kaykit/${name}`;

/** Les modèles KayKit dont chaque forme a besoin ; chargés une fois par rejeu. */
const SHAPE_MODELS: Record<Shape, ModelId[]> = {
  hamlet: ['building_home_A_blue', 'building_home_B_blue', 'building_well_blue', 'tree_single_A'].map(K),
  watchtower: ['building_tower_A_blue', 'flag_blue'].map(K),
  gatehouse: ['wall_straight_gate', 'building_tower_base_blue', 'building_barracks_blue', 'flag_blue'].map(K),
  tower: ['building_tower_A_blue', 'building_tower_B_blue'].map(K),
  lectern: ['building_market_blue', 'sack'].map(K),
  keep: ['building_castle_blue', 'building_tower_base_blue'].map(K),
  stables: ['building_tavern_blue', 'fence_wood_straight', 'crate_A_small', 'sack'].map(K),
};
const SCENERY_MODELS: ModelId[] = [
  'building_tower_base_blue',
  'hex_grass',
  'trees_A_medium',
  'trees_A_small',
  'tree_single_B',
  'rock_single_A',
].map(K);

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

/**
 * La cité en 3D isométrique. Elle ne simule rien : elle affiche l'état d'un tick calculé
 * par le moteur et place les véhicules que `traffic.ts` a déjà décidés.
 */
export class CityScene {
  private readonly renderer: WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly buildings = new Map<string, Building>();
  private readonly roads = new Map<string, Road>();
  private readonly fleets = new Map<RequestKind, InstancedMesh>();
  /** Véhicules qui font demi-tour : une flotte à part, à la couleur d'alerte du thème. */
  private wrecks!: InstancedMesh;
  /** Trafic abusif repoussé, à la couleur de l'ennemi. */
  private hostiles!: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly alert: Color;
  private readonly resize = () => this.fit();
  private readonly host: HTMLElement;
  private readonly theme: Theme;
  private readonly layout: Layout;
  private readonly models: ModelLibrary;

  /** Charge les modèles dont la scène a besoin, puis la construit. */
  static async create(
    host: HTMLElement,
    arch: Architecture,
    catalog: Catalog,
    theme: Theme,
    layout: Layout,
    baseUrl: string,
  ): Promise<CityScene> {
    const shapes = arch.nodes.map((n) => theme.buildings[n.type]?.shape).filter((s): s is Shape => s !== undefined);
    const characters = [...Object.values(theme.vehicles).map((v) => v.model), theme.hostile.model].filter(
      (m): m is string => m !== undefined,
    );
    const models = await ModelLibrary.load([...SCENERY_MODELS, ...shapes.flatMap((s) => SHAPE_MODELS[s]), ...characters], baseUrl);
    return new CityScene(host, arch, catalog, theme, layout, models);
  }

  private constructor(
    host: HTMLElement,
    arch: Architecture,
    catalog: Catalog,
    theme: Theme,
    layout: Layout,
    models: ModelLibrary,
  ) {
    this.host = host;
    this.theme = theme;
    this.layout = layout;
    this.models = models;
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
    this.addLights();
    this.addGround();
    for (const road of layout.roads) this.addRoad(road);
    this.addPaths();
    for (const node of arch.nodes) this.addBuilding(node, catalog);
    this.addTrees();
    this.addFleets();

    window.addEventListener('resize', this.resize);
    this.fit();
  }

  /** Affiche l'état du tick courant et les véhicules en route à l'instant `time`. */
  update(time: number, tick: TickMetrics | undefined, vehicles: Vehicle[]): void {
    if (tick) this.updateBuildings(tick);
    this.updateVehicles(time, vehicles);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.scene.traverse((o) => {
      if (o instanceof Mesh || o instanceof InstancedMesh) {
        o.geometry.dispose();
        const m = o.material;
        (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);

    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Vue isométrique : la caméra regarde le centre depuis la diagonale, en hauteur.
    const d = 40;
    this.camera.position.set(cx + d, d * 0.82, cz + d);
    this.camera.lookAt(cx, 0, cz);

    // L'emprise projetée d'un rectangle vu à 45° : on cadre sur sa diagonale.
    const span = Math.max(maxX - minX, maxZ - minZ) + 6;
    const aspect = w / Math.max(h, 1);
    const half = (span * 0.58) / Math.min(aspect, 1.6);
    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

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

  /**
   * Le sol est le plateau hexagonal où le joueur bâtira : une tuile d'herbe KayKit par case,
   * instanciées, avec un joint visible entre elles.
   */
  private addGround(): void {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const x0 = minX - 8;
    const x1 = maxX + 8;
    const z0 = minZ - 7;
    const z1 = maxZ + 7;
    const cells: Hex[] = [];
    for (let r = Math.floor(z0 / HEX_ROW); r <= Math.ceil(z1 / HEX_ROW); r++) {
      for (let q = Math.ceil(x0 / HEX_WIDTH - r / 2); q <= Math.floor(x1 / HEX_WIDTH - r / 2); q++) cells.push({ q, r });
    }
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

    // Sous les tuiles, un fond sombre : il remplit les joints et les fait ressortir.
    const under = new Mesh(new PlaneGeometry(x1 - x0 + 4, z1 - z0 + 4), new MeshLambertMaterial({ color: this.theme.ground }));
    under.rotation.x = -Math.PI / 2;
    under.position.set((x0 + x1) / 2, -0.3, (z0 + z1) / 2);
    this.scene.add(under);
  }

  /**
   * Un chemin est une suite de cases pavées de terre, sous les bâtiments qui en occupent
   * les extrémités. C'est la forme qu'aura un chemin tracé par le joueur.
   */
  private addPaths(): void {
    const paved = new Map<string, Hex>();
    for (const road of this.layout.roads) for (const c of road.cells) paved.set(hexKey(c), c);
    // Six segments, premier sommet sur l'axe z : la même orientation « pointe en haut » que les tuiles.
    const geometry = new CylinderGeometry(HEX_SIZE * TILE_SCALE, HEX_SIZE * TILE_SCALE, 0.06, 6);
    const tiles = new InstancedMesh(geometry, new MeshLambertMaterial({ color: this.theme.road }), paved.size);
    [...paved.values()].forEach((c, i) => {
      const p = hexCenter(c);
      this.dummy.position.set(p.x, 0.03, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      tiles.setMatrixAt(i, this.dummy.matrix);
    });
    tiles.receiveShadow = true;
    this.scene.add(tiles);
  }

  private addRoad(road: Road): void {
    this.roads.set(road.key, road);
  }

  private addBuilding(node: ArchNode, catalog: Catalog): void {
    const at = this.layout.nodes[node.id];
    const def = catalog.components[node.type];
    const style = this.theme.buildings[node.type];
    if (!at || !def || !style) return;

    const group = new Group();
    group.position.set(at.x, 0, at.z);
    const b: Building = {
      node,
      group,
      tintable: [],
      instances: [],
      parked: [],
      label: document.createElement('div'),
      techName: def.techName,
      metaphor: style.metaphor,
    };
    this.build(b, style, catalog);

    b.label.className = 'city-label';
    const label = new CSS2DObject(b.label);
    label.position.set(0, new Box3().setFromObject(group).max.y + 0.6, 0);
    group.add(label);

    this.scene.add(group);
    this.buildings.set(node.id, b);
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
  private build(b: Building, style: BuildingStyle, catalog: Catalog): void {
    const g = b.group;
    const levelOf = (effect: string) =>
      Object.entries(b.node.upgrades ?? {}).reduce((a, [u, l]) => a + (catalog.upgrades[u]?.effect.type === effect ? l : 0), 0);

    switch (style.shape) {
      case 'hamlet':
        this.put(g, K('building_home_A_blue'), { x: -0.7, z: -0.7, rotate: 0.3 }, b);
        this.put(g, K('building_home_B_blue'), { x: 0.8, z: -0.5, rotate: -0.4 }, b);
        this.put(g, K('building_home_A_blue'), { x: -0.4, z: 0.9, rotate: 2.6 }, b);
        this.put(g, K('building_well_blue'), { x: 0.7, z: 0.8 }, b);
        this.put(g, K('tree_single_A'), { x: -1.6, z: 0.2 });
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
        // Le rate limiting devient la caserne de la garde, accolée à la porte côté cité.
        if (levelOf('rateLimit') > 0) this.put(g, K('building_barracks_blue'), { x: 1.4, z: -2.1, rotate: Math.PI }, b);
        break;

      case 'tower': {
        // Une tour par instance possible : le scaling fixe et le plafond d'autoscaling.
        const max = 1 + levelOf('instances') + levelOf('autoscaling');
        const cols = Math.ceil(Math.sqrt(max));
        for (let i = 0; i < max; i++) {
          const tower = this.put(g, K(i % 2 === 0 ? 'building_tower_A_blue' : 'building_tower_B_blue'), {
            x: ((i % cols) - (cols - 1) / 2) * 1.1,
            z: (Math.floor(i / cols) - (Math.ceil(max / cols) - 1) / 2) * 1.1,
            scale: 0.8,
            rotate: (i * 1.3) % (Math.PI * 2),
          }, b);
          tower.visible = i === 0;
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
          this.put(g, K('building_tower_base_blue'), { x: -1.6 + (i % 3) * 1, z: 1.7 + Math.floor(i / 3) * 1, scale: 0.8 }, b);
        }
        break;
      }

      case 'stables':
        // La taverne du relais et son enclos : les colis en attente s'y empilent.
        this.put(g, K('building_tavern_blue'), { x: -1.2 }, b);
        for (const z of [-0.6, 0.6]) this.put(g, K('fence_wood_straight'), { x: 1.1, z }, b);
        for (const x of [0, 0.6]) {
          this.put(g, K('fence_wood_straight'), { x, z: -1.1, rotate: Math.PI / 2 }, b);
          this.put(g, K('fence_wood_straight'), { x, z: 1.1, rotate: Math.PI / 2 }, b);
        }
        for (let i = 0; i < 12; i++) {
          const parcel = this.put(g, K(i % 3 === 0 ? 'sack' : 'crate_A_small'), {
            x: -0.2 + (i % 4) * 0.3,
            z: -0.6 + Math.floor(i / 4) * 0.5,
            scale: 2,
          }, b);
          parcel.visible = false;
          b.parked.push(parcel);
        }
        break;
    }
  }

  /** Bosquets et rochers autour des bâtiments, placés de façon déterministe : le même rejeu, le même paysage. */
  private addTrees(): void {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const roadPoints = this.layout.roads.flatMap((r) => sample(r.path, 0.3));
    const nodes = Object.values(this.layout.nodes);
    const kinds = ['trees_A_medium', 'trees_A_small', 'tree_single_B', 'rock_single_A'];
    for (let i = 0; i < 80; i++) {
      // Hachage fixe : pas de Math.random dans le rendu, le même rejeu donne le même paysage.
      const u = hash(i * 2 + 1);
      const v = hash(i * 2 + 2);
      const x = minX - 6 + u * (maxX - minX + 12);
      const z = minZ - 6 + v * (maxZ - minZ + 12);
      const crowded =
        nodes.some((p) => Math.hypot(p.x - x, p.z - z) < 2.2) || roadPoints.some((p) => Math.hypot(p.x - x, p.z - z) < 1.2);
      if (crowded) continue;
      this.put(this.scene, K(kinds[i % kinds.length]!), { x, z, rotate: u * Math.PI * 2 });
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

  private updateBuildings(tick: TickMetrics): void {
    for (const [id, b] of this.buildings) {
      const n = tick.nodes[id];
      const u = n?.utilization ?? 0;
      // Le bâtiment rougit à l'approche de la saturation, franchement au-delà.
      const heat = Math.min(Math.max((u - 0.8) / 0.4, 0), 1);
      for (const m of b.tintable) {
        if ('emissive' in m && m.emissive instanceof Color) m.emissive.copy(this.alert).multiplyScalar(heat * 0.6);
      }

      const visible = n?.instances ?? 1;
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

/** Points régulièrement espacés le long d'un chemin, pour tester la proximité d'une route. */
function sample(path: Point[], step: number): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

/** Pseudo-aléatoire déterministe dans [0, 1[, sans corrélation visible entre indices voisins. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
