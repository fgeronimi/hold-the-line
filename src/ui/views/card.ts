import type { ArchNode, BoardCell, Catalog, ComponentDef, UpgradeDef } from '../../engine/types.ts';
import { resolveUpgrades, withEffect } from '../../engine/upgrades.ts';
import { realWorldComponents, realWorldUpgrades, type RealWorld } from '../../data/real-world.ts';
import { nodeNames } from '../../render/theme.ts';
import { draftInfo } from '../draft.ts';
import { minutes } from '../time.ts';
import type { TutorialStep } from '../tutorial.ts';
import { decimal as fmt, esc, hintClass as blink, hintsOf, nameOf, speech, theme, type ViewState } from './common.ts';

const KIND_NAMES: Record<string, string> = { read: 'une lecture', write: 'une écriture', async: 'un événement' };
const KINDS_TEXT: Record<string, string> = { read: 'lectures', write: 'écritures', async: 'événements' };

/** La fiche du bâtiment sélectionné, ou les fiches de ce qu'on peut bâtir sur la case cliquée. */
export function renderCard(s: ViewState): string {
  if (s.phase !== 'build') return '';
  return s.buildAt ? renderBuildMenu(s, s.buildAt) : renderNodeCard(s);
}

// ——— Construire sur une case vide ———

/** La ligne « en vrai » d'un bâtiment ou d'une évolution, et sa source s'il y en a une (D3b). */
function realLine(r: RealWorld | undefined, label = 'En vrai'): string {
  if (!r) return '';
  const source = r.source ? ` <a href="${esc(r.source.url)}" target="_blank" rel="noopener">${esc(r.source.label)}</a>` : '';
  return `<p class="real"><b>${esc(label)} :</b> ${esc(r.text)}${source}</p>`;
}

/** Les lignes « en vrai » des évolutions d'un type de bâtiment, repliées : la fiche reste courte. */
function realUpgrades(type: string, catalog: Catalog): string {
  const lines = Object.values(catalog.upgrades)
    .filter((u) => u.appliesTo === type && realWorldUpgrades[u.id])
    .map((u) => realLine(realWorldUpgrades[u.id], u.techName))
    .join('');
  return lines ? `<details class="real-ups"><summary>En vrai, ses évolutions</summary>${lines}</details>` : '';
}

/** Une fiche du menu de construction : le rôle du bâtiment, ses chiffres, ses évolutions. */
function buildCard(s: ViewState, d: ComponentDef): string {
  const style = theme.buildings[d.id];
  const accepts = d.accepts.map((k) => KINDS_TEXT[k] ?? k).join(', ');
  const ups = Object.values(s.catalog.upgrades)
    .filter((u) => u.appliesTo === d.id)
    .map((u) => `${theme.upgradeIcons[u.id] ?? '✦'} ${esc(u.techName)}`)
    .join(' · ');
  const budget = s.scenario.waves[s.game.waveIndex]?.budget ?? Infinity;
  const affordable = d.cost <= Math.max(0, budget - draftInfo(s.draft, s.catalog).cost);
  return `<article class="build-card">
        <header><span class="icon">${style?.icon ?? '🏠'}</span><div><b>${esc(d.techName)}</b><small>${esc(style?.metaphor ?? '')}</small></div></header>
        ${style ? `<p>${esc(style.role.real)}</p>` : ''}
        <p class="figures">${fmt(d.capacity)} unités de travail/s · ${d.latencyMs} ms${accepts ? ` · reçoit ${accepts}` : ''}</p>
        ${ups ? `<p class="ups">Évolutions : ${ups}</p>` : ''}
        ${realLine(realWorldComponents[d.id])}
        <footer><span>💰 ${d.cost} · ⚙ ${d.complexity}</span>
          <button data-action="build-at" data-type="${esc(d.id)}" ${affordable ? '' : 'title="Au-delà du budget restant de la vague"'}>Construire ici</button></footer>
      </article>`;
}

