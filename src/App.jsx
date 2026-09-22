import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const BASE = `${import.meta.env.BASE_URL}data`;
const RAFRAICHISSEMENT = 5 * 60 * 1000;

/** Largeur d'une minute de programme, en pixels. 30 min ≈ 110 px. */
const PX_PAR_MIN = 3.1;

/**
 * Seuils d'affichage d'un bloc, en pixels. À 3,1 px la minute, un programme
 * de cinq minutes fait quinze pixels : aucun texte n'y tient. Plutôt que
 * tout ou rien, trois paliers — titre et heure, titre seul en plus petit,
 * puis rien du tout et l'infobulle prend le relais.
 */
const LARGEUR_TEXTE = 92;
const LARGEUR_TITRE = 34;
const PAS = 30; // graduation de l'axe, en minutes

/** Minutes depuis minuit UTC du jour → étiquette dans le fuseau du pays. */
function heureDe(jour, minutes, timezone) {
  const d = new Date(Date.parse(`${jour}T00:00:00Z`) + minutes * 60000);
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(d)
    .replace(":", "h");
}

/**
 * L'heure locale seule, en nombre, pour placer les raccourcis de navigation.
 *
 * Il faut passer par formatToParts : en français, `format` rend « 00 h »,
 * avec une espace insécable et la lettre h. `Number("00 h")` vaut NaN, si
 * bien qu'aucune graduation ne correspondait jamais et que les quatre
 * boutons Matin, Après-midi, Soirée et Nuit restaient désactivés.
 * Le modulo couvre les locales où minuit se note 24.
 */
function heureNombre(jour, minutes, timezone) {
  const d = new Date(Date.parse(`${jour}T00:00:00Z`) + minutes * 60000);
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = parts.find((x) => x.type === "hour");
  return h ? Number(h.value) % 24 : NaN;
}

