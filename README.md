# Grille TV — France & Espagne

Toutes les chaînes, tous bouquets confondus, 24 h sur 24. Hébergé gratuitement sur GitHub Pages, reconstruit quatre fois par jour par GitHub Actions. Aucun serveur, aucun abonnement.

## Ce que ça couvre

**France** — le XMLTV de [xmltvfr.fr](https://xmltvfr.fr) : environ 785 chaînes francophones, TNT gratuite, Canal+, beIN, Ciné+, OCS, et les bouquets Orange, Free, SFR et Bouygues.

**Espagne** — les grabbers [iptv-org/epg](https://github.com/iptv-org/epg) sur trois sites : Movistar Plus+ (TDT et tous ses bouquets), El País (généralistes et autonomiques) et tvtoday (complément câble/satellite). Les trois se recoupent, ce qui comble les trous de chacun.

## Comment ça marche

Un workflow cron télécharge les sources, les parse, et écrit des JSON compacts dans `public/data/`. Vite construit le front par-dessus, et le tout part sur Pages. Il n'y a jamais de calcul à la demande : le site est entièrement statique.

Le format des diffusions est un tableau de tuples `[chaîne, début, durée, titre, sous-titre, genre]` plutôt qu'un tableau d'objets. Sur 700 chaînes × 24 h, les noms de clés répétés pèseraient plus lourd que les données. Les chaînes sont référencées par leur position dans un index, et les horaires en minutes depuis minuit. Résultat : une journée complète tient dans un fichier que le navigateur charge sans broncher.

Le front ne télécharge que la journée affichée, et la garde en cache pour la session.

## Mise en route

1. Crée un dépôt, pousse ces fichiers sur `main`.
2. Dans **Settings → Pages**, choisis **GitHub Actions** comme source.
3. Onglet **Actions**, lance « Grille TV » à la main une première fois.

Le premier build prend 30 à 60 minutes : les grabbers espagnols interrogent les sites page par page. Les suivants tournent tout seuls à 01h20, 07h20, 13h20 et 19h20 UTC.

## À vérifier avant le premier lancement

**L'URL du XMLTV français.** `scripts/sources.json` pointe vers `https://xmltvfr.fr/xmltv/xmltv.xml.gz`. **Cette URL est à confirmer** : sur [xmltvfr.fr/xmltv.php](https://xmltvfr.fr/xmltv.php) le lien est injecté en JavaScript, donc je n'ai pas pu la vérifier. Clique sur « Copier l'URL » pour la version complète et compare. Si elle diffère, corrige le fichier, ou définis la variable de dépôt `XMLTV_FR_URL` dans **Settings → Secrets and variables → Actions → Variables**.

Le fichier complet fait environ 16 Mo compressés. Si le build manque de mémoire, bascule sur le fichier TNT seul, nettement plus léger.

## Régler la couverture

Tout se passe dans `scripts/sources.json`. Ajouter une source, c'est ajouter une entrée :

```json
{ "type": "url", "name": "mon-flux", "url": "https://…/guide.xml.gz" }
```

Pour un pays de plus, ajoute une clé au même niveau que `fr` et `es`, avec son fuseau et ses sources. Le builder et le front s'adaptent sans autre modification — un onglet apparaît.

Les sites disponibles pour les grabbers sont listés dans le dépôt iptv-org/epg, un dossier par site.

## Ce qu'il faut savoir

**Une source qui tombe ne fait pas échouer le build.** Elle est signalée dans les logs et ignorée. En revanche, si aucun pays ne produit de données, le build s'arrête plutôt que de publier une grille vide.

**Les journées périmées sont purgées** à chaque passage : on garde depuis hier. Sans ça le dépôt grossirait indéfiniment.

**Soyons corrects avec les sources.** xmltvfr.fr est un projet bénévole qui paie sa bande passante, et les grabbers interrogent de vrais sites. Quatre passages par jour, c'est raisonnable. Ne descends pas sous l'heure, et garde les fichiers compressés.

## Limites connues

- **Le tri des chaînes est alphabétique.** Pour l'ordre de la télécommande (TF1 en 1, La 1 en 1 côté espagnol), il faudrait une table de correspondance : les identifiants XMLTV ne portent pas le numéro de canal.
- **Pas de filtre par bouquet.** Toutes les chaînes sont dans le même sac ; la recherche par nom compense. Un vrai filtre demanderait de mapper chaque chaîne à son opérateur, information absente des flux.
- **La qualité espagnole dépend des grabbers**, qui scrapent des sites et cassent quand ceux-ci changent. C'est pour ça qu'il y en a trois. Si l'Espagne se vide un jour, c'est presque sûrement là qu'il faut regarder.