/**
 * Les fiches des bâtiments à construire sur une case vide : ce que fait chacun, dans la
 * métaphore et en vrai, ses chiffres, et un bouton pour le poser là. Sur un chemin, le
 * bâtiment s'insère dans le lien quand c'est sensé (I11) : la fiche le dit.
 */
export function renderBuildMenu(s: ViewState, cell: BoardCell): string {
  const road = s.draft.links.find((l) => l.path?.some((c) => c.q === cell.q && c.r === cell.r));
  const ends = road ? [road.from, road.to].map((id) => nameOf(s.draft.nodes.find((n) => n.id === id)?.type ?? id, s.catalog)) : undefined;
  const cards = Object.values(s.catalog.components)
    .filter((d) => d.behavior !== 'source' && !d.prePlaced)
    .map((d) => buildCard(s, d))
    .join('');
  const where =
    road && ends
      ? `<p class="muted">Sur le chemin ${esc(ends[0]!)} → ${esc(ends[1]!)} : le bâtiment s’insère dans le lien quand c’est sensé.</p>`
      : '<p class="muted">Choisir un bâtiment pour cette case.</p>';
  return `
    <section class="card panel build-menu">
      <button class="close" data-action="close-build" title="Fermer (Échap)">✕</button>
      <h3>Construire ici</h3>
      ${where}
      <div class="build-cards">${cards}</div>
    </section>`;
}

// ——— La fiche d'un bâtiment ———

/** La capacité d'un bâtiment dans l'unité où se fait le calcul : le travail par seconde. */
function capacityText(node: ArchNode, def: ComponentDef, catalog: Catalog): string {
  const ups = resolveUpgrades(node, catalog);
  const level = (effect: Parameters<typeof withEffect>[1]) => withEffect(ups, effect).reduce((a, u) => a + u.level, 0);
  const instances = 1 + level('instances');
  const costs = Object.entries(def.workPerRequest)
    .map(([k, v]) => `${KIND_NAMES[k] ?? k} ${fmt(v)}`)
    .join(', ');
  const replica = withEffect(ups, 'readReplicas')[0]?.effect;
  const replicas = level('readReplicas');
  const retention = withEffect(ups, 'retention')[0]?.effect;
  // Un arriéré en messages additionne des débits par seconde, une fois par minute de jeu (M7).
  const backlog = def.maxBacklog !== undefined ? def.maxBacklog + (retention ? retention.perLevel * level('retention') : 0) : undefined;
  const scaled = instances > 1 ? ` × ${instances} instances = ${fmt(def.capacity * instances)}` : '';
  const here = replica && replicas > 0 ? ` (ici ${replicas}, soit +${fmt(replica.capacityPerReplica * replicas)})` : '';
  return [
    `Capacité : ${fmt(def.capacity)} unités de travail par seconde${scaled}.`,
    costs ? `Coût en travail : ${costs}.` : '',
    replica ? `Chaque réplica ajoute ${fmt(replica.capacityPerReplica)} unités pour les lectures${here}.` : '',
    backlog !== undefined
      ? `Arriéré maximal : ${fmt(backlog)} messages. À l’échelle du jeu, la capacité se lit en minutes de trafic : arrivées par seconde × minutes d’attente.`
      : '',
    `Latence ${def.latencyMs} ms · prix ${def.cost} · complexité ${def.complexity}.`,
  ]
    .filter(Boolean)
    .join('<br>');
}

