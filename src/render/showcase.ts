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
  'fence_wood_straight', 'crate_A_small', 'sack', 'building_church_blue', 'flag_blue', 'wall_straight_gate', 'building_barracks_blue', 'building_home_B_blue',
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

class Vignette {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  private readonly renderer = new WebGLRenderer({ antialias: true });
  private readonly labels = new CSS2DRenderer();

  readonly host: HTMLElement;
  readonly lib: ModelLibrary;
  readonly cast: Cast;

  constructor(host: HTMLElement, lib: ModelLibrary, cast: Cast, river = false) {
    this.host = host;
    this.lib = lib;
    this.cast = cast;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
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
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    const aspect = w / Math.max(h, 1);
    const half = 2.15;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
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
