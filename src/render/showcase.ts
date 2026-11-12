import {
  AdditiveBlending,
  AmbientLight,
  Box3,
  BoxGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OrthographicCamera,
  PCFSoftShadowMap,
  PointLight,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { catalog } from '../data/catalog.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { HEX_WIDTH, hexCenter, type Hex } from './hex.ts';
import { Effects } from './effects.ts';
import { ModelLibrary, type ModelId } from './models.ts';
import { BRIDGE_MODEL, bridgeRotation, crossingTile, mask, riverTile, roadTile, type Tile } from './terrain.ts';

/**
 * Vitrine des incidents (`vitrine.html`, debug) : un îlot de sept cases par problème,
 * animé en boucle avec les modèles du jeu, pour choisir les effets avant de les brancher
 * sur les ticks du rejeu. Rien ici ne lit le moteur : les boucles sont écrites à la main.
 */

const K = (name: string): ModelId => `kaykit/${name}`;
const TILE_SCALE = 0.94;
const ALERT = new Color(theme.alert);
/** Le chemin entre par l'ouest et s'arrête à la porte du bâtiment, sur la case (1, 0). */
const ROAD_START = -3.1;
const DOOR = 1.05;
const SITE = hexCenter({ q: 1, r: 0 });

type Kind = 'read' | 'write' | 'async' | 'hostile';

const MODELS: ModelId[] = [
  'hex_grass', 'trees_A_small', 'rock_single_A', 'hex_road_A', 'hex_river_A', 'hex_river_crossing_A', 'hex_river_crossing_B', BRIDGE_MODEL,
  'building_tower_A_blue', 'building_tower_B_blue', 'building_castle_blue', 'building_tower_base_blue', 'building_tavern_blue',
  'fence_wood_straight', 'crate_A_small', 'sack', 'building_church_blue', 'flag_blue', 'wall_straight_gate', 'building_barracks_blue', 'building_home_B_blue', 'building_market_blue',
].map((m) => (m.startsWith('kaykit') ? m : K(m)));
const CHARACTERS = [...Object.values(theme.vehicles).map((v) => v.model!), theme.hostile.model!];

const phase = (t: number, period: number, offset = 0) => (((t / period + offset) % 1) + 1) % 1;
const lerp = (a: number, b: number, f: number) => a + (b - a) * Math.min(Math.max(f, 0), 1);
const between = (p: number, a: number, b: number) => (p - a) / (b - a);

/** Un personnage du jeu et son disque au sol ; `failed` le teinte comme une requête refusée. */
class Walker {
  readonly root = new Group();
  private readonly body: Mesh;

  constructor(cast: Cast, kind: Kind, failed = false) {
    const baked = cast.bake(kind);
    const materials = failed
      ? baked.materials.map((m) => {
          const c = m.clone();
          if ('color' in c && c.color instanceof Color) c.color.copy(ALERT);
          return c;
        })
      : baked.materials;
    this.body = new Mesh(baked.geometry, materials);
    this.body.castShadow = true;
    const color = failed ? theme.alert : kind === 'hostile' ? theme.hostile.color : theme.vehicles[kind].color;
    const disc = new Mesh(
      new CircleGeometry(0.23, 20).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    disc.position.y = 0.005;
    this.root.add(this.body, disc);
    this.root.rotation.order = 'YXZ';
  }

  /** Pose au point (x, z), tourné vers l'est ou l'ouest ; il sautille s'il marche. */
  at(x: number, z: number, east: boolean, t: number, walking = true): this {
    this.root.visible = true;
    this.root.position.set(x, 0.06, z);
    this.root.rotation.set(0, east ? Math.PI / 2 : -Math.PI / 2, 0);
    this.root.scale.setScalar(1);
    this.body.position.y = walking ? Math.abs(Math.sin(t * 9 + x)) * 0.06 : Math.abs(Math.sin(t * 3)) * 0.015;
    return this;
  }

  hide(): void {
    this.root.visible = false;
  }
}

/** Personnages figés une fois, partagés par tous les îlots. */
class Cast {
  private readonly cache = new Map<Kind, { geometry: BufferGeometry; materials: Material[] }>();
  private readonly lib: ModelLibrary;
  constructor(lib: ModelLibrary) {
    this.lib = lib;
  }

  bake(kind: Kind) {
    let baked = this.cache.get(kind);
    if (!baked) {
      const model = kind === 'hostile' ? theme.hostile.model! : theme.vehicles[kind].model!;
      // Le pillard est un peu plus grand que le messager, comme sur le plateau.
      const height = kind === 'hostile' ? theme.vehicles.read.size[1] * 1.1 : theme.vehicles[kind].size[1];
      baked = this.lib.bakeCharacter(model, height);
      this.cache.set(kind, baked);
    }
    return baked;
  }
}

/** Un bâtiment de l'îlot : ses pièces, et les matériaux qui rougissent ou noircissent. */
interface Site {
  group: Group;
  parts: Object3D[];
  tint: Material[];
  top: number;
}

/**
 * Un seul contexte WebGL pour toute la page : Chrome n'en garde que 16, et la vitrine a plus
 * d'îlots. Chaque îlot est rendu tour à tour, puis recopié dans sa propre toile 2D.
 */
let shared: WebGLRenderer | undefined;
function gl(): WebGLRenderer {
  if (!shared) {
    shared = new WebGLRenderer({ antialias: true });
    shared.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    shared.shadowMap.enabled = true;
    shared.shadowMap.type = PCFSoftShadowMap;
  }
  return shared;
}

class Vignette {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  private readonly canvas = document.createElement('canvas');
  private readonly labels = new CSS2DRenderer();
  /** Faux quand l'îlot est hors de l'écran : on ne le rend pas. */
  visible = true;

  readonly host: HTMLElement;
  readonly lib: ModelLibrary;
  readonly cast: Cast;

  constructor(host: HTMLElement, lib: ModelLibrary, cast: Cast, river = false) {
    this.host = host;
    this.lib = lib;
    this.cast = cast;
    host.appendChild(this.canvas);
    new IntersectionObserver(([e]) => (this.visible = e!.isIntersecting)).observe(host);
    this.labels.domElement.className = 'labels';
    host.appendChild(this.labels.domElement);
    this.scene.background = new Color('#dfe8ee');

    this.scene.add(new HemisphereLight('#ffffff', '#6f8f5a', 0.8), new AmbientLight('#ffffff', 0.25));
    const sun = new DirectionalLight('#ffffff', 1.7);
    sun.position.set(-8, 20, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 60 });
    this.scene.add(sun);

    this.terrain(river);
    const d = 30;
    const c = new Vector3(0.2, 0.6, 0.1);
    this.camera.position.set(c.x + d, d * 0.82, c.z + d);
    this.camera.lookAt(c);
    this.fit();
  }

  fit(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.labels.setSize(w, h);
    const aspect = w / Math.max(h, 1);
    const half = 2.15;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    if (!this.visible) return;
    const r = gl();
    r.setSize(this.host.clientWidth, this.host.clientHeight, false);
    r.render(this.scene, this.camera);
    this.canvas.getContext('2d')!.drawImage(r.domElement, 0, 0, this.canvas.width, this.canvas.height);
    this.labels.render(this.scene, this.camera);
  }

  put(parent: Object3D, id: ModelId, at: { x?: number; y?: number; z?: number; scale?: number; rotate?: number } = {}, tint?: Material[]): Object3D {
    const { object, materials } = this.lib.place(id);
    object.position.set(at.x ?? 0, at.y ?? 0, at.z ?? 0);
    object.scale.setScalar(at.scale ?? 1);
    object.rotation.y = at.rotate ?? 0;
    tint?.push(...materials);
    parent.add(object);
    return object;
  }

  /** Bâtiment posé sur la case de droite, réduit s'il déborde de sa case comme sur le plateau. */
  site(build: (g: Group, tint: Material[], parts: Object3D[]) => void): Site {
    const group = new Group();
    const tint: Material[] = [];
    const parts: Object3D[] = [];
    build(group, tint, parts);
    const size = new Box3().setFromObject(group).getSize(new Vector3());
    const span = Math.max(size.x, size.z);
    if (span > HEX_WIDTH * 0.95) group.scale.setScalar((HEX_WIDTH * 0.95) / span);
    group.position.set(SITE.x, 0, SITE.z);
    this.scene.add(group);
    const top = new Box3().setFromObject(group).max.y;
    return { group, parts, tint, top };
  }

  walker(kind: Kind, failed = false): Walker {
    const w = new Walker(this.cast, kind, failed);
    this.scene.add(w.root);
    return w;
  }

  label(className: string, html: string, x: number, y: number, z: number): HTMLElement {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = html;
    const o = new CSS2DObject(el);
    o.position.set(x, y, z);
    this.scene.add(o);
    return el;
  }

  /** Sept cases : le chemin entre par l'ouest ; avec `river`, une rivière le coupe sous un pont. */
  private terrain(river: boolean): void {
    const road = new Set(['-1,0', '0,0']);
    const water = new Set(river ? ['0,0', '1,-1', '-1,1'] : []);
    const cells: Hex[] = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
    const tile = (cell: Hex, t: Tile | undefined) => {
      const p = hexCenter(cell);
      if (t) this.put(this.scene, K(t.model), { x: p.x, z: p.z, rotate: (t.turns * Math.PI) / 3, scale: TILE_SCALE });
    };
    for (const cell of cells) {
      const key = `${cell.q},${cell.r}`;
      const p = hexCenter(cell);
      if (water.has(key) && road.has(key)) {
        tile(cell, crossingTile(mask(1, 4), mask(0, 3)));
        this.put(this.scene, K(BRIDGE_MODEL), { x: p.x, z: p.z, rotate: bridgeRotation(mask(0, 3)), scale: TILE_SCALE });
      } else if (water.has(key)) tile(cell, riverTile(mask(1, 4)));
      else if (road.has(key)) tile(cell, roadTile(mask(0, 3)));
      else {
        const g = this.put(this.scene, K('hex_grass'), { x: p.x, z: p.z });
        g.scale.set(TILE_SCALE, 1, TILE_SCALE);
      }
    }
    this.put(this.scene, K('trees_A_small'), { ...hexCenter({ q: 0, r: -1 }), rotate: 0.8 });
    if (!river) this.put(this.scene, K('rock_single_A'), { ...hexCenter({ q: -1, r: 1 }), rotate: 1.4 });
  }
}

/** Les tours d'un serveur, disposées comme sur le plateau (une par instance). */
function towers(v: Vignette, count: number) {
  return (g: Group, tint: Material[], parts: Object3D[]) => {
    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      const own: Material[] = [];
      const tower = v.put(
        g,
        K(i % 2 === 0 ? 'building_tower_A_blue' : 'building_tower_B_blue'),
        { x: ((i % cols) - (cols - 1) / 2) * 1.1, z: (Math.floor(i / cols) - (Math.ceil(count / cols) - 1) / 2) * 1.1, scale: 0.8, rotate: (i * 1.3) % (Math.PI * 2) },
        own,
      );
      tower.userData.materials = own;
      tint.push(...own);
      parts.push(tower);
    }
  };
}