function renderNodeCard(s: ViewState): string {
  const node = s.draft.nodes.find((n) => n.id === s.selectedNode);
  if (!node) return '';
  const def = s.catalog.components[node.type];
  const hinted = hintsOf(s).highlight;
  const links = s.draft.links
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.from === node.id || l.to === node.id)
    .map(({ l, i }) => {
      const on = hinted?.link?.from === l.from && hinted.link.to === l.to;
      return `<li>${esc(linkEnd(l.from))} → ${esc(linkEnd(l.to))} <button data-action="remove-link" data-link="${i}"${on ? ' class="hint"' : ''}>retirer</button></li>`;
    })
    .join('');
  const permanent = def?.behavior === 'source' || !!node.fixed;
  const own = nodeNames(node, s.catalog, theme);
  const role = theme.buildings[node.type]?.role;
  function linkEnd(id: string): string {
    const n = s.draft.nodes.find((x) => x.id === id);
    if (!n) return id;
    const { tech } = nodeNames(n, s.catalog, theme);
    // L'identifiant ne sert qu'à distinguer deux bâtiments du même nom.
    return s.draft.nodes.filter((x) => nodeNames(x, s.catalog, theme).tech === tech).length > 1 ? `${tech} (${n.id})` : tech;
  }
  const fixedNote = node.fixed ? '<p class="muted">Service déjà en place, tenu par une autre équipe : il ne se démolit pas, mais ses évolutions sont à vous.</p>' : '';
  const removeHinted = hinted?.tool === 'remove' && hinted.node === node.id;
  const remove = permanent ? '' : `<button data-action="remove-node" data-node="${esc(node.id)}"${removeHinted ? ' class="hint"' : ''}>Retirer</button>`;
  return `
    <section class="card panel">
      <button class="close" data-action="deselect" title="Fermer">✕</button>
      <h3>${esc(own.tech)} <small>${esc(own.metaphor)}</small></h3>
      ${fixedNote}
      ${role ? speech(role.says, role.real) : ''}
      ${def && def.behavior !== 'source' ? `<p class="figures">${capacityText(node, def, s.catalog)}</p>` : ''}
      ${realLine(realWorldComponents[node.type])}
      ${realUpgrades(node.type, s.catalog)}
      <p>${upgradeSelects(node, s.catalog) || '<span class="muted">aucune évolution</span>'}</p>
      ${links ? `<ul>${links}</ul>` : '<p class="muted">Aucun chemin.</p>'}
      <p>
        <button data-action="tool" data-tool="move" data-node="${esc(node.id)}">Déplacer</button>
        ${remove}
      </p>
    </section>`;
}

/** Le libellé d'un niveau dans le sélecteur : un palier, un plafond d'instances, oui ou non, ou le niveau. */
function levelOption(u: UpgradeDef, i: number): string {
  if (u.effect.type === 'rateLimit') return i === 0 ? 'off' : `${u.effect.tiersPerClientRps[i - 1]} req/s/client`;
  if (u.effect.type === 'autoscaling') return i === 0 ? 'off' : `≤ +${i}`;
  if (u.maxLevel === 1) return i === 0 ? 'non' : 'oui';
  return String(i);
}

/** Les sélecteurs d'évolutions d'un bâtiment : partagés par la fiche et la vue tableau. */
export function upgradeSelects(n: ArchNode, catalog: Catalog): string {
  return Object.values(catalog.upgrades)
    .filter((u) => u.appliesTo === n.type)
    .map((u) => {
      const level = n.upgrades?.[u.id] ?? 0;
      const options = Array.from(
        { length: u.maxLevel + 1 },
        (_, i) => `<option value="${i}" ${i === level ? 'selected' : ''}>${esc(levelOption(u, i))}</option>`,
      ).join('');
      return `<label>${esc(u.techName)} <select data-action="upgrade" data-node="${esc(n.id)}" data-upgrade="${esc(u.id)}">${options}</select></label>`;
    })
    .join(' ');
}

// ——— Les pastilles au pied du bâtiment ———

/** Ce que la pastille affiche du niveau : le palier, le plafond d'instances, ou le nombre. */
function badgeOf(u: UpgradeDef, level: number): string {
  if (level === 0 || u.maxLevel <= 1) return '';
  if (u.effect.type === 'rateLimit') return `${u.effect.tiersPerClientRps[level - 1]}/s`;
  if (u.effect.type === 'autoscaling') return `≤${level}`;
  return `+${level}`;
}

