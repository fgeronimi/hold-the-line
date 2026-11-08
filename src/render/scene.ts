import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
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
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Architecture, ArchNode, Catalog, RequestKind, TickMetrics } from '../engine/types.ts';
import { REQUEST_KINDS } from '../engine/types.ts';
import { escapeHtml } from './html.ts';
import { pointAlong, type Layout, type Point, type Road } from './layout.ts';
import { ModelLibrary, type ModelId } from './models.ts';
import type { BuildingStyle, Shape, Theme } from './theme.ts';
import { progressAt, type Vehicle } from './traffic.ts';

const MAX_VEHICLES_PER_KIND = 2500;
const ROAD_WIDTH = 0.8;
/** Écart entre les voies : chaque type de requête roule sur sa file, pour rester lisible. */
const LANE = 0.2;
/** Longueur d'un tronçon de rempart, à l'échelle des modèles. */
const WALL = 0.8;

/** Les modèles Kenney dont chaque forme a besoin ; chargés une fois par rejeu. */
const SHAPE_MODELS: Record<Shape, ModelId[]> = {
  hamlet: ['fantasy/wall-pane-wood', 'fantasy/roof', 'castle/tree-small'],
  watchtower: ['castle/tower-square-base', 'castle/tower-square-mid-windows', 'castle/tower-square-top-roof', 'castle/flag'],
  gatehouse: ['castle/wall-narrow-gate', 'castle/tower-square', 'castle/tower-hexagon-roof', 'castle/metal-gate'],
  tower: ['castle/tower-hexagon-base', 'castle/tower-hexagon-mid', 'castle/tower-hexagon-roof'],
  lectern: ['fantasy/structure', 'fantasy/overhang', 'fantasy/barrels', 'fantasy/detail-crate'],
  keep: ['castle/tower-square-base', 'castle/tower-square-mid-windows', 'castle/tower-square-top-roof', 'castle/flag'],
  stables: ['fantasy/fence-wood', 'fantasy/structure', 'fantasy/overhang', 'fantasy/detail-crate'],
};
const SCENERY_MODELS: ModelId[] = [
  'castle/wall',
  'castle/tower-hexagon-base',
  'castle/tower-hexagon-roof',
  'castle/tree-large',
  'castle/tree-small',
];

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
    const models = await ModelLibrary.load([...SCENERY_MODELS, ...shapes.flatMap((s) => SHAPE_MODELS[s])], baseUrl);
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
    for (const node of arch.nodes) this.addBuilding(node, catalog);
    this.addRamparts(arch, catalog);
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
    this.scene.add(new HemisphereLight('#ffffff', '#8aa07a', 1.6));
    this.scene.add(new AmbientLight('#ffffff', 0.4));
    const sun = new DirectionalLight('#fff4e0', 2.2);
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

  private addGround(): void {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const ground = new Mesh(
      new PlaneGeometry(maxX - minX + 14, maxZ - minZ + 14),
      new MeshLambertMaterial({ color: this.theme.ground }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private addRoad(road: Road): void {
    this.roads.set(road.key, road);
    const material = new MeshLambertMaterial({ color: this.theme.road });
    for (let i = 1; i < road.path.length; i++) {
      const a = road.path[i - 1]!;
      const b = road.path[i]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      // Le segment déborde d'une demi-largeur pour que les virages se rejoignent sans trou.
      const seg = new Mesh(new BoxGeometry(ROAD_WIDTH, 0.04, length + ROAD_WIDTH), material);
      seg.position.set((a.x + b.x) / 2, 0.02, (a.z + b.z) / 2);
      seg.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
      seg.receiveShadow = true;
      this.scene.add(seg);
    }
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
   * (remparts, arbres) n'en a pas et ne rougit jamais.
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

  /** Assemble les pièces Kenney qui forment ce composant dans la métaphore. */
  private build(b: Building, style: BuildingStyle, catalog: Catalog): void {
    const g = b.group;
    const levelOf = (effect: string) =>
      Object.entries(b.node.upgrades ?? {}).reduce((a, [u, l]) => a + (catalog.upgrades[u]?.effect.type === effect ? l : 0), 0);

    switch (style.shape) {
      case 'hamlet':
        // Des maisons faites de quatre pans de bois et d'un toit, et un arbre.
        for (const [x, z, r] of [[-0.8, -0.7, 0], [0.7, -0.6, 0.4], [-0.6, 0.8, -0.3], [0.9, 0.8, 0.1]] as const) {
          const house = new Group();
          for (const [px, pz, pr] of [[0, 0.5, 0], [0, -0.5, Math.PI], [-0.5, 0, -Math.PI / 2], [0.5, 0, Math.PI / 2]] as const) {
            this.put(house, 'fantasy/wall-pane-wood', { x: px, z: pz, rotate: pr }, b);
          }
          this.put(house, 'fantasy/roof', { y: 1 }, b);
          house.position.set(x, 0, z);
          house.rotation.y = r;
          house.scale.setScalar(0.7);
          g.add(house);
        }
        this.put(g, 'castle/tree-small', { x: -1.6, z: 0.1 });
        break;

      case 'watchtower':
        this.stack(g, ['castle/tower-square-base', 'castle/tower-square-mid-windows', 'castle/tower-square-top-roof'], 0.8, b);
        this.put(g, 'castle/flag', { y: 2.4, scale: 0.8 }, b);
        break;

      case 'gatehouse':
        // Le mur percé d'une porte, entre deux tours : la route passe dessous.
        this.put(g, 'castle/wall-narrow-gate', { scale: 1.5, x: -0.25 }, b);
        for (const z of [-1.1, 1.1]) {
          this.put(g, 'castle/tower-square', { z, scale: 1.1 }, b);
          this.put(g, 'castle/tower-hexagon-roof', { z, y: 1.44, scale: 1.1 }, b);
        }
        // Le rate limiting devient une herse baissée dans la porte.
        if (levelOf('rateLimit') > 0) this.put(g, 'castle/metal-gate', { x: -0.05, scale: 1.4 }, b);
        break;

      case 'tower': {
        // Une tour par instance possible : le scaling fixe et le plafond d'autoscaling.
        const max = 1 + levelOf('instances') + levelOf('autoscaling');
        const cols = Math.ceil(Math.sqrt(max));
        for (let i = 0; i < max; i++) {
          const tower = new Group();
          const floors = 1 + ((i * 37) % 3);
          const parts: ModelId[] = [
            'castle/tower-hexagon-base',
            ...Array<ModelId>(floors).fill('castle/tower-hexagon-mid'),
            'castle/tower-hexagon-roof',
          ];
          this.stack(tower, parts, 0.85, b);
          tower.position.set(
            ((i % cols) - (cols - 1) / 2) * 0.95,
            0,
            (Math.floor(i / cols) - (Math.ceil(max / cols) - 1) / 2) * 0.95,
          );
          tower.visible = i === 0;
          b.instances.push(tower);
          g.add(tower);
        }
        break;
      }

      case 'lectern':
        // Une échoppe de bois sous auvent : le scribe y lit sans aller jusqu'aux archives.
        this.put(g, 'fantasy/structure', { scale: 1.1 }, b);
        this.put(g, 'fantasy/overhang', { y: 0.8, z: 0.6, scale: 1.1 }, b);
        this.put(g, 'fantasy/barrels', { x: 0.1, z: 0.1 }, b);
        this.put(g, 'fantasy/detail-crate', { x: -0.7, z: 0.5 }, b);
        break;

      case 'keep': {
        this.stack(
          g,
          ['castle/tower-square-base', 'castle/tower-square-mid-windows', 'castle/tower-square-mid-windows', 'castle/tower-square-top-roof'],
          1.5,
          b,
        );
        this.put(g, 'castle/flag', { y: 5.3, scale: 1.2 }, b);
        // Une annexe par réplica en lecture.
        const replicas = levelOf('readReplicas');
        for (let i = 0; i < replicas; i++) {
          const annex = new Group();
          this.stack(annex, ['castle/tower-square-base', 'castle/tower-square-top-roof'], 0.7, b);
          annex.position.set(-1.4 + (i % 3) * 0.8, 0, 1.4 + Math.floor(i / 3) * 0.8);
          g.add(annex);
        }
        break;
      }

      case 'stables':
        // Un enclos de bois et un abri : les coursiers en attente s'y alignent.
        for (const x of [-0.5, 0.5]) {
          this.put(g, 'fantasy/fence-wood', { x, z: -0.8 }, b);
          this.put(g, 'fantasy/fence-wood', { x, z: 0.8 }, b);
        }
        for (const z of [-0.4, 0.4]) this.put(g, 'fantasy/fence-wood', { x: 1, z, rotate: Math.PI / 2 }, b);
        this.put(g, 'fantasy/structure', { x: -1.4 }, b);
        this.put(g, 'fantasy/overhang', { x: -1.4, y: 0.8, z: 0.55 }, b);
        for (let i = 0; i < 12; i++) {
          const crate = this.put(g, 'fantasy/detail-crate', { x: -0.7 + (i % 6) * 0.3, z: -0.4 + Math.floor(i / 6) * 0.8 }, b);
          crate.visible = false;
          b.parked.push(crate);
        }
        break;
    }
  }

  /** Empile des étages (base, milieux, toit) en lisant la hauteur réelle de chacun. */
  private stack(parent: Object3D, parts: ModelId[], scale: number, b: Building): void {
    let y = 0;
    const size = new Vector3();
    for (const id of parts) {
      const piece = this.put(parent, id, { y, scale }, b);
      y += new Box3().setFromObject(piece).getSize(size).y;
    }
  }

  /**
   * L'enceinte entoure tout ce qui n'est pas une source. Côté entrée, elle passe par la
   * première rangée de bâtiments : la porte est dans le mur. Les tronçons que traverse
   * une route sont omis : ce sont les ouvertures de la cité.
   */
  private addRamparts(arch: Architecture, catalog: Catalog): void {
    if (!this.theme.ramparts) return;
    const inside = arch.nodes.filter((n) => catalog.components[n.type]?.behavior !== 'source');
    const points = inside.map((n) => this.layout.nodes[n.id]).filter((p) => p !== undefined);
    if (points.length === 0) return;

    const m = 2;
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x)) + m;
    const minZ = Math.min(...points.map((p) => p.z)) - m;
    const maxZ = Math.max(...points.map((p) => p.z)) + m;

    const roadPoints = this.layout.roads.flatMap((r) => sample(r.path, 0.2));
    const nearRoad = (x: number, z: number) => roadPoints.some((p) => Math.hypot(p.x - x, p.z - z) < 0.75);
    // Sur le mur d'entrée, la place des bâtiments d'entrée (la porte et ses tours) reste libre.
    const nearEntry = (x: number, z: number) =>
      Math.abs(x - minX) < 0.1 && points.some((p) => p.x === minX && Math.abs(p.z - z) < 1.6);

    const wall = (x: number, z: number, alongX: boolean) => {
      if (nearRoad(x, z) || nearEntry(x, z)) return;
      this.put(this.scene, 'castle/wall', { x, z, scale: WALL, rotate: alongX ? 0 : Math.PI / 2 });
    };
    for (let x = minX + WALL / 2; x < maxX; x += WALL) {
      wall(x, minZ, true);
      wall(x, maxZ, true);
    }
    for (let z = minZ + WALL / 2; z < maxZ; z += WALL) {
      wall(minX, z, false);
      wall(maxX, z, false);
    }
    for (const [x, z] of [[minX, minZ], [minX, maxZ], [maxX, minZ], [maxX, maxZ]] as const) {
      this.put(this.scene, 'castle/tower-hexagon-base', { x, z, scale: 1.1 });
      this.put(this.scene, 'castle/tower-hexagon-roof', { x, z, y: 1.44, scale: 1.1 });
    }
  }

  /** Quelques arbres hors les murs, placés de façon déterministe : le même rejeu, le même paysage. */
  private addTrees(): void {
    const { minX, maxX, minZ, maxZ } = this.layout.bounds;
    const roadPoints = this.layout.roads.flatMap((r) => sample(r.path, 0.3));
    const nodes = Object.values(this.layout.nodes);
    for (let i = 0; i < 40; i++) {
      // Suite fixe (hachage multiplicatif de Knuth) : pas de Math.random dans le rendu.
      const u = ((i * 2654435761) % 1000) / 1000;
      const v = ((i * 40503 + 7919) % 1000) / 1000;
      const x = minX - 5 + u * (maxX - minX + 10);
      const z = minZ - 5 + v * (maxZ - minZ + 10);
      const insideWalls = x > minX + 2.5 && x < maxX + 2.5 && z > minZ - 2.5 && z < maxZ + 2.5;
      const crowded =
        nodes.some((p) => Math.hypot(p.x - x, p.z - z) < 2) || roadPoints.some((p) => Math.hypot(p.x - x, p.z - z) < 1);
      if (insideWalls || crowded) continue;
      this.put(this.scene, i % 3 === 0 ? 'castle/tree-large' : 'castle/tree-small', { x, z, rotate: u * Math.PI * 2 });
    }
  }

  private addFleets(): void {
    for (const kind of REQUEST_KINDS) {
      const style = this.theme.vehicles[kind];
      const [w, h, l] = style.size;
      const mesh = new InstancedMesh(new BoxGeometry(w, h, l), new MeshLambertMaterial({ color: style.color }), MAX_VEHICLES_PER_KIND);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.count = 0;
      this.fleets.set(kind, mesh);
      this.scene.add(mesh);
    }
    const [w, h, l] = this.theme.vehicles.read.size;
    this.wrecks = new InstancedMesh(new BoxGeometry(w, h, l), new MeshLambertMaterial({ color: this.theme.alert }), MAX_VEHICLES_PER_KIND);
    this.wrecks.instanceMatrix.setUsage(DynamicDrawUsage);
    this.wrecks.count = 0;
    this.hostiles = new InstancedMesh(
      new BoxGeometry(w * 1.2, h * 1.3, l),
      new MeshLambertMaterial({ color: this.theme.hostile.color }),
      MAX_VEHICLES_PER_KIND,
    );
    this.hostiles.instanceMatrix.setUsage(DynamicDrawUsage);
    this.hostiles.count = 0;
    this.scene.add(this.wrecks, this.hostiles);
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
        (u > 0 ? `<em class="${u > 1 ? 'hot' : ''}">charge ${Math.round(u * 100)} %</em>` : '') +
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
      this.dummy.position.set(point.x + Math.cos(angle) * lane, 0.04 + h / 2, point.z - Math.sin(angle) * lane);
      this.dummy.rotation.set(0, angle, 0);
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
