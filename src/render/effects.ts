import {
  AdditiveBlending,
  Group,
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
  type Scene,
} from 'three';

/**
 * Effets des incidents sur le plateau : vapeur, fumée, flammes, lettres perdues, boucliers,
 * vapeur du poison, pile des lettres mortes.
 * Sans état : chaque image, la scène redemande les effets du tick affiché, et la position de
 * chaque particule ne dépend que de l'heure et de sa place dans la boucle. Revenir en arrière
 * dans le rejeu ne laisse donc rien traîner.
 */

const MAX_MIST = 600;
const MAX_FIRE = 400;
const MAX_LETTERS = 60;

const STEAM = new Color('#ffffff');
const SMOKE = new Color('#4a4e55');
const PUFF = new Color('#8d99a6');
const FLAME_HOT = new Color('#ffd166');
const FLAME_COOL = new Color('#e63900');
const BLACK = new Color('#000000');
const POISON = new Color('#7bc043');
const POISON_DARK = new Color('#2d6a1f');
/** Lettres mortes : un papier jauni, cerné de deuil. */
const DEAD_LETTER = new Color('#8a8172');

interface Pool {
  mesh: InstancedMesh;
  used: number;
}

const phase = (t: number, period: number, offset: number) => (((t / period + offset) % 1) + 1) % 1;
/** Graine stable par point d'émission : deux bâtiments voisins ne fument pas en cadence. */
const seedOf = (p: Vector3) => Math.abs(Math.sin(p.x * 12.9898 + p.z * 78.233) * 43758.5453) % 1;

