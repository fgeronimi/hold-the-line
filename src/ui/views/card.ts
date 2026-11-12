import type { ArchNode, Catalog, ComponentDef, UpgradeDef } from '../../engine/types.ts';
import { resolveUpgrades, withEffect } from '../../engine/upgrades.ts';
import { nodeNames } from '../../render/theme.ts';
import { draftInfo } from '../draft.ts';
import { minutes } from '../time.ts';
import type { TutorialStep } from '../tutorial.ts';
import { decimal as fmt, esc, hintClass as blink, hintsOf, speech, theme, type ViewState } from './common.ts';
import { icon } from '../icons.ts';
import { cardArt, renderHand } from './hand.ts';

const KIND_NAMES: Record<string, string> = { read: 'une lecture', write: 'une écriture', async: 'un événement' };

/** Ce qui flotte sur le plateau pendant la construction : la main de cartes, sinon la carte du bâtiment sélectionné. */
export function renderCard(s: ViewState): string {
  if (s.phase !== 'build') return '';
  return renderHand(s) || renderNodeCard(s);
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
  const remove = permanent ? '' : `<button data-action="remove-node" data-node="${esc(node.id)}"${removeHinted ? ' class="hint"' : ''}>${icon('remove')} Retirer</button>`;
  const cost = def && def.behavior !== 'source' ? `<p class="hcard-cost"><span title="Prix">${icon('coin')} ${def.cost}</span><span title="Complexité">${icon('cog')} ${def.complexity}</span></p>` : '';
  return `
    <section class="card detail-card" aria-label="${esc(own.tech)}">
      <header class="hcard-title"><b>${esc(own.tech)}</b><small>${esc(own.metaphor)}</small>
        <button class="close" data-action="deselect" title="Fermer" aria-label="Fermer">${icon('close')}</button></header>
      <div class="hcard-art">${cardArt(s, node.type)}</div>
      <div class="detail-body">
        ${fixedNote}
        ${role ? speech(role.says, role.real) : ''}
        ${def && def.behavior !== 'source' ? `<p class="figures">${capacityText(node, def, s.catalog)}</p>` : ''}
        <p>${upgradeSelects(node, s.catalog) || '<span class="muted">aucune évolution</span>'}</p>
        ${links ? `<ul>${links}</ul>` : '<p class="muted">Aucun chemin.</p>'}
      </div>
      ${cost}
      <footer class="hcard-ribbon">
        <button data-action="tool" data-tool="move" data-node="${esc(node.id)}">${icon('move')} Déplacer</button>
        ${remove}
      </footer>
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
      `<button class="pip act" data-action="tool" data-tool="move" data-node="${id}" aria-label="Déplacer"><span class="icon">${icon('move')}</span><i><em>Déplacer</em>Cliquer la case d’arrivée, ou glisser le bâtiment</i></button>`,
    can.remove &&
      `<button class="pip act ko${blink(target?.tool === 'remove')}" data-action="remove-node" data-node="${id}" aria-label="Retirer"><span class="icon">${icon('remove')}</span><i><em>Retirer</em>Démolir le bâtiment et ses chemins. S’il était déjà là à la vague précédente, sa valeur d’achat entre dans la facture (migration)</i></button>`,
  ].filter(Boolean);
  const pips = Object.values(catalog.upgrades)
    .filter((u) => u.appliesTo === node.type)
    .map((u) => pip(node, u, target?.upgrade === u.id));
  if (pips.length === 0 && actions.length === 0) return '';
  return `<div class="pips">${actions.length > 0 ? `<div class="pip-actions">${actions.join('')}</div>` : ''}${pips.join('')}</div>`;
}
