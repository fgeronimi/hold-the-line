import { configDefaults, defineConfig } from 'vitest/config';

// Chemins relatifs : le site doit tourner sous n'importe quel sous-chemin GitHub Pages.
export default defineConfig({
  base: './',
  // Les worktrees des agents vivent dans .claude/ : leurs tests ne sont pas ceux du dépôt.
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
