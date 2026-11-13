#!/usr/bin/env node
/**
 * Les images animées du README, refaites depuis le jeu : `npm run captures`, ou
 * `npm run captures -- vitrine vague` pour n'en refaire que certaines.
 *
 * Démarre Vite sur sa propre origine (jamais celle où l'on joue : la partie gardée n'est pas
 * touchée), pilote Chrome sans fenêtre et filme la page image par image (screencast du
 * protocole DevTools), puis monte des WebP animés dans `docs/media/`.
 *
 * Il faut : Google Chrome (ou `HL_CHROME=<chemin>`), `img2webp` et `cwebp` (paquet webp),
 * `sips` (macOS). Le rendu passe par SwiftShader, comme sans GPU : lent, mais identique
 * d'une machine à l'autre. Compter une dizaine de minutes pour tout refaire.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA = join(ROOT, 'docs/media');
const PORT = 5299;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'hold-the-line:v9';

// ——— Le film : une image par pas de temps, recadrée, puis un WebP animé ———

/** Filme la page jusqu'à `stop` : le screencast livre une image à chaque rendu, datée. */
async function record(page) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1280, maxHeight: 2000 });
  return {
    /**
     * `speed` accélère (1.5 : une seconde de film pour 1,5 s filmée), ou `duration` fixe la
     * longueur du film en secondes : le rejeu avance au rythme des images, et le rendu logiciel
     * en tient plus ou moins selon la machine. `from`/`to` bornent en secondes filmées ; `crop`
     * est en pixels de la page, `width` la largeur finale.
     */
    async stop(name, { from = 0, to = Infinity, fps = 10, speed: fixed = 1, duration, q = 65, crop, width = 800 } = {}) {
      await cdp.send('Page.stopScreencast');
      const t0 = frames[0].t;
      const kept = frames.filter((f) => f.t - t0 >= from && f.t - t0 <= to);
      const speed = duration ? (kept.at(-1).t - kept[0].t) / duration : fixed;
      const picked = [];
      // L'image la plus récente à chaque pas : le screencast n'envoie rien quand rien ne bouge.
      for (let t = kept[0].t, k = 0; t <= kept.at(-1).t; t += speed / fps) {
        while (k + 1 < kept.length && kept[k + 1].t <= t) k++;
        picked.push(kept[k]);
      }
      const dir = mkdtempSync(join(tmpdir(), `hl-${name}-`));
      const args = ['-loop', '0', '-lossy', '-q', String(q), '-m', '4'];
      picked.forEach((f, i) => {
        const png = join(dir, `${String(i).padStart(4, '0')}.png`);
        writeFileSync(png, Buffer.from(f.data, 'base64'));
        if (crop) execFileSync('sips', ['-c', `${crop.h}`, `${crop.w}`, '--cropOffset', `${crop.y}`, `${crop.x}`, png], { stdio: 'ignore' });
        execFileSync('sips', ['--resampleWidth', String(width), png], { stdio: 'ignore' });
        args.push('-d', String(Math.round(1000 / fps)), png);
      });
      execFileSync('img2webp', [...args, '-o', join(MEDIA, `${name}.webp`)], { stdio: 'pipe' });
      rmSync(dir, { recursive: true, force: true });
      console.log(`  ${name}.webp : ${picked.length} images`);
    },
  };
}

