/**
 * Stockage local : le navigateur peut le refuser (navigation privée, données bloquées),
 * donc chaque accès est protégé et l'application tourne sans lui.
 */
// Changer la version dès que la forme sauvegardée change : une vieille sauvegarde est ignorée.
const KEY = 'hold-the-line:v9';

/**
 * Ce qui est gardé, s'il a la forme attendue : `valid` le vérifie avant qu'on s'en serve,
 * pour qu'une sauvegarde abîmée soit ignorée ici plutôt que de faire planter la partie plus loin.
 */
export function load<T>(valid: (value: unknown) => value is T): T | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : undefined;
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