function heat(site: Site, amount: number): void {
  for (const m of site.tint) if ('emissive' in m && m.emissive instanceof Color) m.emissive.copy(ALERT).multiplyScalar(amount * 0.6);
}

/** Une réserve de petites sphères qui montent et s'effacent : vapeur, fumée, flammes. */
function particles(v: Vignette, count: number, material: MeshBasicMaterial, radius: number) {
  const items = Array.from({ length: count }, () => {
    const m = new Mesh(new SphereGeometry(radius, 8, 6), material.clone());
    v.scene.add(m);
    return m;
  });
  return (t: number, origin: Vector3, opts: { period: number; rise: number; spread: number; on: boolean; color?: (f: number) => Color; grow?: number }) => {
    items.forEach((m, i) => {
      const f = phase(t, opts.period, i / count);
      m.visible = opts.on;
      const sway = Math.sin(i * 7.1 + t * 2) * opts.spread;
      m.position.set(origin.x + sway, origin.y + f * opts.rise, origin.z + Math.cos(i * 3.3) * opts.spread);
      m.scale.setScalar(opts.grow ? 1 + f * opts.grow : 1 - f * 0.8);
      const mat = m.material as MeshBasicMaterial;
      mat.opacity = (1 - f) * material.opacity;
      if (opts.color) mat.color.copy(opts.color(f));
    });
  };
}

type Script = (t: number) => void;

/** La maison du banquier lombard, comme sur le plateau (forme `counting-house`). */
function bank(v: Vignette) {
  return (g: Group, tint: Material[]) => {
    v.put(g, K('building_home_B_blue'), { x: -0.3 }, tint);
    for (const [x, z] of [[0.7, 0.5], [0.9, 0.1], [0.6, -0.3]] as const) v.put(g, K('sack'), { x, z, scale: 2.2 }, tint);
    v.put(g, K('crate_A_small'), { x: 0.5, z: 0.9, scale: 2 }, tint);
  };
}

/** La tour du serveur, posée au départ du chemin : c'est elle qui appelle le banquier. */
function caller(v: Vignette): { group: Group; tint: Material[] } {
  const group = new Group();
  const tint: Material[] = [];
  v.put(group, K('building_tower_A_blue'), { scale: 0.75 }, tint);
  const at = hexCenter({ q: -1, r: 0 });
  group.position.set(at.x - 0.1, 0, at.z + 0.75);
  v.scene.add(group);
  return { group, tint };
}

const glow = (tint: Material[], amount: number) => {
  for (const m of tint) if ('emissive' in m && m.emissive instanceof Color) m.emissive.copy(ALERT).multiplyScalar(amount * 0.6);
};

/**
 * La guérite du disjoncteur : une petite tour de garde et sa barrière, qui pivote pour
 * s'abaisser en travers de la route. `lift` 1 = levée, 0 = baissée.
 */