/** L'infobulle d'une pastille : le nom, le libellé, le prix, la complexité, et le délai s'il y en a un. */
function pipTip(u: UpgradeDef): string {
  const price = u.cost.perLevel > 0 ? `${u.cost.base > 0 ? `${u.cost.base} + ` : ''}${u.cost.perLevel} par niveau` : `${u.cost.base}`;
  const tiers = u.effect.type === 'rateLimit' ? `<br>paliers : ${u.effect.tiersPerClientRps.join(', ')} req/s par client` : '';
  const delay =
    u.effect.type === 'autoscaling'
      ? `<br>une instance démarre en ${minutes(u.effect.startupTicks)}`
      : u.effect.type === 'backoff'
        ? `<br>relances étalées sur ${minutes(u.effect.spreadTicks)}`
        : '';
  return `<em>${esc(u.techName)}</em>${esc(u.label)}<br>${price} · +${u.complexity.base + u.complexity.perLevel} complexité${tiers}${delay}`;
}

function pip(node: ArchNode, u: UpgradeDef, hinted: boolean): string {
  const level = node.upgrades?.[u.id] ?? 0;
  const icon = theme.upgradeIcons[u.id] ?? '✦';
  const tip = pipTip(u);
  const data = `data-action="upgrade-step" data-node="${esc(node.id)}" data-upgrade="${esc(u.id)}"`;
  const face = `<span class="icon">${icon}<b>${esc(badgeOf(u, level))}</b></span>`;
  const on = level > 0 ? ' on' : '';
  if (u.maxLevel <= 1) {
    return `<button class="pip${on}${blink(hinted)}" ${data} data-delta="toggle" aria-pressed="${level > 0}" aria-label="${esc(u.techName)}">${face}<i>${tip}</i></button>`;
  }
  const minus = `<button class="step" ${data} data-delta="-1" ${level === 0 ? 'disabled' : ''} aria-label="${esc(u.techName)} : un niveau de moins">−</button>`;
  const plus = `<button class="step" ${data} data-delta="1" ${level === u.maxLevel ? 'disabled' : ''} aria-label="${esc(u.techName)} : un niveau de plus">+</button>`;
  return `<div class="pip leveled${on}${blink(hinted)}">
            ${minus}${face}${plus}<i>${tip}</i></div>`;
}

/**
 * Les pastilles au pied du bâtiment sélectionné sur le plateau : déplacer et retirer en
 * tête, puis une par évolution du catalogue qui s'y applique. Tout-ou-rien, la pastille se
 * bascule ; à niveaux, deux boutons − et + l'encadrent. Le prix et la complexité au survol.
 */
export function upgradePips(
  node: ArchNode,
  catalog: Catalog,
  can: { move: boolean; remove: boolean } = { move: false, remove: false },
  /** Ce que désigne le dernier indice, s'il vise ce bâtiment : la pastille clignote. */
  hinted?: TutorialStep['highlight'],
): string {
  const target = hinted?.node === node.id ? hinted : undefined;
  const id = esc(node.id);
  const actions = [
    can.move &&
      `<button class="pip act" data-action="tool" data-tool="move" data-node="${id}" aria-label="Déplacer"><span class="icon">✥</span><i><em>Déplacer</em>Cliquer la case d’arrivée, ou glisser le bâtiment</i></button>`,
    can.remove &&
      `<button class="pip act ko${blink(target?.tool === 'remove')}" data-action="remove-node" data-node="${id}" aria-label="Retirer"><span class="icon">🧨</span><i><em>Retirer</em>Démolir le bâtiment et ses chemins. S’il était déjà là à la vague précédente, sa valeur d’achat entre dans la facture (migration)</i></button>`,
  ].filter(Boolean);
  const pips = Object.values(catalog.upgrades)
    .filter((u) => u.appliesTo === node.type)
    .map((u) => pip(node, u, target?.upgrade === u.id));
  if (pips.length === 0 && actions.length === 0) return '';
  return `<div class="pips">${actions.length > 0 ? `<div class="pip-actions">${actions.join('')}</div>` : ''}${pips.join('')}</div>`;
}
