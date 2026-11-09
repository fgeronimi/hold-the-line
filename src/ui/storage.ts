/**
 * Stockage local : le navigateur peut le refuser (navigation privée, données bloquées),
 * donc chaque accès est protégé et l'application tourne sans lui.
 */
// Changer la version dès que la forme sauvegardée change : une vieille sauvegarde est ignorée.
const KEY = 'hold-the-line:v6';

export function load<T>(): T | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function save(value: unknown): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Pas de stockage : la partie reste jouable, elle ne survivra juste pas au rechargement.
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Rien à effacer si le stockage est inaccessible.
  }
}
