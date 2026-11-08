/**
 * Stockage local : le navigateur peut le refuser (navigation privée, données bloquées),
 * donc chaque accès est protégé et l'application tourne sans lui.
 */
const KEY = 'hold-the-line:v1';

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
