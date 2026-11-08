// Allège les personnages KayKit : une seule animation de marche (pour figer la pose au
// chargement) et seulement les accessoires utilisés. Les originaux pèsent ~4 Mo chacun.
// Usage : node scripts/strip-characters.mjs <dossier des .glb originaux> public/models/kaykit-chars
import { NodeIO } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';

// Personnage → animation gardée (pour figer une pose de marche) et accessoires gardés.
const plan = {
  Rogue: { clip: 'Running_A', keep: ['Rogue_Cape'] },
  Barbarian: { clip: 'Walking_A', keep: ['Barbarian_Hat', 'Barbarian_Cape', 'Mug'] },
  Mage: { clip: 'Walking_B', keep: ['Mage_Hat', 'Mage_Cape', '1H_Wand'] },
  Skeleton_Warrior: { clip: 'Running_A', keep: ['Skeleton_Warrior_Helmet'] },
};
const [inDir, outDir] = process.argv.slice(2);
const io = new NodeIO();
for (const [name, { clip, keep }] of Object.entries(plan)) {
  const doc = await io.read(`${inDir}/${name}.glb`);
  const root = doc.getRoot();
  for (const a of root.listAnimations()) {
    if (a.getName() === clip) continue;
    // Supprimer l'animation ne supprime ni ses canaux ni ses échantillonneurs. Leurs données
    // ne sont pas supprimées à la main : certaines sont partagées avec l'animation gardée ;
    // `prune` retire ensuite celles qui ne servent plus à rien.
    for (const s of a.listSamplers()) s.dispose();
    for (const c of a.listChannels()) c.dispose();
    a.dispose();
  }
  for (const n of root.listNodes()) if (n.getMesh() && !n.getSkin() && !keep.includes(n.getName())) n.dispose();
  await doc.transform(prune(), dedup());
  await io.write(`${outDir}/${name}.glb`, doc);
}