function jourLisible(jour) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${jour}T12:00:00Z`));
}

function jourCourt(jour) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    day: "numeric",
  }).format(new Date(`${jour}T12:00:00Z`));
}

/** Minutes écoulées depuis minuit UTC du jour affiché. */
const minutesCourantes = (jour) =>
  Math.round((Date.now() - Date.parse(`${jour}T00:00:00Z`)) / 60000);

/** Heures locales visées par les raccourcis. */
const REPERES = [
  { id: "matin", label: "Matin", heure: 8 },
  { id: "aprem", label: "Après-midi", heure: 14 },
  { id: "soiree", label: "Soirée", heure: 21 },
  { id: "nuit", label: "Nuit", heure: 0 },
];

/**
 * Lecture d'une diffusion. Format actuel : [chaîne, début, durée, titre,
 * indice de genre], les genres étant listés une fois dans `g`. L'ancien
 * format portait le sous-titre et le genre en clair ; on le lit encore, pour
 * qu'une page restée en cache ne casse pas pendant la mise à jour.
 */
function lire(t, g) {
  if (g) {
    const gi = t[4];
    return [t[0], t[1], t[2], t[3], gi >= 0 ? g[gi] : null];
  }
  return [t[0], t[1], t[2], t[3], t[5] ?? null];
}

/**
 * Sélection transversale : les films eux-mêmes, où qu'ils passent.
 * Les autres catégories classent les chaînes ; celle-ci classe les
 * programmes, ce qui n'est pas la même question — un film sur TF1 n'est pas
 * sur une chaîne de cinéma.
 */
const FILMS = "__films";

/** Genres qui désignent un film, en français comme en espagnol. */
const GENRES_FILM = [
  "film", "cinema", "cinéma", "long metrage", "long métrage",
  "movie", "cine", "pelicula", "película", "largometraje", "telefilm", "téléfilm",
];

function estFilm(genre) {
  if (!genre) return false;
  const g = genre.toLowerCase();
  // « Magazine du cinéma » parle de films sans en être un.
  if (g.includes("magazine") || g.includes("actualite") || g.includes("actualité"))
    return false;
  return GENRES_FILM.some((m) => g.includes(m));
}



export default function App() {
  const [index, setIndex] = useState(null);
  const [pays, setPays] = useState(null);
  const [jour, setJour] = useState(null);
  const [grille, setGrille] = useState(null);
  const [categorie, setCategorie] = useState("toutes");
  const [recherche, setRecherche] = useState("");
  const [fiche, setFiche] = useState(null);
  const [details, setDetails] = useState({ cle: null, data: null, etat: "vide" });
  const [erreur, setErreur] = useState(null);
  const [tic, setTic] = useState(() => Date.now());
  const cache = useRef(new Map());
  const planning = useRef(null);
  const dejaCentre = useRef(false);

  /**
   * Contenu de la grille, chargé chaîne par chaîne plutôt que d'un bloc.
   * Le fichier du jour ne contient plus aucun programme (voir `charger`) :
   * seules les tranches de chaînes réellement affichées sont récupérées,
   * à la manière du guide TV de Canal+. `lots` vit dans une référence pour
   * ne pas re-rendre à chaque octet reçu ; `lotsVersion` fait le lien avec
   * React quand une tranche arrive.
   */
  const lots = useRef(new Map());
  const [lotsVersion, setLotsVersion] = useState(0);
  const lotTaille = index?.pays?.[pays]?.chunk ?? 40;
  const lotDe = useCallback((i) => Math.floor(i / lotTaille), [lotTaille]);

  const assurerLot = useCallback(
    (l) => {
      if (!pays || !jour || l < 0) return;
      const cle = `${pays}/${jour}/${l}`;
      if (lots.current.has(cle)) return; // déjà là, ou déjà en chemin
      lots.current.set(cle, undefined); // marque la place, évite un doublon
      fetch(`${BASE}/${pays}/${jour}.c${l}.json`, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : { p: [] }))
        .then((d) => {
          lots.current.set(cle, d.p ?? []);
          setLotsVersion((v) => v + 1);
        })
        .catch(() => {
          lots.current.set(cle, []);
          setLotsVersion((v) => v + 1);
        });
    },
    [pays, jour]
  );

  useEffect(() => {
    fetch(`${BASE}/index.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        setIndex(json);
        const premier = Object.keys(json.pays)[0];
        setPays(premier);
        const jours = json.pays[premier].jours;
        setJour(jours[Math.min(1, jours.length - 1)]);
      })
      .catch(() => setErreur("La grille n'a pas pu être chargée. Réessaie dans un instant."));
  }, []);

  const charger = useCallback(async (p, j) => {
    if (!p || !j) return;
    const cle = `${p}/${j}`;
    if (cache.current.has(cle)) return setGrille(cache.current.get(cle));
    setGrille(null);
    try {
      const r = await fetch(`${BASE}/${cle}.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = { ...(await r.json()), _cle: cle };
      cache.current.set(cle, json);
      setGrille(json);
    } catch {
      setErreur("Cette journée n'est pas disponible.");
    }
  }, []);

  useEffect(() => {
    charger(pays, jour);
  }, [charger, pays, jour]);

  useEffect(() => {
    const horloge = setInterval(() => setTic(Date.now()), 30000);
    const reveil = () => {
      if (document.visibilityState !== "visible") return;
      setTic(Date.now());
      cache.current.clear();
      // Les tranches déjà reçues doivent aussi tomber : une grille
      // republiée peut avoir renuméroté les chaînes, garder d'anciens lots
      // les mélangerait avec les nouveaux.
      lots.current.clear();
      setLotsVersion((v) => v + 1);
      charger(pays, jour);
    };
    const maj = setInterval(reveil, RAFRAICHISSEMENT);
    document.addEventListener("visibilitychange", reveil);
    return () => {
      clearInterval(horloge);
      clearInterval(maj);
      document.removeEventListener("visibilitychange", reveil);
    };
  }, [charger, pays, jour]);

  /**
   * Détails de la journée : résumés, distribution, épisodes. Chargés à la
   * première ouverture d'une fiche seulement — ils pèsent plusieurs fois le
   * poids de la grille, et la plupart des visites n'en ouvrent aucune.
   */
  // La clé en cours de chargement vit dans une référence, pas dans l'état :
  // la mettre dans les dépendances relançait l'effet dès qu'on marquait le
  // chargement, et le nettoyage annulait alors sa propre requête.
  const detailsDemandes = useRef(null);

  useEffect(() => {
    if (!fiche || !pays || !jour) return;
    // Une tranche de 40 chaînes par fichier : on ne charge que celle de la
    // chaîne ouverte, et on garde en mémoire celles déjà reçues.
    const tranche = Math.floor(fiche.chaine.i / 40);
    const cle = `${pays}/${jour}.${tranche}`;
    if (detailsDemandes.current === cle) return;
    detailsDemandes.current = cle;
    setDetails({ cle, data: null, etat: "charge" });
    fetch(`${BASE}/${pays}/${jour}.details.${tranche}.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d) => setDetails({ cle, data: d, etat: "pret" }))
      .catch(() => setDetails({ cle, data: {}, etat: "absent" }));
  }, [fiche, pays, jour]);

  // Échap referme la fiche, comme partout ailleurs.
  useEffect(() => {
    if (!fiche) return;
    const t = (e) => e.key === "Escape" && setFiche(null);
    document.addEventListener("keydown", t);
    return () => document.removeEventListener("keydown", t);
  }, [fiche]);

  const conf = index?.pays?.[pays];
  const prete = grille && grille._cle === `${pays}/${jour}` ? grille : null;

  /**
   * Bornes de la frise : la journée entière, ou la plage réelle d'une
   * catégorie ("Sport" ne va pas jusqu'à l'émission de nuit sur Arte).
   * Précalculées une fois pour toutes au moment du build (voir
   * scripts/build-epg.mjs), et non plus mesurées ici sur les programmes
   * chargés : les calculer côté site aurait obligé à charger le contenu de
   * toutes les chaînes avant même de savoir jusqu'où dessiner l'axe, ce qui
   * aurait annulé l'intérêt du chargement à la demande. Une recherche ne
   * resserre plus les bornes ; l'approximation est jugée préférable à devoir
   * tout charger pour l'affiner.
   */
  const bornes = useMemo(() => {
    if (!prete?.bornes) return { de: 0, a: 1440 };
    if (categorie !== "toutes" && categorie !== FILMS) {
      return prete.bornes.parCategorie[categorie] ?? prete.bornes.toutes;
    }
    return prete.bornes.toutes;
  }, [prete, categorie]);

  const largeurPiste = (bornes.a - bornes.de) * PX_PAR_MIN;
  const xDe = (min) => (min - bornes.de) * PX_PAR_MIN;

  /**
   * Plage de temps réellement posée dans le DOM. Sur 700 chaînes et 24 h,
   * tout afficher d'un coup représente des dizaines de milliers d'éléments :
   * un ordinateur encaisse, un téléphone se fait tuer par le système en
   * cours de défilement. On ne rend que la fenêtre visible, plus une
   * largeur d'écran de marge de chaque côté pour que le défilement reste
   * fluide sans laisser de trou.
   */
  const [fenetre, setFenetre] = useState({ de: -Infinity, a: Infinity });
  const [vue, setVue] = useState({ haut: 0, hauteur: 900 });

  useEffect(() => {
    const el = planning.current;
    if (!el) return;
    let raf = 0;

    /**
     * Verrouillage d'axe. Un doigt ne trace jamais une ligne parfaitement
     * droite : sans cela, faire défiler les heures décale aussi les chaînes,
     * et la grille part de biais. Dès que le geste dépasse quelques pixels,
     * on retient la direction dominante et on remet l'autre axe à sa valeur
     * de départ, à chaque événement. Le défilement natif et son inertie sont
     * conservés sur l'axe choisi ; seul le mouvement parasite est annulé.
     */
    const v = { axe: null, gauche: el.scrollLeft, haut: el.scrollTop, minuteur: 0, corrige: false };
    const SEUIL = 8;

    const verrouiller = () => {
      // Notre propre correction déclenche un événement : on l'ignore.
      if (v.corrige) {
        v.corrige = false;
      } else {
        if (v.axe === null) {
          const dx = Math.abs(el.scrollLeft - v.gauche);
          const dy = Math.abs(el.scrollTop - v.haut);
          if (Math.max(dx, dy) > SEUIL) v.axe = dx > dy ? "x" : "y";
        }
        if (v.axe === "x" && el.scrollTop !== v.haut) {
          v.corrige = true;
          el.scrollTop = v.haut;
        } else if (v.axe === "y" && el.scrollLeft !== v.gauche) {
          v.corrige = true;
          el.scrollLeft = v.gauche;
        }
      }
      // Fin du geste : on rouvre les deux axes pour le suivant.
      clearTimeout(v.minuteur);
      v.minuteur = setTimeout(() => {
        v.axe = null;
        v.gauche = el.scrollLeft;
        v.haut = el.scrollTop;
      }, 180);
    };

    const maj = () => {
      // Le verrou doit agir dans l'événement même : différé, le décalage
      // serait visible le temps d'une image.
      verrouiller();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Marge proportionnelle à l'écran : 600 px fixes, c'était une
        // largeur et demie de téléphone posée inutilement de chaque côté.
        const marge = Math.max(el.clientWidth * 0.7, 260);
        setFenetre({
          de: bornes.de + (el.scrollLeft - marge) / PX_PAR_MIN,
          a: bornes.de + (el.scrollLeft + el.clientWidth + marge) / PX_PAR_MIN,
        });
        setVue({ haut: el.scrollTop, hauteur: el.clientHeight });
      });
    };

    /**
     * Trackpad et molette. Sur macOS, le défilement est composité hors du fil
     * principal : remettre scrollTop à sa place depuis l'événement `scroll`
     * arrive trop tard, le compositeur a déjà bougé la vue et la diagonale
     * reste visible. On refuse donc le geste natif et on conduit nous-mêmes
     * le déplacement, sur le seul axe retenu.
     *
     * Plutôt que d'appliquer chaque cran sèchement, on pousse une cible que
     * la vue rejoint en s'amortissant : le mouvement garde son élan après
     * que les doigts ont quitté le trackpad, et s'arrête sans à-coup.
     */
    const cible = { x: el.scrollLeft, y: el.scrollTop, anime: 0 };
    const AMORTI = 0.2; // fraction du chemin restant parcourue par image

    const glisser = () => {
      const ecartX = cible.x - el.scrollLeft;
      const ecartY = cible.y - el.scrollTop;

      if (Math.abs(ecartX) < 0.5 && Math.abs(ecartY) < 0.5) {
        el.scrollLeft = cible.x;
        el.scrollTop = cible.y;
        cible.anime = 0;
      } else {
        el.scrollLeft += ecartX * AMORTI;
        el.scrollTop += ecartY * AMORTI;
        cible.anime = requestAnimationFrame(glisser);
      }
      // Le verrou doit suivre le mouvement qu'on produit, sinon il le
      // prendrait pour un écart à corriger.
      v.gauche = el.scrollLeft;
      v.haut = el.scrollTop;
    };

    const surMolette = (e) => {
      // deltaMode 1 compte en lignes, 2 en pages : ramené en pixels.
      const f = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dx = e.deltaX * f;
      const dy = e.deltaY * f;

      if (v.axe === null) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 1) return;
        v.axe = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }

      e.preventDefault();

      // Au repos, la cible repart de la position réelle : sans ça, un
      // défilement interrompu à la main ferait sauter la vue au reprise.
      if (!cible.anime) {
        cible.x = el.scrollLeft;
        cible.y = el.scrollTop;
      }

      const maxX = el.scrollWidth - el.clientWidth;
      const maxY = el.scrollHeight - el.clientHeight;
      if (v.axe === "x") cible.x = Math.min(Math.max(cible.x + dx, 0), maxX);
      else cible.y = Math.min(Math.max(cible.y + dy, 0), maxY);

      if (!cible.anime) cible.anime = requestAnimationFrame(glisser);

      clearTimeout(v.minuteur);
      v.minuteur = setTimeout(() => {
        v.axe = null;
        v.gauche = el.scrollLeft;
        v.haut = el.scrollTop;
      }, 180);
    };

    /**
     * Tactile. Même raison que pour le trackpad : sur iOS le défilement est
     * composité, corriger l'axe depuis l'événement `scroll` arrive après que
     * la vue a bougé, et la correction se bat avec l'inertie du système —
     * d'où les à-coups. On conduit donc le doigt nous-mêmes, puis on relance
     * un glissement dont l'élan vient de la vitesse mesurée au relâchement.
     */
    const doigt = { x: 0, y: 0, t: 0, vx: 0, vy: 0, actif: false };

    const toucheDebut = (e) => {
      if (e.touches.length !== 1) return;
      if (cible.anime) {
        cancelAnimationFrame(cible.anime);
        cible.anime = 0;
      }
      clearTimeout(v.minuteur);
      v.axe = null;
      v.gauche = el.scrollLeft;
      v.haut = el.scrollTop;

      const t = e.touches[0];
      doigt.x = t.clientX;
      doigt.y = t.clientY;
      doigt.t = performance.now();
      doigt.vx = 0;
      doigt.vy = 0;
      doigt.actif = true;
      cible.x = el.scrollLeft;
      cible.y = el.scrollTop;
    };

    const toucheBouge = (e) => {
      if (!doigt.actif || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = doigt.x - t.clientX;
      const dy = doigt.y - t.clientY;

      if (v.axe === null) {
        // Sous le seuil, on laisse faire : un simple appui ne doit rien bouger.
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
        v.axe = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }

      e.preventDefault();
      const maintenant = performance.now();
      const dt = Math.max(maintenant - doigt.t, 1);

      if (v.axe === "x") {
        el.scrollLeft += dx;
        // Vitesse lissée : une seule image de mesure serait trop nerveuse.
        doigt.vx = 0.7 * (dx / dt) + 0.3 * doigt.vx;
      } else {
        el.scrollTop += dy;
        doigt.vy = 0.7 * (dy / dt) + 0.3 * doigt.vy;
      }

      doigt.x = t.clientX;
      doigt.y = t.clientY;
      doigt.t = maintenant;
      v.gauche = el.scrollLeft;
      v.haut = el.scrollTop;
    };

    const toucheFin = () => {
      if (!doigt.actif) return;
      doigt.actif = false;

      // L'élan restant : la vitesse au moment du lâcher, projetée en avant.
      const ELAN = 160; // millisecondes de course résiduelle
      const maxX = el.scrollWidth - el.clientWidth;
      const maxY = el.scrollHeight - el.clientHeight;
      cible.x = el.scrollLeft;
      cible.y = el.scrollTop;

      if (v.axe === "x" && Math.abs(doigt.vx) > 0.05) {
        cible.x = Math.min(Math.max(el.scrollLeft + doigt.vx * ELAN, 0), maxX);
      } else if (v.axe === "y" && Math.abs(doigt.vy) > 0.05) {
        cible.y = Math.min(Math.max(el.scrollTop + doigt.vy * ELAN, 0), maxY);
      }

      if (!cible.anime) cible.anime = requestAnimationFrame(glisser);

      clearTimeout(v.minuteur);
      v.minuteur = setTimeout(() => {
        v.axe = null;
        v.gauche = el.scrollLeft;
        v.haut = el.scrollTop;
      }, 180);
    };

    // Souris : un clic remet simplement le verrou à zéro.
    const debut = () => {
      if (cible.anime) {
        cancelAnimationFrame(cible.anime);
        cible.anime = 0;
      }
      clearTimeout(v.minuteur);
      v.axe = null;
      v.gauche = el.scrollLeft;
      v.haut = el.scrollTop;
    };

    const dimension = () => {
      debut();
      maj();
    };

    maj();
    el.addEventListener("scroll", maj, { passive: true });
    el.addEventListener("wheel", surMolette, { passive: false });
    el.addEventListener("touchstart", toucheDebut, { passive: true });
    el.addEventListener("touchmove", toucheBouge, { passive: false });
    el.addEventListener("touchend", toucheFin, { passive: true });
    el.addEventListener("touchcancel", toucheFin, { passive: true });
    el.addEventListener("mousedown", debut, { passive: true });
    window.addEventListener("resize", dimension);
    return () => {
      cancelAnimationFrame(raf);
      if (cible.anime) cancelAnimationFrame(cible.anime);
      clearTimeout(v.minuteur);
      el.removeEventListener("scroll", maj);
      el.removeEventListener("wheel", surMolette);
      el.removeEventListener("touchstart", toucheDebut);
      el.removeEventListener("touchmove", toucheBouge);
      el.removeEventListener("touchend", toucheFin);
      el.removeEventListener("touchcancel", toucheFin);
      el.removeEventListener("mousedown", debut);
      window.removeEventListener("resize", dimension);
    };
  }, [bornes, prete]);

  /** Trie et range les lignes d'une catégorie, mise en avant puis numéro. */
  function ranger(lignes) {
    return lignes.sort((a, b) => {
      if (a.priorite && b.priorite) return a.priorite - b.priorite;
      if (a.priorite) return -1;
      if (b.priorite) return 1;
      if (a.numero && b.numero) return a.numero - b.numero;
      if (a.numero) return -1;
      if (b.numero) return 1;
      return a.nom.localeCompare(b.nom, "fr");
    });
  }

  function grouper(lignes, conf) {
    if (categorie !== "toutes") return [{ categorie: null, lignes }];
    const parCat = new Map();
    for (const l of lignes) {
      if (!parCat.has(l.categorie)) parCat.set(l.categorie, []);
      parCat.get(l.categorie).push(l);
    }
    return (conf.categories ?? [])
      .filter((c) => parCat.has(c))
      .map((c) => ({ categorie: c, lignes: parCat.get(c) }));
  }

  const groupes = useMemo(() => {
    if (!conf || !prete) return [];
    const q = recherche.trim().toLowerCase();

    // Films, toutes chaînes : une sélection transversale par programme, pas
    // par chaîne. Elle a besoin du contenu de tout le monde pour savoir qui
    // diffuse un film à cet instant ; un effet séparé charge alors tous les
    // lots. Les chaînes dont le lot n'est pas encore arrivé n'apparaissent
    // simplement pas encore, la liste se complète au fil des réponses.
    if (categorie === FILMS) {
      const parChaine = new Map();
      for (const [cle, tuples] of lots.current) {
        if (!cle.startsWith(`${pays}/${jour}/`) || !tuples) continue;
        for (const t of tuples) {
          const [i, debut, duree, titre, genre] = lire(t, prete.g);
          if (!estFilm(genre)) continue;
          const [nom] = conf.chaines[i] ?? ["?"];
          if (q && !nom.toLowerCase().includes(q) && !titre.toLowerCase().includes(q)) continue;
          if (!parChaine.has(i)) parChaine.set(i, []);
          parChaine.get(i).push({ debut, duree: duree || 60, titre, genre });
        }
      }
      const lignes = ranger(
        [...parChaine.entries()].map(([i, programmes]) => {
          const [nom, icone, cat, numero, priorite] =
            conf.chaines[i] ?? ["?", null, "Autres", null, null];
          return { i, nom, icone, numero, priorite, categorie: cat ?? "Autres", programmes };
        })
      );
      return [{ categorie: null, lignes }];
    }

    // Cas courant : la liste des chaînes vient des métadonnées seules, donc
    // elle est immédiate et complète sans avoir rien téléchargé. Chaque
    // chaîne garde `programmes: null` tant que sa tranche n'est pas encore
    // arrivée — un signal pour la ligne, plus bas, d'afficher une trame
    // d'attente plutôt qu'une case vide.
    const lignes = [];
    for (let i = 0; i < conf.chaines.length; i++) {
      const [nom, icone, cat, numero, priorite] = conf.chaines[i];
      if (categorie !== "toutes" && cat !== categorie) continue;
      if (q && !nom.toLowerCase().includes(q)) continue;

      const cle = `${pays}/${jour}/${lotDe(i)}`;
      const lot = lots.current.get(cle);
      const programmes = lot
        ? lot
            .filter((t) => t[0] === i)
            .map((t) => {
              const [, debut, duree, titre, genre] = lire(t, prete.g);
              return { debut, duree: duree || 60, titre, genre };
            })
        : lot === undefined && lots.current.has(cle)
          ? "attente" // requête en vol
          : null; // pas encore demandée

      lignes.push({
        i,
        nom,
        icone,
        numero: numero ?? null,
        priorite: priorite ?? null,
        categorie: cat ?? "Autres",
        programmes,
      });
    }

    return grouper(ranger(lignes), conf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conf, prete, categorie, recherche, pays, jour, lotDe, lotsVersion]);

  /**
   * Les groupes sont aplatis en une seule liste d'éléments — bandes de
   * catégorie et lignes de chaîne mêlées — pour pouvoir n'en poser dans le
   * DOM que la tranche visible. Avec 774 chaînes, créer toutes les lignes
   * d'un coup suffisait à faire tuer l'onglet par iOS, qui rechargeait la
   * page en boucle.
   */
  const items = useMemo(() => {
    const out = [];
    for (const g of groupes) {
      if (g.categorie) out.push({ type: "bande", cle: `b:${g.categorie}`, categorie: g.categorie });
      for (const l of g.lignes) out.push({ type: "ligne", cle: `l:${l.i}`, ligne: l });
    }
    return out;
  }, [groupes]);

  // Hauteurs réelles, relevées sur le premier rendu : elles dépendent de la
  // feuille de style et de la taille d'écran, les coder en dur dériverait.
  const [hauteurs, setHauteurs] = useState({ ligne: 64, bande: 58 });

  useEffect(() => {
    if (!items.length) return;
    const l = document.querySelector(".ligne");
    const b = document.querySelector(".bande");
    if (!l) return;
    const mesure = {
      ligne: Math.round(l.getBoundingClientRect().height) || 64,
      bande: b ? Math.round(b.getBoundingClientRect().height) : 0,
    };
    setHauteurs((p) =>
      p.ligne === mesure.ligne && p.bande === mesure.bande ? p : mesure
    );
  }, [items, vue.hauteur]);

  /** Position verticale cumulée de chaque élément, et hauteur totale. */
  const positions = useMemo(() => {
    const p = new Array(items.length + 1);
    p[0] = 0;
    for (let i = 0; i < items.length; i++) {
      p[i + 1] =
        p[i] + (items[i].type === "bande" ? hauteurs.bande : hauteurs.ligne);
    }
    return p;
  }, [items, hauteurs]);

  const totalHauteur = positions[items.length] ?? 0;

  /** Tranche d'éléments à rendre, avec une hauteur d'écran de marge. */
  const tranche = useMemo(() => {
    if (!items.length) return { debut: 0, fin: 0 };
    const marge = Math.max(vue.hauteur, 400);
    const haut = vue.haut - marge;
    const bas = vue.haut + vue.hauteur + marge;
    let debut = 0;
    while (debut < items.length && positions[debut + 1] < haut) debut++;
    let fin = debut;
    while (fin < items.length && positions[fin] < bas) fin++;
    return { debut, fin };
  }, [items, positions, vue]);

  /**
   * Déclenche le chargement des tranches de chaînes qui entrent dans la
   * fenêtre rendue à l'écran, plus une de marge de chaque côté pour que le
   * contenu soit déjà là quand le défilement l'amène en vue. C'est le cœur
   * du chargement à la demande : sans cet effet, `groupes` afficherait des
   * lignes vides pour toujours, faute de jamais réclamer leur contenu.
   */
  useEffect(() => {
    if (!prete || categorie === FILMS) return;
    const necessaires = new Set();
    for (let idx = tranche.debut; idx < tranche.fin; idx++) {
      const it = items[idx];
      if (it?.type === "ligne") necessaires.add(lotDe(it.ligne.i));
    }
    for (const l of [...necessaires]) {
      necessaires.add(l - 1);
      necessaires.add(l + 1);
    }
    for (const l of necessaires) assurerLot(l);
  }, [prete, categorie, items, tranche, lotDe, assurerLot]);

  /**
   * Mode transversal Films : par nature, il faut le contenu de toutes les
   * chaînes pour savoir lesquelles diffusent un film à l'instant. Le coût
   * n'est payé que par qui choisit cette vue, pas par tout le monde.
   */
  useEffect(() => {
    if (categorie !== FILMS || !conf) return;
    const nb = Math.ceil(conf.chaines.length / lotTaille);
    for (let l = 0; l < nb; l++) assurerLot(l);
  }, [categorie, conf, lotTaille, assurerLot]);

  const categoriesDispo = useMemo(() => {
    if (!conf) return [];
    const vues = new Set(conf.chaines.map((c) => c[2] ?? "Autres"));
    return (conf.categories ?? []).filter((c) => vues.has(c));
  }, [conf]);

  const graduations = useMemo(() => {
    const t = [];
    for (let m = bornes.de; m < bornes.a; m += PAS) t.push(m);
    return t;
  }, [bornes]);

  /** Amène une minute donnée un peu à gauche de la vue. */
  const allerA = useCallback((min) => {
    const el = planning.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, xDe(min) - 80), behavior: "smooth" });
  }, [bornes]);

  const maintenant = jour ? minutesCourantes(jour) : 0;
  const dansLaJournee = maintenant >= bornes.de && maintenant < bornes.a;

  // Au premier affichage d'une journée en cours, on se place sur l'heure
  // qu'il est : c'est ce que la personne vient voir.
  useEffect(() => {
    if (!prete || dejaCentre.current || !dansLaJournee) return;
    dejaCentre.current = true;
    requestAnimationFrame(() => allerA(maintenant - 15));
  }, [prete, dansLaJournee, maintenant, allerA]);

  useEffect(() => {
    dejaCentre.current = false;
  }, [pays, jour]);

  if (erreur && !index) return <Vide>{erreur}</Vide>;
  if (!index || !conf) return <Vide>Chargement de la grille…</Vide>;

  const jours = conf.jours;
  const iJour = jours.indexOf(jour);

  return (
    <div className="app">
      <header className="tete">
        <div className="tete-haut">
          <h1 className="marque">JulTV</h1>
          <div className="pays">
            {Object.entries(index.pays).map(([code, p]) => (
              <button
                key={code}
                className={code === pays ? "pays-bouton actif" : "pays-bouton"}
                onClick={() => {
                  setPays(code);
                  const js = index.pays[code].jours;
                  setJour(js.includes(jour) ? jour : js[0]);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="dates">
          <button
            className="fleche"
            onClick={() => setJour(jours[iJour - 1])}
            disabled={iJour <= 0}
            aria-label="Jour précédent"
          >
            ‹
          </button>
          <div className="dates-liste">
            {jours.map((j) => (
              <button
                key={j}
                className={j === jour ? "date actif" : "date"}
                onClick={() => setJour(j)}
              >
                {jourCourt(j)}
              </button>
            ))}
          </div>
          <button
            className="fleche"
            onClick={() => setJour(jours[iJour + 1])}
            disabled={iJour >= jours.length - 1}
            aria-label="Jour suivant"
          >
            ›
          </button>
        </div>

        <div className="outils">
          {dansLaJournee && (
            <button className="tally-bouton" onClick={() => allerA(maintenant - 15)}>
              <span className="point" />
              En direct
            </button>
          )}
          {REPERES.map((r) => {
            const cible = graduations.find((m) => heureNombre(jour, m, conf.timezone) === r.heure);
            return (
              <button
                key={r.id}
                className="repere"
                onClick={() => allerA(cible ?? bornes.de)}
                disabled={cible === undefined}
              >
                {r.label}
              </button>
            );
          })}

          <select
            className="champ"
            value={categorie}
            onChange={(e) => setCategorie(e.target.value)}
            aria-label="Catégorie"
          >
            <option value="toutes">Toutes catégories</option>
            <option value={FILMS}>Films, toutes chaînes</option>
            {categoriesDispo.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <input
            className="champ recherche"
            type="search"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Chercher une chaîne ou un programme"
            aria-label="Chercher"
          />
        </div>
      </header>

      {!prete && <Vide>Chargement de {jourLisible(jour)}…</Vide>}

      {prete && groupes.length === 0 && (
        <Vide>
          Aucune chaîne ne correspond. Élargis la catégorie ou efface la recherche.
        </Vide>
      )}

      {prete && groupes.length > 0 && (
        <div className="planning" ref={planning}>
          <div className="planning-corps" style={{ "--piste": `${largeurPiste}px` }}>
            <div className="axe">
              <div className="rail axe-coin">
                <span className="axe-jour">{jourLisible(jour)}</span>
              </div>
              <div className="piste">
                {graduations.map((m) => (
                  <span
                    key={m}
                    className={
                      heureDe(jour, m, conf.timezone).endsWith("00")
                        ? "graduation"
                        : "graduation demie"
                    }
                    style={{ left: `${xDe(m)}px` }}
                  >
                    {heureDe(jour, m, conf.timezone)}
                  </span>
                ))}
              </div>
            </div>

            {dansLaJournee && (
              <div className="tally" style={{ left: `calc(var(--rail) + ${xDe(maintenant)}px)` }}>
                <span className="tally-tete" />
              </div>
            )}

            {/* Cale haute : elle occupe la place des lignes non rendues,
                pour que la barre de défilement garde la bonne longueur. */}
            <div style={{ height: `${positions[tranche.debut] ?? 0}px` }} />

            {items.slice(tranche.debut, tranche.fin).map((it) => {
              if (it.type === "bande") {
                return (
                  <div className="bande" data-cat={it.categorie} key={it.cle}>
                    <h2 className="bande-nom">{it.categorie}</h2>
                  </div>
                );
              }
              const l = it.ligne;
              return (
                <div
                  className={l.priorite ? "ligne en-avant" : "ligne"}
                  key={it.cle}
                >
                  <div className="rail" data-cat={l.categorie}>
                    <span className="pastille" aria-hidden="true" />
                    {l.numero ? (
                      <span className="canal">{l.numero}</span>
                    ) : (
                      <span className="canal vide" aria-hidden="true" />
                    )}
                    {l.icone ? (
                      <img
                        className="logo"
                        src={l.icone}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.visibility = "hidden";
                        }}
                      />
                    ) : (
                      <span className="logo logo-texte">{l.nom.slice(0, 2)}</span>
                    )}
                    <span className="chaine">{l.nom}</span>
                  </div>

                  <div className={Array.isArray(l.programmes) ? "piste" : "piste attente"}>
                    {!Array.isArray(l.programmes) && (
                      // Tranche pas encore arrivée : une trame plutôt qu'une
                      // case vide, le temps que la requête revienne.
                      <span className="attente-barre" aria-hidden="true" />
                    )}
                    {Array.isArray(l.programmes) && l.programmes.map((p) => {
                      if (p.debut + p.duree <= fenetre.de || p.debut >= fenetre.a)
                        return null;
                      const largeur = p.duree * PX_PAR_MIN;
                      const direct =
                        maintenant >= p.debut && maintenant < p.debut + p.duree;
                      const heure = heureDe(jour, p.debut, conf.timezone);
                      const classes = ["prog"];
                      if (direct) classes.push("direct");
                      // Sous le plus petit seuil, le bloc reste visible mais
                      // muet : aligner des tranches de lettres coupées est
                      // pire que rien, et le titre reste dans l'infobulle.
                      if (largeur < LARGEUR_TITRE) classes.push("muet");
                      else if (largeur < LARGEUR_TEXTE) classes.push("serre");
                      return (
                        <article
                          key={p.debut}
                          className={classes.join(" ")}
                          style={{
                            left: `${xDe(p.debut)}px`,
                            width: `${Math.max(largeur - 2, 3)}px`,
                          }}
                          title={`${heure} — ${p.titre}${p.sousTitre ? ` · ${p.sousTitre}` : ""}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => setFiche({ ...p, chaine: l, heure, direct })}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              setFiche({ ...p, chaine: l, heure, direct });
                            }
                          }}
                        >
                          {largeur >= LARGEUR_TITRE && (
                            <>
                              {largeur >= LARGEUR_TEXTE && (
                                <span className="prog-heure">{heure}</span>
                              )}
                              <span className="prog-titre">{p.titre}</span>
                              {p.sousTitre && largeur > 190 && (
                                <span className="prog-sous">{p.sousTitre}</span>
                              )}
                            </>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Cale basse, même rôle. */}
            <div
              style={{
                height: `${Math.max(totalHauteur - (positions[tranche.fin] ?? 0), 0)}px`,
              }}
            />
          </div>
        </div>
      )}

      {fiche && (
        <Fiche
          prog={fiche}
          jour={jour}
          timezone={conf.timezone}
          details={
            details.cle === `${pays}/${jour}.${Math.floor(fiche.chaine.i / 40)}`
              ? details
              : { etat: "charge" }
          }
          onFermer={() => setFiche(null)}
        />
      )}

      <footer className="pied">
        <p>
          {conf.chaines.length} chaînes · grille reconstruite quatre fois par jour,
          dernière fois le{" "}
          {new Date(index.genereLe).toLocaleString("fr-FR", {
            dateStyle: "short",
            timeStyle: "short",
          })}
        </p>
        <p className="pied-source">
          Données XMLTV de xmltvfr.fr pour la France, grabbers iptv-org pour l'Espagne.
        </p>
      </footer>
    </div>
  );
}

function Fiche({ prog, jour, timezone, details, onFermer }) {
  const d = details.data?.[`${prog.chaine.i}:${prog.debut}`] ?? null;
  const fin = heureDe(jour, prog.debut + prog.duree, timezone);
  const h = Math.floor(prog.duree / 60);
  const m = prog.duree % 60;
  const duree = h ? `${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}` : `${m} min`;

  return (
    <div className="voile" onClick={onFermer} role="presentation">
      <div
        className="fiche"
        role="dialog"
        aria-modal="true"
        aria-label={prog.titre}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="fermer" onClick={onFermer} aria-label="Fermer">
          ×
        </button>

        <p className="fiche-chaine">
          {prog.chaine.numero && <span className="fiche-canal">{prog.chaine.numero}</span>}
          {prog.chaine.nom}
          {prog.direct && <span className="fiche-direct">en direct</span>}
        </p>

        <h2 className="fiche-titre">{prog.titre}</h2>
        {d?.sousTitre && <p className="fiche-sous">{d.sousTitre}</p>}

        <p className="fiche-horaire">
          {prog.heure} – {fin} · {duree}
        </p>

        {d?.image && (
          <img
            className="fiche-image"
            src={d.image}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}

        <ul className="etiquettes">
          {(d?.genres?.length ? d.genres : prog.genre ? [prog.genre] : []).map((g) => (
            <li key={g} className="etiquette">{g}</li>
          ))}
          {d?.annee && <li className="etiquette">{d.annee}</li>}
          {d?.rediffusion && <li className="etiquette">Rediffusion</li>}
          {d?.avis && <li className="etiquette">{d.avis}</li>}
        </ul>

        {details.etat === "charge" && <p className="fiche-etat">Chargement des détails…</p>}

        {d?.serie?.length > 0 && (
          <ol className="fiche-serie">
            {d.serie.map((ligne, k) => (
              <li key={k}>{ligne}</li>
            ))}
          </ol>
        )}

        {d?.episode && <p className="fiche-episode">{d.episode}</p>}
        {d?.resume && <p className="fiche-resume">{d.resume}</p>}

        {(d?.realisateur || d?.acteurs?.length || d?.pays || d?.note) && (
          <dl className="fiche-infos">
            {d.realisateur && (
              <>
                <dt>Réalisation</dt>
                <dd>{d.realisateur}</dd>
              </>
            )}
            {d.acteurs?.length > 0 && (
              <>
                <dt>Avec</dt>
                <dd>{d.acteurs.join(", ")}</dd>
              </>
            )}
            {d.pays && (
              <>
                <dt>Pays</dt>
                <dd>{d.pays}</dd>
              </>
            )}
            {d.note && (
              <>
                <dt>Note</dt>
                <dd>{d.note}</dd>
              </>
            )}
          </dl>
        )}

        {details.etat !== "charge" && !d?.resume && !d?.serie && !d?.episode && (
          <p className="fiche-etat">
            Cette source ne fournit pas de description pour ce programme.
          </p>
        )}
      </div>
    </div>
  );
}

function Vide({ children }) {
  return (
    <div className="app">
      <p className="etat">{children}</p>
    </div>
  );
}