function guardHut(v: Vignette, x: number, z: number) {
  const group = new Group();
  v.put(group, K('building_tower_base_blue'), { scale: 0.32 });
  v.put(group, K('flag_blue'), { y: 0.38, scale: 0.55 });
  const post = new Mesh(new BoxGeometry(0.08, 0.36, 0.08), new MeshLambertMaterial({ color: '#f4f1de' }));
  post.position.set(0.32, 0.18, 0.25);
  const pivot = new Group();
  pivot.position.set(0.32, 0.33, 0.25);
  const arm = new Mesh(new BoxGeometry(0.06, 0.06, 0.95), new MeshLambertMaterial({ color: '#d62828' }));
  arm.position.z = 0.48;
  pivot.add(arm);
  group.add(post, pivot);
  group.position.set(x, 0, z);
  v.scene.add(group);
  return {
    group,
    /** 1 = levée, 0 = baissée en travers de la route. */
    lift(f: number) {
      pivot.rotation.x = -1.25 * Math.min(Math.max(f, 0), 1);
    },
  };
}

/** Des fondations et leur échafaudage, sur une case voisine : la place d'une instance à venir. */
function foundation(v: Vignette, x: number, z: number) {
  const group = new Group();
  v.put(group, K('building_tower_base_blue'), { scale: 0.45, y: -0.2 });
  const scaffold = new Group();
  for (const [fx, fz, r] of [[-0.45, 0, Math.PI / 2], [0.45, 0, Math.PI / 2], [0, -0.45, 0], [0, 0.45, 0]] as const) {
    v.put(scaffold, K('fence_wood_straight'), { x: fx, z: fz, rotate: r, scale: 0.6 });
  }
  v.put(scaffold, K('crate_A_small'), { x: 0.55, z: 0.55, scale: 1.8 });
  v.put(scaffold, K('sack'), { x: -0.55, z: 0.5, scale: 1.8 });
  const tower = new Group();
  v.put(tower, K('building_tower_A_blue'), { scale: 0.7 });
  group.add(scaffold, tower);
  group.position.set(x, 0, z);
  v.scene.add(group);
  return { group, scaffold, tower };
}

/**
 * Une pastille d'évolution au pied du bâtiment, avec son prix au survol. Tout-ou-rien, un
 * clic la bascule ; à niveaux, deux boutons − et + l'encadrent (`step` reçoit −1 ou +1).
 */
function pip(v: Vignette, x: number, y: number, z: number, icon: string, tip: string, leveled: boolean, step: (delta: number) => void): HTMLElement {
  const html = leveled
    ? `<button class="step" data-d="-1" title="Retirer un niveau">−</button><span class="icon">${icon}<b></b></span><button class="step" data-d="1" title="Ajouter un niveau">+</button><i>${tip}</i>`
    : `<span class="icon">${icon}<b></b></span><i>${tip}</i>`;
  const el = v.label(`pip${leveled ? ' leveled' : ''}`, html, x, y, z);
  el.addEventListener('click', (e) => {
    const d = (e.target as HTMLElement).closest('[data-d]')?.getAttribute('data-d');
    if (leveled && !d) return;
    step(Number(d ?? 1));
  });
  return el;
}

const price = (id: string, level: number) => {
  const u = catalog.upgrades[id]!;
  return level === 0 ? { cost: 0, cx: 0 } : { cost: u.cost.base + u.cost.perLevel * level, cx: u.complexity.base + u.complexity.perLevel * level };
};

interface Entry {
  title: string;
  chip: { text: string; kind: 'ok' | 'new' };
  text: string;
  trigger: string;
  river?: boolean;
  setup: (v: Vignette) => Script;
}

