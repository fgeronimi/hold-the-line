# Fiche de test de jeu

Pour faire jouer 2 ou 3 personnes et savoir, avant d'ajouter du contenu, si le jeu se
comprend, si les vagues sont bien dosées et si une partie tient dans le temps visé
(15 minutes par scénario, décision B4).

## Ce qu'on veut apprendre

1. **Comprendre** : le joueur sait-il ce qu'on attend de lui à chaque vague, et pourquoi
   il a perdu ?
2. **Dosage** : combien d'essais par vague, où ça bloque, est-ce qu'une vague se gagne
   « par hasard » ?
3. **Durée** : temps de construction par vague, durée totale d'un scénario.
4. **Apprendre** : en sortant, le joueur sait-il dire à quoi servent un cache, une file,
   un circuit breaker ?

## Qui faire jouer

Des développeurs qui ne sont pas experts en system design : c'est la cible. Éviter les
proches qui connaissent déjà le jeu. Une personne à la fois.

## Préparer

- Ouvrir **https://fgeronimi.github.io/hold-the-line/**.
- Sur une machine déjà utilisée : menu ☰ → *Nouvelle partie* sur chaque scénario, pour
  repartir de la vague 1.
- Un chronomètre, cette fiche imprimée ou ouverte à côté, de quoi noter. Le jeu ne
  mesure rien lui-même : temps et essais se relèvent dans la grille.

## Consignes au joueur (à lire tel quel)

> « Je teste le jeu, pas toi. Joue comme tu le ferais seul, et dis à voix haute ce que tu
> penses : ce que tu cherches, ce que tu crois que ça fait, ce qui t'étonne. Je ne
> t'aiderai pas pendant la partie ; si tu es bloqué plus de trois minutes, dis-le, et on
> en parlera. »

Ensuite, **ne pas aider**. Pas de « clique là », pas de « c'est la file ». Un silence
gêné est une donnée.

## Déroulé (45 minutes)

| Temps | Quoi |
|---|---|
| 0–3 min | Consignes, lancement, choix du scénario : laisser le joueur choisir. |
| 3–25 min | *Les portes de la cité*, les 5 vagues si possible. |
| 25–40 min | Un second scénario, au choix du joueur (*Le grand marché*, *Le banquier lombard* ou *Le grand tournoi*), autant de vagues que le temps le permet. |
| 40–45 min | Questions de fin. |

Arrêter un scénario si une vague dépasse 10 minutes : c'est déjà une réponse.

## Grille d'observation, vague par vague

Noter à chaque lancement l'heure et l'architecture en deux mots (« serveur + cache »),
et à la fin de la vague le nombre d'essais et les étoiles affichées au debrief.

| Vague | Début | Lancée à | A lu le briefing ? | Essais | Architectures essayées | Blocage (où, combien de temps) | A compris pourquoi il a perdu ? | Ce qu'il a dit |
|---|---|---|---|---|---|---|---|---|
| 1 | | | oui / survolé / non | | | | oui / en partie / non | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |

## Ce qu'il faut guetter

Noter l'heure et la phrase exacte quand l'un de ces moments arrive :

- **Construction** : ne trouve pas comment poser ou relier ; pose sur la rivière ; ne voit
  ne remarque pas les pastilles d’évolution au pied du bâtiment sélectionné (scaling, réplicas, idempotence…) ; lit ou saute les fiches qui s’ouvrent sur une case vide ;
  glisse un bâtiment sur un chemin et s'étonne du lien créé.
- **Le chambellan** : lit la ligne « En vrai » ou seulement la métaphore ; saute le
  briefing ; relit le briefing (bouton 🎩).
- **La vague** : regarde le plateau ou la barre du bas ; ouvre les courbes ; remarque
  les alertes (saturation, sablier, feu, barrière, cloche du SLA).
- **Le debrief** : le lit ou clique tout de suite « Réessayer » ; applique la parade
  proposée ; dit la notion à voix haute (« ah, il faut un cache »).
- **Les chiffres** : calcule une capacité (« 900 lectures, la base en tient 600 ») ou
  essaie au hasard.
- **Les étoiles** : rejoue une vague gagnée pour l'étoile d'économie.
- **Frustration** : soupir, « c'est injuste », « je ne vois pas ce qui change ».

## Questions de fin

1. En une phrase : de quoi parle ce jeu ?
2. Quelle vague t'a le plus appris, et laquelle t'a le plus agacé ? Pourquoi ?
3. Quand tu perdais, savais-tu quoi changer ? Qu'est-ce qui te l'a dit ?
4. Explique-moi, sans le jeu, à quoi sert : un cache, une file de messages, un circuit
   breaker, un backoff (selon les scénarios joués).
5. La métaphore de la cité t'a aidé, gêné, ou tu l'as ignorée ?
6. Tu y rejouerais seul ? Qu'est-ce qui t'en empêcherait ?

## Lire les résultats

Après chaque test, relire la grille :

- **Plus de 3 essais sur une vague** : la vague est mal expliquée ou mal dosée. Relire
  les architectures essayées : le joueur tourne-t-il en rond, ou converge-t-il ?
- **Plus de 5 minutes de construction sur une vague** : chercher dans la grille ce qu'il
  cherchait (l'interface, ou la réponse ?).
- **Gagnée du premier coup avec une architecture inattendue** : une stratégie que
  l'équilibrage n'a pas prévue ; la rejouer avec `npm run balance` ou les tests.
- **Perdue, puis gagnée sans changer l'idée** (juste plus d'instances) : la vague se
  gagne en gonflant, pas en comprenant.
- **Durée totale d'un scénario au-delà de 20 minutes** : retirer des vagues plutôt que
  d'écourter le debrief (B4).
- **Question 4 ratée** alors que la vague correspondante est gagnée : le jeu fait gagner
  sans faire comprendre ; revoir la leçon du debrief et la ligne « En vrai ».

Consigner les conclusions dans `docs/decisions.md`, avec le pourquoi, comme le reste.
