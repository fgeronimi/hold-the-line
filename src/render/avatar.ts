import { AmbientLight, AnimationMixer, Box3, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer, type AnimationClip, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Comment cadrer un personnage pour son portrait. */
export interface PortraitOptions {
  /** Hauteur de l'image, en pixels. */
  size?: number;
  /** Largeur sur hauteur : 1, un carré ; moins, un portrait en pied. */
  aspect?: number;
  /** La part haute du personnage montrée : 0.5, le buste ; 1, en pied. */
  crop?: number;
  /** L'animation qui donne la pose, et l'instant où la figer (en secondes). */
  clip?: string;
  time?: number;
  /** Rotation autour de la verticale, en degrés : 0, de face ; 25, de trois quarts. */
  turn?: number;
}

/** Une image d'une boucle : ce qui change d'une image à l'autre autour de la pose de départ. */
export interface PortraitFrame {
  /** Rotation autour de la verticale, en degrés ; celle des options à défaut. */
  turn?: number;
  /** L'instant de l'animation, en secondes ; celui des options à défaut. */
  time?: number;
  /** Étirement vertical, autour de 1 : la respiration. */
  breath?: number;
}

/**
 * Le portrait d'un personnage du kit, rendu une fois hors écran sur fond transparent. Pas de
 * boucle d'animation : la pose est figée, l'image est une donnée comme une autre (`data:`).
 */
export async function portraitOf(url: string, o: PortraitOptions = {}, renderer?: WebGLRenderer): Promise<string> {
  return (await portraitFrames(url, o, [{}], renderer))[0]!;
}

/**
 * Plusieurs images du même personnage, chargé une fois et rendu par le même renderer : les
 * images d'une boucle (le chambellan de l'accueil). Le cadre est calculé sur la pose de départ
 * et ne bouge plus, sinon le personnage tremblerait d'une image à l'autre.
 */
export async function portraitFrames(url: string, o: PortraitOptions, frames: PortraitFrame[], renderer?: WebGLRenderer): Promise<string[]> {
  const { size = 256, aspect = 1, crop = 0.55, clip, time = 0, turn = 22 } = o;
  const gltf = await new GLTFLoader().loadAsync(url);
  const subject: Object3D = gltf.scene;
  const mixer = poser(subject, gltf.animations, clip);
  const place = (f: PortraitFrame) => {
    subject.rotation.y = ((f.turn ?? turn) * Math.PI) / 180;
    subject.scale.set(1, f.breath ?? 1, 1);
    mixer?.setTime(f.time ?? time);
    subject.updateMatrixWorld(true);
  };
  place({});

  const stage = new Scene();
  stage.add(new HemisphereLight('#fff6e0', '#6f5a3a', 0.9), new AmbientLight('#ffffff', 0.35));
  const key = new DirectionalLight('#fff1d6', 2.2);
  key.position.set(3, 5, 6);
  const rim = new DirectionalLight('#ffd27a', 1.1);
  rim.position.set(-5, 4, -3);
  stage.add(key, rim, subject);

  // Le cadre : la part haute du personnage, centrée, un peu d'air au-dessus de la tête (et sous
  // les pieds, en pied).
  const box = new Box3().setFromObject(subject);
  const height = box.max.y - box.min.y;
  const top = box.max.y + height * 0.04;
  const bottom = box.max.y - height * crop - (crop >= 1 ? height * 0.03 : 0);
  const centre = new Vector3((box.min.x + box.max.x) / 2, (top + bottom) / 2, (box.min.z + box.max.z) / 2);
  const camera = new PerspectiveCamera(24, aspect, 0.01, 100);
  const distance = (top - bottom) / 2 / Math.tan((camera.fov * Math.PI) / 360);
  // Un peu sous la hauteur des yeux : le visage se voit sous un chapeau à large bord.
  camera.position.set(centre.x, centre.y - (top - bottom) * 0.06, centre.z + distance * 1.12);
  camera.lookAt(centre);

  const own = !renderer;
  const r = renderer ?? new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.outputColorSpace = SRGBColorSpace;
  r.setPixelRatio(1);
  r.setSize(Math.round(size * aspect), size, false);
  r.setClearColor(0x000000, 0);
  const images = frames.map((f) => {
    place(f);
    r.render(stage, camera);
    return r.domElement.toDataURL('image/png');
  });
  if (own) {
    r.dispose();
    r.forceContextLoss();
  }
  return images;
}

/** Le squelette sur l'animation demandée (la première, à défaut), prêt à être figé à un instant. */
function poser(subject: Object3D, clips: AnimationClip[], name: string | undefined): AnimationMixer | undefined {
  const chosen = clips.find((c) => c.name === name) ?? clips[0];
  if (!chosen) return undefined;
  const mixer = new AnimationMixer(subject);
  mixer.clipAction(chosen).play();
  return mixer;
}