const ENTRIES: Entry[] = [
  {
    title: 'Saturation',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Les archives tremblent, rougissent franchement et fument. Aujourd’hui elles ne font que rougir, comme à 90 %.',
    trigger: '<code>utilization &gt; 1</code>',
    setup: (v) => {
      const site = v.site((g, tint) => {
        v.put(g, K('building_castle_blue'), { scale: 0.9 }, tint);
      });
      const walkers = Array.from({ length: 8 }, (_, i) => v.walker(i % 2 ? 'write' : 'read'));
      const steam = particles(v, 10, new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false }), 0.12);
      v.label('pop', 'charge 130 %', SITE.x - 1.2, site.top * 0.7, SITE.z);
      return (t) => {
        walkers.forEach((w, i) => {
          const f = phase(t, 2, i / walkers.length);
          if (f > 0.96) return w.hide();
          w.at(lerp(ROAD_START, DOOR, f), (i % 3 - 1) * 0.12, true, t);
        });
        site.group.position.set(SITE.x + Math.sin(t * 61) * 0.025, 0, SITE.z + Math.cos(t * 47) * 0.02);
        heat(site, 0.6 + 0.4 * Math.sin(t * 5) ** 2);
        steam(t, new Vector3(SITE.x, site.top - 0.2, SITE.z), { period: 1.6, rise: 1.1, spread: 0.35, on: true, grow: 1.5 });
      };
    },
  },
  {
    title: 'Requête refusée',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Le personnage se cogne à la porte, une croix éclate, il vire au rouge et repart. Aujourd’hui il change de couleur sans qu’on voie le refus.',
    trigger: '<code>failed</code> par nœud',
    setup: (v) => {
      const site = v.site(towers(v, 2));
      const pairs = [0, 0.5].map((offset, i) => ({ offset, ok: v.walker(i ? 'write' : 'read'), ko: v.walker(i ? 'write' : 'read', true) }));
      const crosses = pairs.map(() => v.label('pop', '✕', DOOR, 1.2, 0));
      return (t) => {
        let flash = 0;
        pairs.forEach(({ offset, ok, ko }, i) => {
          const p = phase(t, 3.2, offset);
          const cross = crosses[i]!;
          if (p < 0.45) {
            ko.hide();
            ok.at(lerp(ROAD_START, DOOR, p / 0.45), 0, true, t);
          } else {
            ok.hide();
            const bump = between(p, 0.45, 0.52);
            if (bump < 1) ko.at(DOOR - bump * 0.3, 0, true, t, false);
            else ko.at(lerp(DOOR - 0.3, ROAD_START, between(p, 0.52, 1)), 0, false, t);
          }
          const c = between(p, 0.45, 0.7);
          cross.style.opacity = c >= 0 && c <= 1 ? String(1 - c) : '0';
          cross.style.transform = `scale(${1 + Math.max(0, 0.6 - c * 2)})`;
          if (p > 0.45 && p < 0.55) flash = Math.max(flash, 1 - between(p, 0.45, 0.55));
        });
        heat(site, flash);
      };
    },
  },
  {
    title: 'Arriéré de file',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'La file s’allonge sur le chemin et les colis s’empilent dans l’enclos du relais. Un arriéré qui monte sans redescendre annonce les pertes.',
    trigger: '<code>backlog</code>',
    setup: (v) => {
      const site = v.site((g, tint, parts) => {
        v.put(g, K('building_tavern_blue'), { x: -0.8 }, tint);
        for (const z of [-0.5, 0.5]) v.put(g, K('fence_wood_straight'), { x: 1.1, z }, tint);
        for (let i = 0; i < 12; i++) parts.push(v.put(g, K(i % 3 === 0 ? 'sack' : 'crate_A_small'), { x: 0.1 + (i % 3) * 0.3, z: -0.6 + Math.floor(i / 3) * 0.4, scale: 2 }, tint));
      });
      const line = Array.from({ length: 8 }, (_, i) => v.walker(i % 2 ? 'async' : 'write'));
      const gauge = v.label('gauge', '<i></i>', SITE.x, site.top + 0.7, SITE.z);
      const STEP = 0.55;
      return (t) => {
        const p = t % (STEP * 9);
        const waiting = Math.min(7, Math.floor(p / STEP));
        line.forEach((w, i) => {
          const slot = DOOR - 0.15 - i * 0.45;
          if (i < waiting) w.at(slot, 0, true, t, false);
          else if (i === waiting && waiting < 7) w.at(lerp(ROAD_START, slot, (p % STEP) / STEP), 0, true, t);
          else w.hide();
        });
        site.parts.forEach((o, i) => (o.visible = i < waiting * 1.7));
        (gauge.firstElementChild as HTMLElement).style.width = `${(waiting / 7) * 100}%`;
      };
    },
  },
  {
    title: 'Appel trop lent',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Le client reste planté au comptoir du maître de métier, un sablier au-dessus de lui, et ceux de derrière attendent. C’est la leçon de la vague 1 du marché.',
    trigger: '<code>latencyMs</code> du nœud sur le chemin critique',
    setup: (v) => {
      v.site(towers(v, 1));
      const line = Array.from({ length: 4 }, () => v.walker('write'));
      const sand = v.label('hourglass', '⏳ 200 ms <span class="gauge"><i></i></span>', DOOR - 0.2, 1.5, 0);
      v.label('pop', 'p95 97 ms &gt; 60', -1.4, 1.2, 0);
      const PERIOD = 2.6;
      return (t) => {
        const p = phase(t, PERIOD);
        line.forEach((w, i) => {
          const slot = DOOR - i * 0.45;
          // Le premier entre enfin ; les autres avancent d'une place en même temps.
          if (p > 0.85) {
            const f = between(p, 0.85, 1);
            if (i === 0) w.at(lerp(DOOR, DOOR + 0.5, f), 0, true, t);
            else w.at(lerp(slot, slot + 0.45, f), 0, true, t);
          } else w.at(slot, 0, true, t, false);
        });
        (sand.querySelector('i') as HTMLElement).style.width = `${Math.min(1, p / 0.85) * 100}%`;
      };
    },
  },
  {
    title: 'Message livré deux fois',
    chip: { text: 'à ajouter au moteur', kind: 'new' },
    text: 'Le mage se dédouble en chemin et les deux copies entrent chez le trésorier : la commande est facturée deux fois. Avec l’idempotence, la copie s’effacerait au seuil.',
    trigger: 'compteur <code>duplicates</code> par nœud',
    setup: (v) => {
      const site = v.site(towers(v, 1));
      const a = v.walker('async');
      const b = v.walker('async');
      const ring = new Mesh(new RingGeometry(0.18, 0.26, 24).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: theme.vehicles.async.color, transparent: true, depthWrite: false }));
      v.scene.add(ring);
      const pop = v.label('pop', '×2 facturé', SITE.x, site.top + 0.8, SITE.z);
      return (t) => {
        const p = phase(t, 3.4);
        const x = lerp(ROAD_START, DOOR, p / 0.8);
        if (p < 0.82) a.at(x, 0.12, true, t);
        else a.hide();
        if (p > 0.3 && p < 0.82) b.at(x - 0.05, lerp(0.12, -0.25, between(p, 0.3, 0.36)), true, t);
        else b.hide();
        const r = between(p, 0.3, 0.42);
        ring.visible = r >= 0 && r <= 1;
        ring.position.set(lerp(ROAD_START, DOOR, 0.3 / 0.8), 0.08, -0.05);
        ring.scale.setScalar(1 + r * 2.5);
        (ring.material as MeshBasicMaterial).opacity = 1 - r;
        const f = between(p, 0.8, 0.98);
        heat(site, f >= 0 && f <= 1 ? 1 - f : 0);
        pop.style.opacity = f >= 0 && f <= 1 ? '1' : '0';
      };
    },
  },
  {
    title: 'Événement perdu',
    chip: { text: 'à ajouter au moteur', kind: 'new' },
    text: 'Le serveur tombe entre l’écriture et la publication : sur le pont, le messager s’évapore et sa lettre part au fil de l’eau. Avec l’outbox, elle resterait au coffre et repartirait.',
    trigger: 'compteur <code>lost</code> par nœud',
    river: true,
    setup: (v) => {
      v.site((g, tint) => {
        v.put(g, K('building_church_blue'), {}, tint);
        v.put(g, K('flag_blue'), { x: 0.9, z: 0.5, scale: 0.8 }, tint);
      });
      const w = v.walker('async');
      const letter = new Mesh(new BoxGeometry(0.2, 0.14, 0.03), new MeshLambertMaterial({ color: '#fbf6e9' }));
      letter.castShadow = true;
      v.scene.add(letter);
      const puff = particles(v, 8, new MeshBasicMaterial({ color: '#8d99a6', transparent: true, opacity: 0.7, depthWrite: false }), 0.14);
      const pop = v.label('pop', 'commande perdue', 0, 1.6, 0);
      // La rivière descend vers le sud-ouest (côté 4 de la case du pont).
      const downstream = new Vector3(-0.5, 0, 0.866);
      return (t) => {
        const p = phase(t, 3.6);
        const walk = between(p, 0, 0.42);
        if (walk <= 1) {
          w.at(lerp(ROAD_START, 0, walk), 0, true, t);
        } else {
          const vanish = between(p, 0.42, 0.5);
          if (vanish <= 1) {
            w.at(0, 0, true, t, false);
            w.root.scale.setScalar(1 - vanish);
          } else w.hide();
        }
        puff(t, new Vector3(0, 0.3, 0), { period: 0.5, rise: 0.5, spread: 0.2, on: p > 0.42 && p < 0.6, grow: 2 });
        if (p < 0.42) {
          letter.position.set(lerp(ROAD_START, 0, walk), 0.75 + Math.abs(Math.sin(t * 9)) * 0.06, 0);
          letter.rotation.set(0, 0, 0);
        } else {
          const fall = between(p, 0.42, 0.55);
          const drift = Math.max(0, between(p, 0.55, 1));
          const at = downstream.clone().multiplyScalar(drift * 1.6);
          letter.position.set(at.x, fall < 1 ? lerp(0.75, 0.02, fall) : 0.02 + Math.sin(t * 4) * 0.015, at.z);
          letter.rotation.set(-Math.PI / 2 + Math.sin(t * 3) * 0.2, t * 1.5, 0);
        }
        letter.visible = p < 0.95;
        pop.style.opacity = p > 0.45 && p < 0.9 ? '1' : '0';
      };
    },
  },
  {
    title: 'Panne d’instance',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Une tour prend feu et noircit ; le trafic continue vers les deux autres. Aujourd’hui on n’a que l’étiquette « en panne ».',
    trigger: '<code>down</code> et <code>instances</code>',
    setup: (v) => {
      const site = v.site(towers(v, 3));
      const burning = site.parts[1]!;
      const own = burning.userData.materials as Material[];
      const original = own.map((m) => ('color' in m && m.color instanceof Color ? m.color.clone() : new Color()));
      const charred = new Color('#3b302b');
      const flames = particles(v, 26, new MeshBasicMaterial({ color: '#ffb703', transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending }), 0.16);
      const smoke = particles(v, 10, new MeshBasicMaterial({ color: '#4a4e55', transparent: true, opacity: 0.55, depthWrite: false }), 0.16);
      const glow = new PointLight('#ff7b00', 0, 4);
      v.scene.add(glow);
      const walkers = Array.from({ length: 4 }, (_, i) => v.walker(i % 2 ? 'write' : 'read'));
      const pop = v.label('pop', '🔥 1 instance en panne', -1.2, 1.4, 0);
      const fireColor = (f: number) => new Color('#ffd166').lerp(new Color('#e63900'), f);
      return (t) => {
        const p = phase(t, 6);
        const on = p > 0.12 && p < 0.92;
        const burnt = on ? Math.min(1, between(p, 0.12, 0.25)) : 0;
        own.forEach((m, i) => {
          if ('color' in m && m.color instanceof Color) m.color.copy(original[i]!).lerp(charred, burnt * 0.8);
        });
        const top = new Vector3().setFromMatrixPosition(burning.matrixWorld);
        flames(t, top.clone().setY(site.top * 0.75), { period: 0.8, rise: 1, spread: 0.24, on, color: fireColor });
        smoke(t, top.clone().setY(site.top), { period: 2.2, rise: 1.6, spread: 0.25, on, grow: 2 });
        glow.position.copy(top).setY(site.top * 0.8);
        glow.intensity = on ? 3 + Math.sin(t * 23) * 0.8 + Math.sin(t * 37) : 0;
        walkers.forEach((w, i) => {
          const f = phase(t, 2.2, i / walkers.length);
          if (f > 0.96) return w.hide();
          w.at(lerp(ROAD_START, DOOR, f), i % 2 ? 0.35 : -0.35, true, t);
        });
        pop.style.opacity = on ? '1' : '0';
      };
    },
  },
  {
    title: 'Pillards repoussés',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Le squelette s’écrase sur le bouclier de la garde, qui s’allume, et culbute en arrière ; le client légitime passe. On voit enfin ce que fait le rate limiting.',
    trigger: '<code>shed</code>',
    setup: (v) => {
      v.site((g, tint) => {
        v.put(g, K('wall_straight_gate'), { rotate: Math.PI / 2 }, tint);
        for (const z of [-1.3, 1.3]) v.put(g, K('building_tower_base_blue'), { z }, tint);
        v.put(g, K('flag_blue'), { y: 1.4, scale: 2.5 }, tint);
        v.put(g, K('building_barracks_blue'), { x: 1.1, z: 0, rotate: Math.PI, scale: 0.7 }, tint);
      });
      const shield = new Mesh(
        new SphereGeometry(1.05, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new MeshBasicMaterial({ color: '#2a9d8f', transparent: true, opacity: 0.15, depthWrite: false }),
      );
      shield.position.set(SITE.x - 0.1, 0, SITE.z);
      v.scene.add(shield);
      const raider = v.walker('hostile');
      const guest = v.walker('read');
      const pop = v.label('pop shield', '🛡 repoussé', 0.4, 1.5, 0);
      const HIT = SITE.x - 1.15;
      return (t) => {
        const p = phase(t, 3);
        if (p < 0.4) raider.at(lerp(ROAD_START, HIT, p / 0.4), 0.15, true, t);
        else if (p < 0.72) {
          const f = between(p, 0.4, 0.72);
          raider.at(lerp(HIT, HIT - 1.4, f), 0.15, true, t, false);
          raider.root.position.y = 0.06 + Math.sin(f * Math.PI) * 0.5;
          raider.root.rotation.x = -f * Math.PI * 2;
        } else raider.at(lerp(HIT - 1.4, ROAD_START, between(p, 0.72, 1)), 0.15, false, t);
        const g = phase(t, 3, 0.45);
        if (g < 0.9) guest.at(lerp(ROAD_START, SITE.x, g / 0.9), -0.15, true, t);
        else guest.hide();
        const hit = between(p, 0.4, 0.6);
        (shield.material as MeshBasicMaterial).opacity = hit >= 0 && hit <= 1 ? 0.15 + (1 - hit) * 0.4 : 0.15;
        pop.style.opacity = hit >= 0 && hit <= 1.5 ? '1' : '0';
      };
    },
  },
  {
    title: 'Cascade de pannes',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Le banquier traîne : chaque paiement retient un scribe, les mages s’entassent devant sa porte. Plus un scribe libre, la tour rougit et refoule même ceux qui venaient seulement consulter.',
    trigger: '<code>threads</code> &gt; 1 et <code>waitingOn</code> du serveur',
    setup: (v) => {
      v.site(bank(v));
      const server = caller(v);
      const line = Array.from({ length: 5 }, () => v.walker('async'));
      const pairs = [0, 0.5].map((offset) => ({ offset, ok: v.walker('read'), ko: v.walker('read', true) }));
      v.label('hourglass', '⏳ 4 000 ms', SITE.x, 1.6, SITE.z);
      v.label('pop', '🧵 fils occupés 125 %', server.group.position.x, 1.4, server.group.position.z);
      const start = ROAD_START - 0.3;
      const door = server.group.position.x - 0.35;
      return (t) => {
        line.forEach((w, k) => w.at(DOOR - k * 0.42, 0, true, t, false));
        server.group.position.y = 0;
        server.group.rotation.z = Math.sin(t * 50) * 0.01;
        glow(server.tint, 0.65 + 0.35 * Math.sin(t * 5) ** 2);
        for (const { offset, ok, ko } of pairs) {
          const p = phase(t, 2.4, offset);
          if (p < 0.4) {
            ko.hide();
            ok.at(lerp(start, door, p / 0.4), 0.35, true, t);
          } else {
            ok.hide();
            ko.at(lerp(door, start, between(p, 0.4, 1)), 0.35, false, t);
          }
        }
      };
    },
  },
  {
    title: 'Circuit coupé',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Le disjoncteur abaisse une barrière sur la route du banquier : les paiements sont refusés tout de suite, sans retenir de scribe. La tour reste libre pour tous les autres.',
    trigger: '<code>open</code> du serveur, incident <code>slow-dependency</code> ou <code>dependency-down</code>',
    setup: (v) => {
      v.site(bank(v));
      const server = caller(v);
      const fx = new Effects(v.scene);
      const mages = [0, 0.33, 0.66].map((offset) => ({ offset, ok: v.walker('async'), ko: v.walker('async', true) }));
      const cross = v.label('pop', '✕', -0.6, 1.1, 0);
      v.label('pop shield', '🔌 circuit coupé', -0.2, 1.7, 0);
      v.label('hourglass', '⏳ 4 000 ms', SITE.x, 1.6, SITE.z);
      const from = server.group.position.x + 0.4;
      const bar = -0.45;
      return (t) => {
        fx.begin(t);
        fx.barrier(new Vector3(bar, 0.05, 0), Math.PI / 2);
        fx.end();
        glow(server.tint, 0);
        let hit = 0;
        for (const { offset, ok, ko } of mages) {
          const p = phase(t, 2.2, offset);
          if (p < 0.45) {
            ko.hide();
            ok.at(lerp(from, bar - 0.25, p / 0.45), 0, true, t);
          } else {
            ok.hide();
            const back = between(p, 0.45, 1);
            ko.at(lerp(bar - 0.3, from, back), 0, false, t);
            if (back < 0.25) hit = Math.max(hit, 1 - back * 4);
          }
        }
        cross.style.opacity = String(hit);
      };
    },
  },
  {
    title: 'Tempête de relances',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Refoulés, les voyageurs font demi-tour aussitôt, et chaque tour en ramène davantage : la foule grossit devant des tours pourtant relevées. La poussière monte des hameaux, le compteur de relances s’emballe.',
    trigger: '<code>retries</code> du tick &gt; la moitié du trafic neuf',
    setup: (v) => {
      const site = v.site(towers(v, 2));
      const fx = new Effects(v.scene);
      const crowd = Array.from({ length: 9 }, (_, i) => ({ i, go: v.walker(i % 3 ? 'read' : 'write'), back: v.walker('read', true) }));
      const counter = v.label('pop', '↻ 0 relances/s', ROAD_START + 0.3, 1.2, 0);
      return (t) => {
        const p = phase(t, 6);
        // Le nombre de voyageurs en jeu double à chaque aller-retour : c'est la tempête.
        const active = Math.min(crowd.length, Math.ceil(2 ** (p * 4)));
        heat(site, Math.min(1, p * 1.5) * 0.6);
        fx.begin(t);
        if (p > 0.3) fx.puff(new Vector3(ROAD_START, 0.6, 0));
        fx.end();
        counter.textContent = `↻ ${Math.round(active * 550).toLocaleString('fr-FR')} relances/s`;
        for (const { i, go, back } of crowd) {
          if (i >= active) {
            go.hide();
            back.hide();
            continue;
          }
          const f = phase(t, 1.2, i / crowd.length);
          const lane = ((i % 3) - 1) * 0.25;
          if (f < 0.55) {
            back.hide();
            go.at(lerp(ROAD_START, DOOR, f / 0.55), lane, true, t);
          } else {
            go.hide();
            back.at(lerp(DOOR, ROAD_START, between(f, 0.55, 1)), lane, false, t);
          }
        }
      };
    },
  },
  {
    title: 'Partition réseau',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Une barrière coupe les archives de leurs copistes. Les messagers qui demandent les places restantes à un copiste repartent avec une réponse périmée, en rouge ; ceux qui vont au grand registre ont la bonne.',
    trigger: '<code>partitioned</code> et <code>stale</code> de la base',
    setup: (v) => {
      v.site((g, tint) => {
        v.put(g, K('building_castle_blue'), { scale: 0.9 }, tint);
        for (const x of [-1.0, 0.2]) v.put(g, K('building_tower_base_blue'), { x, z: 1.3, scale: 0.6 }, tint);
      });
      const fx = new Effects(v.scene);
      const readers = [0, 0.25, 0.5, 0.75].map((offset, i) => ({ offset, stale: i % 2 === 0, go: v.walker('read'), back: v.walker('read', i % 2 === 0) }));
      v.label('pop', '✂ réplicas coupés du primaire', SITE.x, 1.9, SITE.z);
      const wrong = v.label('pop', '≠ périmée', -0.4, 1.0, 0.6);
      return (t) => {
        fx.begin(t);
        fx.barrier(new Vector3(SITE.x, 0.05, SITE.z + 0.75), 0);
        fx.end();
        let shown = 0;
        for (const { offset, stale, go, back } of readers) {
          const f = phase(t, 2.6, offset);
          const lane = stale ? 0.55 : -0.35;
          if (f < 0.5) {
            back.hide();
            go.at(lerp(ROAD_START, DOOR, f / 0.5), lane, true, t);
          } else {
            go.hide();
            back.at(lerp(DOOR, ROAD_START, between(f, 0.5, 1)), lane, false, t);
            if (stale) shown = Math.max(shown, 1 - between(f, 0.5, 1));
          }
        }
        wrong.style.opacity = String(shown);
      };
    },
  },
  {
    title: 'Message empoisonné',
    chip: { text: 'signal existant', kind: 'ok' },
    text: 'Un mage porte un bon mal écrit : le maître de métier s’effondre dessus dans une vapeur verte, et le mage revient au relais, encore et encore, pendant que les autres attendent derrière lui. Au troisième essai, le bon part sur la pile des lettres mortes, et la file repart.',
    trigger: '<code>poisoned</code> du consommateur, <code>deadLettered</code> et <code>deadLetters</code> de la file, incident <code>poison-message</code>',
    setup: (v) => {
      v.site(towers(v, 1));
      const fx = new Effects(v.scene);
      const bad = v.walker('async', true);
      const line = Array.from({ length: 3 }, () => v.walker('async'));
      const crashed = v.label('pop', '☠ rendu à la file', SITE.x, 1.6, SITE.z);
      const pile = v.label('pop', '📭 lettres mortes', ROAD_START + 0.2, 1.1, 0.6);
      const ATTEMPTS = 3;
      return (t) => {
        const p = phase(t, 8);
        // Trois allers-retours du message empoisonné, puis la file repart.
        const tries = p * (ATTEMPTS + 1);
        const attempt = Math.floor(tries);
        const f = tries - attempt;
        const blocked = attempt < ATTEMPTS;
        fx.begin(t);
        if (blocked && f > 0.45 && f < 0.75) fx.poison(new Vector3(SITE.x, 0.9, SITE.z));
        fx.deadLetters(new Vector3(ROAD_START + 0.2, 0.05, 0.6), blocked ? 0 : 3, !blocked && f < 0.4);
        fx.end();
        if (blocked) {
          bad.at(f < 0.5 ? lerp(ROAD_START, DOOR, f / 0.5) : lerp(DOOR, ROAD_START, between(f, 0.5, 1)), 0, f < 0.5, t, true);
          line.forEach((w, i) => w.at(ROAD_START - 0.3 - i * 0.4, 0.3, true, t, false));
        } else {
          bad.hide();
          line.forEach((w, i) => w.at(lerp(ROAD_START - 0.3 - i * 0.4, DOOR, Math.min(1, f * 1.5)), 0.3, true, t));
        }
        crashed.style.opacity = blocked && f > 0.45 && f < 0.8 ? '1' : '0';
        pile.style.opacity = blocked ? '0' : '1';
      };
    },
  },
  {
    title: 'Pastilles d’évolution',
    chip: { text: 'branché', kind: 'ok' },
    text: 'Au pied de la tour, une pastille par évolution. Le scaling et l’autoscaling ont leurs boutons − et + ; le circuit breaker se bascule d’un clic. Chaque achat prend corps : une tour de plus, des fondations sur la case voisine (une par instance à la demande), une guérite et sa barrière sur la route. Le prix au survol, la facture au-dessus.',
    trigger: 'clic sur − / + ou sur la pastille ; la fiche reste pour le détail',
    setup: (v) => {
      const site = v.site(towers(v, 3));
      const spot = hexCenter({ q: 0, r: 1 });
      const slots = [-0.55, 0, 0.55].map((dx, i) => {
        const f = foundation(v, spot.x + dx, spot.z + (i === 1 ? -0.35 : 0.2));
        f.group.scale.setScalar(0.55);
        f.tower.visible = false;
        return f;
      });
      const hut = guardHut(v, 0.0, 0.55);
      const state = { scaling: 0, autoscaling: 0, breaker: 0 };
      const max = { scaling: 2, autoscaling: 3, breaker: 1 };
      const ids = { scaling: 'horizontal-scaling', autoscaling: 'autoscaling', breaker: 'circuit-breaker' };
      const tip = (k: keyof typeof state) => {
        const u = catalog.upgrades[ids[k]]!;
        const unit = price(ids[k], 1);
        const per = u.cost.perLevel > 0 ? `${u.cost.perLevel} écus par niveau` : `${unit.cost} écus`;
        return `<em>${u.techName}</em>${u.label}<br>${per} · +${unit.cx} complexité`;
      };
      // En colonne au pied de la tour, côté caméra : tout reste dans l'hexagone.
      const foot = { x: SITE.x - 0.15, z: SITE.z + 0.7 };
      const pips = (['scaling', 'autoscaling', 'breaker'] as const).map((k, i) => {
        const el = pip(v, foot.x, 0.1 + (2 - i) * 0.55, foot.z, { scaling: '🗼', autoscaling: '🏗', breaker: '🔌' }[k], tip(k), max[k] > 1, (d) => {
          state[k] = max[k] === 1 ? 1 - state[k] : Math.min(max[k], Math.max(0, state[k] + d));
        });
        return { k, el };
      });
      const bill = v.label('pop info', '', SITE.x - 1.6, 2.1, SITE.z - 0.8);
      return () => {
        site.parts.forEach((p, i) => (p.visible = i <= state.scaling));
        slots.forEach((s, i) => (s.group.visible = i < state.autoscaling));
        hut.group.visible = state.breaker > 0;
        hut.lift(1);
        let cost = 0;
        let cx = 0;
        for (const { k, el } of pips) {
          const level = state[k];
          el.classList.toggle('on', level > 0);
          el.querySelector('b')!.textContent = level > 0 && max[k] > 1 ? (k === 'autoscaling' ? `≤${level}` : `+${level}`) : '';
          el.querySelectorAll<HTMLButtonElement>('[data-d]').forEach((b) => (b.disabled = b.dataset.d === '-1' ? level === 0 : level === max[k]));
          const p = price(ids[k], level);
          cost += p.cost;
          cx += p.cx;
        }
        bill.textContent = cost > 0 ? `évolutions : ${cost} écus · +${cx} complexité` : 'aucune évolution';
      };
    },
  },
  {
    title: 'Autoscaling en chantier',
    chip: { text: 'branché', kind: 'ok' },
    text: 'L’autoscaling réserve des fondations sur la case voisine. Quand la charge monte, un échafaudage se dresse et une tour pousse en deux minutes ; pendant ce temps, des voyageurs repartent refoulés. Une fois en service, la tour soulage les autres ; la foule partie, elle est rendue. On voit enfin le délai de démarrage.',
    trigger: '<code>autoscaling</code> du serveur, <code>instances</code> du tick et délai de démarrage',
    setup: (v) => {
      const site = v.site(towers(v, 2));
      const spot = hexCenter({ q: 0, r: 1 });
      const slot = foundation(v, spot.x, spot.z);
      const stage = v.label('pop info', '', spot.x, 1.7, spot.z);
      const load = v.label('pop', '', SITE.x, 2.0, SITE.z);
      const crowd = Array.from({ length: 4 }, (_, i) => ({ i, go: v.walker(i % 2 ? 'write' : 'read'), back: v.walker('read', true) }));
      return (t) => {
        const p = phase(t, 10);
        const rising = between(p, 0.15, 0.3);
        const building = between(p, 0.32, 0.56);
        const busy = p > 0.15 && p < 0.85;
        const starting = p >= 0.32 && p < 0.56;
        const serving = p >= 0.56 && p < 0.85;
        heat(site, busy ? (serving ? 0.15 : Math.min(1, rising) * 0.8) : 0);
        load.style.opacity = busy ? '1' : '0';
        load.textContent = serving ? 'charge 80 %' : 'charge 125 %';
        load.classList.toggle('info', serving);
        slot.scaffold.visible = starting || (p >= 0.3 && p < 0.32);
        slot.tower.visible = p >= 0.32 && p < 0.95;
        const grow = starting ? building : p >= 0.56 && p < 0.85 ? 1 : p >= 0.85 ? 1 - between(p, 0.85, 0.95) : 0;
        slot.tower.scale.set(1, Math.max(0.02, grow), 1);
        stage.style.opacity = p >= 0.3 && p < 0.95 ? '1' : '0';
        stage.textContent = starting ? `🏗 démarrage ${building < 0.5 ? 1 : 2}/2 minutes` : serving ? '✔ en service' : '↘ instance rendue';
        for (const { i, go, back } of crowd) {
          const f = phase(t, 1.6, i / crowd.length);
          const lane = ((i % 2) - 0.5) * 0.4;
          // Tant que la tour n'est pas prête, la moitié des voyageurs repart refoulée.
          const refused = busy && !serving && i % 2 === 0;
          if (f < 0.55 || !refused) {
            back.hide();
            if (f < 0.55) go.at(lerp(ROAD_START, DOOR, f / 0.55), lane, true, t);
            else go.hide();
          } else {
            go.hide();
            back.at(lerp(DOOR, ROAD_START, between(f, 0.55, 1)), lane, false, t);
          }
        }
      };
    },
  },
  {
    title: 'Guérite du disjoncteur',
    chip: { text: 'branché', kind: 'ok' },
    text: 'Le circuit breaker devient une guérite sur la route du banquier, barrière levée. Le banquier traîne : la barrière tombe, les appels sont refusés sur-le-champ. Un peu plus tard, elle se lève à moitié pour un appel d’essai (demi-ouvert) ; il passe, la route rouvre.',
    trigger: '<code>open</code> du serveur ; l’état demi-ouvert serait à ajouter au moteur',
    setup: (v) => {
      v.site(bank(v));
      const server = caller(v);
      const hut = guardHut(v, -0.15, -0.7);
      const state = v.label('pop info', '', -0.1, 1.5, -0.5);
      const slow = v.label('hourglass', '⏳ 4 000 ms', SITE.x, 1.6, SITE.z);
      const mages = [0, 0.33, 0.66].map((offset) => ({ offset, ok: v.walker('async'), ko: v.walker('async', true) }));
      const from = server.group.position.x + 0.4;
      const bar = -0.1;
      return (t) => {
        const p = phase(t, 9);
        const open = p >= 0.38 && p < 0.72;
        const half = p >= 0.72 && p < 0.84;
        hut.lift(p < 0.35 ? 1 : p < 0.4 ? 1 - between(p, 0.35, 0.4) : open ? 0 : half ? 0.45 : between(p, 0.84, 0.9));
        slow.style.opacity = p >= 0.33 && p < 0.72 ? '1' : '0';
        state.textContent = open ? '🔌 ouvert : refus immédiat' : half ? '◐ demi-ouvert : un appel d’essai' : '● fermé : tout passe';
        state.classList.toggle('shield', !open);
        for (const { offset, ok, ko } of mages) {
          const f = phase(t, 2.2, offset);
          const z = 0.15;
          if (open) {
            if (f < 0.45) {
              ko.hide();
              ok.at(lerp(from, bar - 0.25, f / 0.45), z, true, t);
            } else {
              ok.hide();
              ko.at(lerp(bar - 0.3, from, between(f, 0.45, 1)), z, false, t);
            }
          } else if (half && offset > 0) {
            ok.hide();
            ko.hide();
          } else {
            ko.hide();
            ok.at(lerp(from, DOOR, f), z, true, t);
          }
        }
      };
    },
  },
  {
    title: 'Verrou de recalcul',
    chip: { text: 'maquette', kind: 'new' },
    text: 'Un cadenas sur le carnet. Pendant une ruée, un seul messager court aux archives chercher la page perdue ; les autres attendent en file devant le carnet, puis repartent tous servis. Sans verrou, ils courraient tous aux archives.',
    trigger: '<code>request-coalescing</code> du cache, incident <code>cache-stampede</code>',
    setup: (v) => {
      v.site((g, tint) => {
        v.put(g, K('building_market_blue'), { scale: 0.9 }, tint);
        v.put(g, K('sack'), { x: 0.9, z: 0.5, scale: 2 }, tint);
      });
      const archive = hexCenter({ q: 0, r: 1 });
      const keep = new Group();
      v.put(keep, K('building_castle_blue'), { scale: 0.55 });
      keep.position.set(archive.x, 0, archive.z);
      v.scene.add(keep);
      v.label('pip on', '<span class="icon">🔒<b></b></span>', SITE.x + 0.5, 1.5, SITE.z);
      const wait = v.label('hourglass', '⏳ 4 attendent la même page', SITE.x - 1.2, 1.2, SITE.z + 0.4);
      const runner = v.walker('read');
      const queue = Array.from({ length: 4 }, (_, i) => v.walker(i % 2 ? 'read' : 'write'));
      const door = { x: DOOR - 0.2, z: 0 };
      return (t) => {
        const p = phase(t, 7);
        // Le premier arrivé va aux archives et revient ; la file l'attend, puis repart servie.
        const there = between(p, 0.15, 0.4);
        const back = between(p, 0.45, 0.7);
        if (p < 0.15) runner.at(lerp(ROAD_START, door.x, p / 0.15), door.z, true, t);
        else if (p < 0.4) runner.at(lerp(door.x, archive.x, there), lerp(door.z, archive.z - 0.5, there), false, t);
        else if (p < 0.45) runner.at(archive.x, archive.z - 0.5, false, t, false);
        else if (p < 0.7) runner.at(lerp(archive.x, door.x, back), lerp(archive.z - 0.5, door.z, back), true, t);
        else runner.at(lerp(door.x, ROAD_START, between(p, 0.7, 1)), door.z, false, t);
        wait.style.opacity = p >= 0.15 && p < 0.7 ? '1' : '0';
        queue.forEach((w, i) => {
          const spot = door.x - 0.45 * (i + 1);
          if (p < 0.15) w.at(lerp(ROAD_START - 0.5 * i, spot, p / 0.15), 0.2, true, t);
          else if (p < 0.7) w.at(spot, 0.2, true, t, false);
          else w.at(lerp(spot, ROAD_START - 0.5, between(p, 0.7, 1)), 0.2, false, t);
        });
      };
    },
  },
  {
    title: 'SLA franchi',
    chip: { text: 'dérivé des ticks', kind: 'ok' },
    text: 'Quand le taux d’échec cumulé passe le seuil, la cloche sonne, les bords de l’écran rougissent et une bannière tombe : c’est l’instant où la vague est perdue.',
    trigger: 'taux d’échec cumulé, déjà calculé pour la courbe',
    setup: (v) => {
      const site = v.site(towers(v, 2));
      const failed = Array.from({ length: 4 }, () => v.walker('read', true));
      const arriving = Array.from({ length: 3 }, (_, i) => v.walker(i % 2 ? 'write' : 'read'));
      const overlay = document.createElement('div');
      overlay.className = 'sla';
      overlay.innerHTML = '<div class="vig"></div><div class="bar"><i></i><b></b><span>SLA 1 %</span></div><div class="banner">SLA rompu</div><div class="bell">🔔</div>';
      v.host.appendChild(overlay);
      const [vig, bar, banner, bell] = ['.vig', '.bar i', '.banner', '.bell'].map((s) => overlay.querySelector(s) as HTMLElement);
      return (t) => {
        const p = phase(t, 5);
        const fill = Math.min(0.8, (p / 0.7) * 0.8);
        const broken = fill >= 0.4 && p < 0.95;
        bar!.style.width = `${fill * 100}%`;
        bar!.style.background = broken ? '#d62828' : '#6a994e';
        const since = (p - 0.35) * 5;
        vig!.style.opacity = broken ? String(0.55 + 0.35 * Math.sin(t * 6)) : '0';
        banner!.style.transform = `translate(-50%, ${broken ? 0 : -60}px)`;
        banner!.style.transition = 'transform .35s ease-out';
        bell!.style.opacity = broken ? '1' : '0';
        bell!.style.transform = `rotate(${broken ? Math.sin(t * 14) * 25 * Math.max(0.2, 1 - since / 3) : 0}deg)`;
        heat(site, broken ? 0.5 : 0);
        failed.forEach((w, i) => {
          const f = phase(t, 2, i / failed.length);
          if (f > 0.95) return w.hide();
          w.at(lerp(DOOR, ROAD_START, f), 0.2, false, t);
        });
        arriving.forEach((w, i) => {
          const f = phase(t, 2, i / arriving.length + 0.15);
          if (f > 0.95) return w.hide();
          w.at(lerp(ROAD_START, DOOR, f), -0.2, true, t);
        });
      };
    },
  },
];

async function main(): Promise<void> {
  const grid = document.getElementById('grid')!;
  const lib = await ModelLibrary.load([...MODELS, ...CHARACTERS], import.meta.env.BASE_URL);
  const cast = new Cast(lib);
  const running = ENTRIES.map((entry) => {
    const tile = document.createElement('article');
    tile.className = 'tile';
    tile.innerHTML = `<div class="view"></div><div class="sheet"><h2>${entry.title} <span class="chip ${entry.chip.kind}">${entry.chip.text}</span></h2><p>${entry.text}</p><p><b>Déclencheur :</b> ${entry.trigger}</p></div>`;
    grid.appendChild(tile);
    const v = new Vignette(tile.querySelector('.view') as HTMLElement, lib, cast, entry.river);
    return { v, script: entry.setup(v) };
  });
  window.addEventListener('resize', () => running.forEach(({ v }) => v.fit()));
  const start = performance.now();
  const frame = (now: number) => {
    const t = (now - start) / 1000;
    for (const { v, script } of running) {
      script(t);
      v.render();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