export class Effects {
  private readonly scene: Scene;
  private readonly mist: Pool;
  private readonly fire: Pool;
  private readonly letters: Pool;
  private readonly shields: Mesh[] = [];
  private shieldsUsed = 0;
  private readonly barriers: Group[] = [];
  private barriersUsed = 0;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  /** Heure courante, en secondes : les effets tournent même quand le rejeu est en pause. */
  now = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.mist = this.pool(new SphereGeometry(0.13, 8, 6), new MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false }), MAX_MIST);
    this.fire = this.pool(
      new SphereGeometry(0.15, 8, 6),
      new MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending }),
      MAX_FIRE,
    );
    this.letters = this.pool(new BoxGeometry(0.2, 0.14, 0.03), new MeshLambertMaterial({ color: '#fbf6e9' }), MAX_LETTERS);
    this.letters.mesh.castShadow = true;
  }

  begin(now: number): void {
    this.now = now;
    for (const p of [this.mist, this.fire, this.letters]) p.used = 0;
    this.shieldsUsed = 0;
    this.barriersUsed = 0;
  }

  end(): void {
    for (const p of [this.mist, this.fire, this.letters]) {
      p.mesh.count = p.used;
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
    this.shields.forEach((s, i) => (s.visible = i < this.shieldsUsed));
    this.barriers.forEach((b, i) => (b.visible = i < this.barriersUsed));
  }

  /**
   * Barrière rouge et blanche en travers du chemin : le circuit breaker a coupé cette route.
   * `angle` est la direction du chemin ; la barrière se pose perpendiculaire, et s'abaisse
   * en oscillant un peu, comme une barrière qu'on vient de fermer.
   */
  barrier(at: Vector3, angle: number): void {
    let b = this.barriers[this.barriersUsed];
    if (!b) {
      b = new Group();
      const red = new MeshLambertMaterial({ color: '#d62828' });
      const white = new MeshLambertMaterial({ color: '#f4f1de' });
      const post = new BoxGeometry(0.08, 0.42, 0.08);
      // Le chemin suit l'axe z local : les poteaux et la lisse sont de part et d'autre, en x.
      for (const x of [-0.42, 0.42]) {
        const p = new Mesh(post, white);
        p.position.set(x, 0.21, 0);
        b.add(p);
      }
      // La lisse, en bandes alternées.
      for (let i = 0; i < 6; i++) {
        const band = new Mesh(new BoxGeometry(0.15, 0.07, 0.06), i % 2 ? white : red);
        band.position.set(-0.375 + i * 0.15, 0.36, 0);
        band.castShadow = true;
        b.add(band);
      }
      this.barriers.push(b);
      this.scene.add(b);
    }
    this.barriersUsed++;
    b.position.copy(at);
    // Plus grande qu'à l'échelle : elle doit se voir de loin, entre les personnages.
    b.scale.setScalar(1.5);
    b.rotation.set(Math.sin(this.now * 3) * 0.04, angle, 0);
  }

  /** Vapeur blanche d'un bâtiment saturé. */
  steam(at: Vector3): void {
    this.rise(this.mist, at, 8, { period: 1.6, rise: 1.1, spread: 0.35, grow: 1.5 }, () => STEAM);
  }

  /** Fumée sombre d'une tour en feu. */
  smoke(at: Vector3): void {
    this.rise(this.mist, at, 8, { period: 2.2, rise: 1.6, spread: 0.25, grow: 2 }, () => SMOKE);
  }

  /** Flammes : du jaune au rouge, puis elles s'éteignent en montant. */
  flames(at: Vector3): void {
    this.rise(this.fire, at, 14, { period: 0.8, rise: 1, spread: 0.24, grow: -0.8 }, (f) =>
      this.color.copy(FLAME_HOT).lerp(FLAME_COOL, f).lerp(BLACK, Math.max(0, f - 0.6) * 2.5),
    );
  }

  /** Petit nuage ; teinté, il signale un doublon. */
  puff(at: Vector3, tint: Color = PUFF): void {
    this.rise(this.mist, at, 6, { period: 0.9, rise: 0.5, spread: 0.25, grow: 2 }, () => tint);
  }

  /**
   * Vapeur verte qui s'échappe d'un consommateur : il vient de planter sur un message
   * empoisonné (S25). Plus courte et plus saccadée que la vapeur d'une saturation.
   */
  poison(at: Vector3): void {
    this.rise(this.mist, at, 7, { period: 1.1, rise: 0.8, spread: 0.3, grow: 1.2 }, (f) => this.color.copy(POISON).lerp(POISON_DARK, f));
  }

  /**
   * La pile des lettres mortes, au pied d'une file : des lettres posées à plat, d'autant plus
   * haute que la file des lettres mortes est grosse (`count`, à l'échelle logarithmique). Une
   * lettre qui vient d'y tomber (`fresh`) descend du toit sur la pile.
   */
  deadLetters(at: Vector3, count: number, fresh: boolean): void {
    const height = Math.min(8, Math.ceil(Math.log10(1 + count) * 3));
    const seed = seedOf(at);
    for (let i = 0; i < height && this.letters.used < MAX_LETTERS; i++) {
      this.dummy.position.set(at.x + Math.sin(i * 2.7 + seed) * 0.04, at.y + 0.02 + i * 0.035, at.z + Math.cos(i * 1.9 + seed) * 0.04);
      this.dummy.rotation.set(-Math.PI / 2, 0, i * 0.7 + seed);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.letters.mesh.setMatrixAt(this.letters.used, this.dummy.matrix);
      this.letters.mesh.setColorAt(this.letters.used++, DEAD_LETTER);
    }
    if (!fresh || this.letters.used >= MAX_LETTERS) return;
    const f = phase(this.now, 1.4, seed);
    this.dummy.position.set(at.x, at.y + 0.9 - f * (0.9 - height * 0.035), at.z);
    this.dummy.rotation.set(-Math.PI / 2 + (1 - f) * 1.2, f * 4, 0);
    this.dummy.scale.setScalar(1);
    this.dummy.updateMatrix();
    this.letters.mesh.setMatrixAt(this.letters.used, this.dummy.matrix);
    this.letters.mesh.setColorAt(this.letters.used++, DEAD_LETTER);
  }

  /** Une lettre qui tombe au bord du chemin et s'efface : un événement perdu. */
  letter(from: Vector3, along: Vector3): void {
    const seed = seedOf(from);
    for (let i = 0; i < 2; i++) {
      if (this.letters.used >= MAX_LETTERS) return;
      const f = phase(this.now, 2.4, seed + i / 2);
      const p = from.clone().addScaledVector(along, 0.3 + f * 0.6);
      this.dummy.position.set(p.x, Math.max(0.04, 0.85 - f * 1.8), p.z);
      this.dummy.rotation.set(f * 5, f * 3 + i, f * 2);
      this.dummy.scale.setScalar(f > 0.8 ? (1 - f) / 0.2 : 1);
      this.dummy.updateMatrix();
      this.letters.mesh.setMatrixAt(this.letters.used, this.dummy.matrix);
      this.letters.mesh.setColorAt(this.letters.used++, STEAM);
    }
  }

  /** Dôme de la garde : il s'allume d'autant plus que le rate limiting repousse. */
  shield(center: Vector3, radius: number, strength: number): void {
    let s = this.shields[this.shieldsUsed];
    if (!s) {
      s = new Mesh(
        new SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new MeshBasicMaterial({ color: '#2a9d8f', transparent: true, depthWrite: false }),
      );
      this.shields.push(s);
      this.scene.add(s);
    }
    this.shieldsUsed++;
    s.position.copy(center);
    s.scale.setScalar(radius);
    const pulse = 0.5 + 0.5 * Math.sin(this.now * 6 + seedOf(center) * 6);
    (s.material as MeshBasicMaterial).opacity = 0.1 + Math.min(1, strength) * (0.15 + pulse * 0.2);
  }

  private pool(geometry: SphereGeometry | BoxGeometry, material: MeshBasicMaterial | MeshLambertMaterial, max: number): Pool {
    const mesh = new InstancedMesh(geometry, material, max);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.setColorAt(0, STEAM);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return { mesh, used: 0 };
  }

  private rise(
    pool: Pool,
    at: Vector3,
    count: number,
    o: { period: number; rise: number; spread: number; grow: number },
    colorAt: (f: number) => Color,
  ): void {
    const seed = seedOf(at);
    const max = pool === this.fire ? MAX_FIRE : MAX_MIST;
    for (let i = 0; i < count && pool.used < max; i++) {
      const f = phase(this.now, o.period, seed + i / count);
      const sway = Math.sin(i * 7.1 + this.now * 2) * o.spread;
      this.dummy.position.set(at.x + sway, at.y + f * o.rise, at.z + Math.cos(i * 3.3 + seed * 9) * o.spread);
      this.dummy.rotation.set(0, 0, 0);
      // Une particule qui grossit s'efface aussi : elle rétrécit sur la fin de sa course.
      const size = (1 + f * o.grow) * (f > 0.75 ? (1 - f) / 0.25 : 1);
      this.dummy.scale.setScalar(Math.max(0.01, size));
      this.dummy.updateMatrix();
      pool.mesh.setMatrixAt(pool.used, this.dummy.matrix);
      pool.mesh.setColorAt(pool.used, colorAt(f));
      pool.used++;
    }
  }
}