/** Une image fixe, en WebP. */
async function still(page, name, clip, width = 1000) {
  const dir = mkdtempSync(join(tmpdir(), `hl-${name}-`));
  const png = join(dir, 'still.png');
  await page.screenshot({ path: png, clip, fullPage: !!clip, animations: 'disabled', timeout: 90_000 });
  execFileSync('cwebp', ['-quiet', '-q', '80', '-resize', String(width), '0', png, '-o', join(MEDIA, `${name}.webp`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ${name}.webp`);
}

// ——— La partie : on l'écrit dans le stockage, comme une sauvegarde ———

/**
 * Le scénario `id` à la vague `k`, chaque vague passée tenue avec sa première réponse
 * attendue ; le brouillon est la réponse de la vague (`answer`) ou la cité d'avant (`previous`).
 */
async function seed(page, id, k, draft = 'answer') {
  await page.goto(`${BASE}/`);
  await page.evaluate(
    async ({ id, k, draft, key }) => {
      const { answersOf } = await import('/src/data/balance-space.ts');
      const { newGame } = await import('/src/engine/game.ts');
      const g = newGame();
      const history = [g.history[0]];
      for (let i = 1; i <= k; i++) history.push(answersOf(id, i - 1)[0]);
      const game = { ...g, waveIndex: k, committed: history[k], history, stars: Array(k).fill({ held: true, lean: true, thrifty: true }) };
      localStorage.setItem(key, JSON.stringify({ current: id, welcomed: true, saves: { [id]: { game, draft: draft === 'answer' ? answersOf(id, k)[0] : history[k] } } }));
    },
    { id, k, draft, key: KEY },
  );
  await page.reload();
  await page.click(`[data-action="pick-scenario"][data-scenario="${id}"]`);
  await page.click('[data-action="start-build"]');
  await page.mouse.move(1150, 705);
  await page.waitForTimeout(2500);
}

/** Lance la vague en ×2 et la filme jusqu'au debrief. */
async function playWave(page) {
  const film = await record(page);
  await page.click('button.launch');
  await page.waitForSelector('select[data-r="speed"]');
  await page.selectOption('select[data-r="speed"]', '2');
  await page.mouse.move(1150, 640);
  await page.waitForSelector('.dialog', { timeout: 300_000 });
  await page.waitForTimeout(1500);
  return film;
}

/** Pose un calque par-dessus la page, avec le sprite et la feuille de style du jeu. */
async function overlay(page, css, html) {
  await page.evaluate(
    async ({ css, html }) => {
      const { installSprite, icon } = await import('/src/ui/icons.ts');
      installSprite();
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
      const host = document.createElement('div');
      host.id = 'readme-overlay';
      // Les pictogrammes s'écrivent {nom} dans le gabarit.
      host.innerHTML = html.replace(/\{([a-z]+)\}/g, (_, name) => icon(name));
      document.body.append(host);
      await document.fonts.ready;
    },
    { css, html },
  );
  await page.waitForTimeout(400);
}

/** Une capture d'un élément, fond transparent compris, en WebP. */
async function element(page, selector, name, width) {
  const dir = mkdtempSync(join(tmpdir(), `hl-${name}-`));
  const png = join(dir, 'el.png');
  await page.locator(selector).screenshot({ path: png, omitBackground: true, animations: 'disabled', timeout: 90_000 });
  execFileSync('cwebp', ['-quiet', '-q', '85', '-alpha_q', '100', ...(width ? ['-resize', String(width), '0'] : []), png, '-o', join(MEDIA, `${name}.webp`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ${name}.webp`);
}

// ——— Les plans ———

const SHOTS = {
  /**
   * Le portrait du chambellan (I22) : le mage du kit, en buste, sur fond transparent. Il va dans
   * `public/`, pas dans `docs/media/` : c'est une image du jeu, que le thème nomme.
   */
  async narrateur(page) {
    await page.goto(`${BASE}/design.html`);
    const data = await page.evaluate(async () => {
      const { portraitOf } = await import('/src/render/avatar.ts');
      return portraitOf('/models/kaykit-chars/Mage.glb', { size: 256, crop: 0.66, clip: 'Walking_B', time: 0.15, turn: 18 });
    });
    const dir = mkdtempSync(join(tmpdir(), 'hl-narrateur-'));
    const png = join(dir, 'face.png');
    writeFileSync(png, Buffer.from(data.split(',')[1], 'base64'));
    execFileSync('cwebp', ['-quiet', '-q', '90', '-alpha_q', '100', '-resize', '160', '0', png, '-o', join(ROOT, 'public/narrator.webp')]);
    console.log('  public/narrator.webp');

    // En pied, pour l'accueil et le README. Le kit allégé n'a gardé que la marche : la pose est
    // figée là où les pieds se croisent, et la boucle ne fait que balancer et respirer.
    const FRAMES = 36;
    const NARRATOR_POSE = 0.4;
    const frames = await page.evaluate(async ({ n, pose }) => {
      const { portraitFrames } = await import('/src/render/avatar.ts');
      const loop = Array.from({ length: n }, (_, k) => {
        const a = (2 * Math.PI * k) / n;
        return { turn: 16 + 10 * Math.sin(a), breath: 1 + 0.012 * Math.sin(2 * a) };
      });
      return portraitFrames('/models/kaykit-chars/Mage.glb', { size: 440, aspect: 0.62, crop: 1, clip: 'Walking_B', time: pose }, loop);
    }, { n: FRAMES, pose: NARRATOR_POSE });
    const args = ['-loop', '0', '-lossy', '-q', '70', '-m', '6'];
    frames.forEach((f, i) => {
      const file = join(dir, `${String(i).padStart(3, '0')}.png`);
      writeFileSync(file, Buffer.from(f.split(',')[1], 'base64'));
      args.push('-d', '110', file);
    });
    execFileSync('img2webp', [...args, '-o', join(ROOT, 'public/narrator-full.webp')], { stdio: 'pipe' });
    rmSync(dir, { recursive: true, force: true });
    console.log(`  public/narrator-full.webp : ${FRAMES} images`);
  },

  /** La bannière du README : la cité de la vague 5 en fond, la plaque du titre posée dessus. */
  async banniere(page) {
    await seed(page, 'url-shortener', 4);
    await page.mouse.move(1279, 719);
    await overlay(
      page,
      `#hud, #toolbar, #hand, #dialog, .city-pips { display: none !important; }
       #readme-overlay { position: fixed; inset: 0; z-index: 50; pointer-events: none;
         background: radial-gradient(ellipse 60% 70% at 50% 52%, rgba(20, 12, 4, 0) 40%, rgba(20, 12, 4, .45) 100%); }
       #readme-overlay .wave-badge { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) scale(2.1); }
       #readme-overlay .hud-title b { font-size: 26px; white-space: nowrap; }
       #readme-overlay .hud-title span { font-size: 11.5px; white-space: nowrap; }`,
      `<div class="wave-badge"><span class="wave-skull">{skull}</span>
         <div class="plaque hud-title"><b>Hold the Line</b><span>Bâtir une architecture, la faire tenir vague après vague</span></div></div>`,
    );
    await still(page, 'banniere', { x: 0, y: 120, width: 1280, height: 480 }, 1280);
  },

  /**
   * Le bouton « Jouer » du README, dans la matière du bouton de lancement. Affiché à 300 px de
   * large, il est rendu à densité 3 : à l'échelle 1, un écran Retina l'agrandissait et le floutait.
   */
  async jouer(lowres) {
    const page = await lowres.context().browser().newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 3 });
    await page.goto(`${BASE}/`);
    await overlay(
      page,
      `body > *:not(#readme-overlay) { visibility: hidden; }
       html, body { background: transparent !important; }
       #readme-overlay { position: fixed; left: 20px; top: 20px; padding: 6px 6px 10px; }
       #readme-overlay button.launch { font-size: 24px; }`,
      `<button class="launch">{swords}<span>Jouer dans le navigateur</span></button>`,
    );
    await element(page, '#readme-overlay', 'jouer', 900);
    await page.close();
  },

  /** L'accueil du premier lancement (P4) : le chambellan en pied, les quatre temps d'une vague. */
  async accueil(page) {
    await page.goto(`${BASE}/`);
    await page.evaluate((key) => localStorage.removeItem(key), KEY);
    await page.reload();
    await page.waitForTimeout(2500);
    await element(page, '.dialog', 'accueil', 900);
  },

  /** Le bilan du raccourcisseur, joué jusqu'au bout avec des réponses attendues (P4). */
  async bilan(page) {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto(`${BASE}/`);
    await page.evaluate(async (key) => {
      const { answersOf } = await import('/src/data/balance-space.ts');
      const { catalog } = await import('/src/data/catalog.ts');
      const { urlShortener } = await import('/src/data/scenarios/url-shortener.ts');
      const { newGame, playWave } = await import('/src/engine/game.ts');
      let game = newGame();
      // La vague 3 en autoscaling, pour que « À revoir » ait quelque chose à dire.
      const picks = urlShortener.waves.map((_, i) => answersOf('url-shortener', i)[i === 2 ? 2 : 0]);
      for (const arch of picks) ({ state: game } = playWave(game, urlShortener, arch, catalog));
      localStorage.setItem(key, JSON.stringify({ current: 'url-shortener', welcomed: true, saves: { 'url-shortener': { game, draft: picks.at(-1) } } }));
    }, KEY);
    await page.reload();
    await page.click('[data-action="pick-scenario"][data-scenario="url-shortener"]');
    await page.addStyleTag({ content: '.layer.center > .review-dialog { max-height: none; }' });
    await page.waitForTimeout(2500);
    await element(page, '.review-dialog', 'bilan', 900);
    await page.setViewportSize({ width: 1280, height: 720 });
  },

  /** L'écran de choix : les quatre scénarios. */
  async choix(page) {
    await page.goto(`${BASE}/`);
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ saves: {}, welcomed: true })), KEY);
    await page.reload();
    await page.waitForTimeout(2500);
    await element(page, '.dialog', 'choix', 900);
  },

  /** La fenêtre des succès, quelques-uns acquis. */
  async succes(page) {
    await page.setViewportSize({ width: 1280, height: 1500 });
    await page.goto(`${BASE}/`);
    await page.evaluate((key) => {
      const at = { scenario: 'url-shortener', wave: 2 };
      const ids = ['client-server', 'horizontal-scaling', 'redundancy', 'cache', 'cdn', 'read-replica', 'rate-limiting', 'pubsub', 'idempotence', 'circuit-breaker'];
      localStorage.setItem(key, JSON.stringify({ saves: {}, welcomed: true, achievements: Object.fromEntries(ids.map((id) => [id, at])) }));
    }, KEY);
    await page.reload();
    await page.waitForTimeout(1500);
    await page.click('[data-action="show-achievements"]');
    // Plus large que dans le jeu, pour que la grille tienne en peu de lignes dans le README.
    await page.addStyleTag({ content: '.layer.center > .achievements-dialog { width: 1240px; max-width: 1240px; max-height: none; } .achievements { grid-template-columns: repeat(5, 1fr); }' });
    await page.waitForTimeout(600);
    await element(page, '.dialog', 'succes', 1000);
    await page.setViewportSize({ width: 1280, height: 720 });
  },

  /** La vague 1 guidée : reflet, main distribuée, carte soulevée, pose, chemin tracé. */
  async construction(page) {
    await page.goto(`${BASE}/`);
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ saves: {}, welcomed: true })), KEY);
    await page.reload();
    await page.click('[data-action="pick-scenario"][data-scenario="url-shortener"]');
    await page.click('[data-action="start-build"]');
    await page.mouse.move(1150, 700);
    await page.waitForTimeout(2500);
    const w = (ms) => page.waitForTimeout(ms);
    const film = await record(page);
    const card = async (type) => {
      await page.click('[data-action="open-hand"]');
      await page.mouse.move(1150, 700);
      await w(1300);
      const b = await page.locator(`.hcard[data-type="${type}"]`).boundingBox();
      // La carte de droite recouvre le bord droit de celle-ci : on la survole par la gauche.
      await page.mouse.move(b.x + b.width * 0.3, b.y + 80, { steps: 8 });
      await w(1100);
      await page.locator(`.hcard[data-type="${type}"]`).dispatchEvent('click');
      await w(500);
    };
    const link = async (from, to) => {
      await page.click('[data-action="tool"][data-tool="link"]');
      await w(300);
      await page.mouse.click(...from);
      await w(500);
      await page.mouse.click(...to);
      await page.mouse.move(1150, 700);
      await w(1500);
    };
    await w(2200);
    // Cases du cadrage par défaut à 1280 × 720 : hameaux, tour, archives.
    await card('app-server');
    await page.mouse.click(400, 225);
    await page.mouse.move(1150, 700);
    await w(1200);
    await link([290, 180], [400, 222]);
    await card('database');
    await page.mouse.click(560, 300);
    await page.mouse.move(1150, 700);
    await w(1200);
    await link([400, 222], [560, 296]);
    await page.click('[data-action="tool"][data-tool="select"]');
    await page.mouse.move(1150, 700);
    await w(3000);
    await film.stop('construction');
  },

  /** Vague 3 du raccourcisseur, tenue : une instance tombe à la 46ᵉ minute. Et son debrief. */
  async vague(page) {
    await seed(page, 'url-shortener', 2);
    const film = await playWave(page);
    await film.stop('vague', { duration: 20, q: 62, crop: { x: 90, y: 50, w: 900, h: 470 } });
    await still(page, 'debrief');
  },

  /** Vague 2 du raccourcisseur avec la cité de la vague 1 : la base sature, le SLA rompt. */
  async defaite(page) {
    await seed(page, 'url-shortener', 1, 'previous');
    const film = await playWave(page);
    await film.stop('defaite', { speed: 1.5, q: 62, to: 16 });
  },

  /** La planche de design, dans la seule matière retenue (parchemin et laiton) : pictogrammes, boutons, badges, barres. */
  async design(page) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/design.html`);
    await page.waitForTimeout(2000);
    // Les deux autres matières de la planche ont été écartées (I18) : le README n'en montre qu'une.
    await page.addStyleTag({ content: '.stage.t-blond, .stage.t-dark { display: none !important; }' });
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => {
      const sections = [...document.querySelectorAll('main section')];
      const at = (title) => sections.find((s) => s.querySelector('h2')?.textContent.startsWith(title)).getBoundingClientRect();
      const top = at('Pictogrammes').top + scrollY - 10;
      return { x: 0, y: top, width: innerWidth, height: at('Barre du haut').bottom + scrollY + 10 - top };
    });
    await still(page, 'design', clip);
    await page.setViewportSize({ width: 1280, height: 720 });
  },

  /** Chaque îlot de la vitrine, seul : elle ne dessine que ceux qui sont à l'écran. */
  async vitrine(page) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/vitrine.html`);
    await page.waitForTimeout(3000);
    const titles = await page.$$eval('.tile h2', (hs) => hs.map((h) => h.firstChild.textContent.trim()));
    for (const [i, title] of titles.entries()) {
      await page.evaluate((i) => document.querySelectorAll('.tile')[i].scrollIntoView({ block: 'center' }), i);
      await page.waitForTimeout(2500);
      const b = await page.locator('.tile .view').nth(i).boundingBox();
      const film = await record(page);
      await page.waitForTimeout(6500);
      await film.stop(`vitrine-${slug(title)}`, { from: 0.3, q: 60, width: 360, crop: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  },
};

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// ——— Le tournage ———

const wanted = process.argv.slice(2);
const unknown = wanted.filter((w) => !(w in SHOTS));
if (unknown.length) {
  console.error(`Plans inconnus : ${unknown.join(', ')}. Au choix : ${Object.keys(SHOTS).join(', ')}.`);
  process.exit(1);
}
const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false } });
await server.listen();
const launch = () =>
  chromium.launch({
    ...(process.env.HL_CHROME ? { executablePath: process.env.HL_CHROME } : { channel: 'chrome' }),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
try {
  for (const name of wanted.length ? wanted : Object.keys(SHOTS)) {
    console.log(name);
    // Un navigateur neuf par plan : enchaînés dans le même, le rendu logiciel s'essouffle et
    // la vague perdue n'atteignait plus son debrief.
    const browser = await launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => console.error(`  erreur de la page : ${e.message}`));
      await SHOTS[name](page);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
