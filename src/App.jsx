import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/*
 * JulTV — grille TV France / Espagne.
 *
 * Architecture volontairement simple : un fichier par jour, chargé d'un
 * bloc ; le défilement est celui du navigateur ; seuls les programmes dans
 * la plage horaire visible sont posés dans la page. C'est ce dernier point,
 * et lui seul, qui compte pour la fluidité — le reste relève du confort.
 */

const BASE = `${import.meta.env.BASE_URL}data`;
const RAFRAICHISSEMENT = 5 * 60 * 1000;
const PX_PAR_MIN = 3.1; // 30 minutes ≈ 93 px
const PAS = 30; // graduation de l'axe, en minutes

// Paliers d'affichage d'un bloc : heure et titre, titre seul, ou rien.
const LARGEUR_TEXTE = 92;
const LARGEUR_TITRE = 34;

const REPERES = [
  { id: "matin", label: "Matin", heure: 8 },
  { id: "aprem", label: "Après-midi", heure: 14 },
  { id: "soiree", label: "Soirée", heure: 21 },
  { id: "nuit", label: "Nuit", heure: 0 },
];

// ------------------------------------------------------------------ dates

const aDate = (jour, minutes) =>
  new Date(Date.parse(`${jour}T00:00:00Z`) + minutes * 60000);

function heureDe(jour, minutes, tz) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" })
    .format(aDate(jour, minutes))
    .replace(":", "h");
}

/** formatToParts : en français, `format` rend « 00 h », que Number ne lit pas. */
function heureNombre(jour, minutes, tz) {
  const h = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", hour12: false })
    .formatToParts(aDate(jour, minutes))
    .find((x) => x.type === "hour");
  return h ? Number(h.value) % 24 : NaN;
}

const jourLisible = (jour) =>
  new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(`${jour}T12:00:00Z`)
  );

const jourCourt = (jour) =>
  new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric" }).format(
    new Date(`${jour}T12:00:00Z`)
  );

const minutesCourantes = (jour) =>
  Math.round((Date.now() - Date.parse(`${jour}T00:00:00Z`)) / 60000);

// ------------------------------------------------------------------ films

/** Sélection transversale : les films eux-mêmes, quelle que soit la chaîne. */
const FILMS = "__films";
const GENRES_FILM = ["film", "cinema", "cinéma", "long metrage", "long métrage", "movie",
  "cine", "pelicula", "película", "largometraje", "telefilm", "téléfilm"];

function estFilm(genre) {
  if (!genre) return false;
  const g = genre.toLowerCase();
  if (g.includes("magazine") || g.includes("actualit")) return false;
  return GENRES_FILM.some((m) => g.includes(m));
}

// -------------------------------------------------------------------- app

export default function App() {
  const [index, setIndex] = useState(null);
  const [pays, setPays] = useState(null);
  const [jour, setJour] = useState(null);
  const [grille, setGrille] = useState(null);
  const [categorie, setCategorie] = useState("toutes");
  const [recherche, setRecherche] = useState("");
  const [fiche, setFiche] = useState(null);
  const [details, setDetails] = useState({});
  const [erreur, setErreur] = useState(null);
  const [, setTic] = useState(() => Date.now()); // fait avancer la barre « en direct »
  const [fenetre, setFenetre] = useState({ de: -Infinity, a: Infinity });

  const cache = useRef(new Map());
  const planning = useRef(null);
  const dejaCentre = useRef(false);

  // Index : pays, jours, chaînes.
  useEffect(() => {
    fetch(`${BASE}/index.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => {
        setIndex(json);
        const premier = Object.keys(json.pays)[0];
        setPays(premier);
        const jours = json.pays[premier].jours;
        setJour(jours[Math.min(1, jours.length - 1)]);
      })
      .catch(() => setErreur("La grille n'a pas pu être chargée. Réessaie dans un instant."));
  }, []);

  // Journée : un seul fichier, gardé en mémoire le temps de la visite.
  const charger = useCallback(async (p, j, forcer = false) => {
    if (!p || !j) return;
    const cle = `${p}/${j}`;
    if (!forcer && cache.current.has(cle)) return setGrille(cache.current.get(cle));
    try {
      const r = await fetch(`${BASE}/${cle}.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error();
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

  // Heure courante toutes les 30 s, grille revérifiée toutes les 5 min.
  useEffect(() => {
    const horloge = setInterval(() => setTic(Date.now()), 30000);
    const maj = () => {
      if (document.visibilityState !== "visible") return;
      setTic(Date.now());
      charger(pays, jour, true);
    };
    const minuteur = setInterval(maj, RAFRAICHISSEMENT);
    document.addEventListener("visibilitychange", maj);
    return () => {
      clearInterval(horloge);
      clearInterval(minuteur);
      document.removeEventListener("visibilitychange", maj);
    };
  }, [charger, pays, jour]);

  // Détails d'une fiche : chargés à la première ouverture seulement.
  useEffect(() => {
    if (!fiche) return;
    const cle = `${pays}/${jour}`;
    if (details[cle]) return;
    setDetails((d) => ({ ...d, [cle]: "charge" }));
    fetch(`${BASE}/${cle}.details.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((data) => setDetails((d) => ({ ...d, [cle]: data })));
  }, [fiche, pays, jour, details]);

  useEffect(() => {
    if (!fiche) return;
    const t = (e) => e.key === "Escape" && setFiche(null);
    document.addEventListener("keydown", t);
    return () => document.removeEventListener("keydown", t);
  }, [fiche]);

  const conf = index?.pays?.[pays];
  const prete = grille && grille._cle === `${pays}/${jour}` ? grille : null;

  // Lignes affichées : filtrées, triées, regroupées par catégorie.
  const groupes = useMemo(() => {
    if (!conf || !prete) return [];
    const q = recherche.trim().toLowerCase();
    const g = prete.g ?? [];
    const parChaine = new Map();

    for (const t of prete.p) {
      const [i, debut, duree, titre, gi] = t;
      const genre = g ? (gi >= 0 ? g[gi] : null) : t[5];
      const [nom, , cat] = conf.chaines[i] ?? ["?", null, "Autres"];

      if (categorie === FILMS) {
        if (!estFilm(genre)) continue;
      } else if (categorie !== "toutes" && cat !== categorie) continue;
      if (q && !nom.toLowerCase().includes(q) && !titre.toLowerCase().includes(q)) continue;

      if (!parChaine.has(i)) parChaine.set(i, []);
      parChaine.get(i).push({ debut, duree: duree || 60, titre, genre });
    }

    const lignes = [...parChaine.entries()]
      .map(([i, programmes]) => {
        const [nom, icone, cat, numero, priorite] = conf.chaines[i];
        return { i, nom, icone, categorie: cat ?? "Autres", numero, priorite, programmes };
      })
      .sort((a, b) => {
        if (a.priorite && b.priorite) return a.priorite - b.priorite;
        if (a.priorite || b.priorite) return a.priorite ? -1 : 1;
        if (a.numero && b.numero) return a.numero - b.numero;
        if (a.numero || b.numero) return a.numero ? -1 : 1;
        return a.nom.localeCompare(b.nom, "fr");
      });

    if (categorie !== "toutes") return [{ categorie: null, lignes }];
    const parCat = new Map();
    for (const l of lignes) {
      if (!parCat.has(l.categorie)) parCat.set(l.categorie, []);
      parCat.get(l.categorie).push(l);
    }
    return (conf.categories ?? []).filter((c) => parCat.has(c)).map((c) => ({ categorie: c, lignes: parCat.get(c) }));
  }, [conf, prete, categorie, recherche]);

  // Bornes de la frise : du premier au dernier programme affiché.
  const bornes = useMemo(() => {
    let de = Infinity;
    let a = -Infinity;
    for (const gr of groupes)
      for (const l of gr.lignes)
        for (const p of l.programmes) {
          if (p.debut < de) de = p.debut;
          if (p.debut + p.duree > a) a = p.debut + p.duree;
        }
    if (de === Infinity) return { de: 0, a: 1440 };
    return { de: Math.floor(de / PAS) * PAS, a: Math.ceil(a / PAS) * PAS };
  }, [groupes]);

  const largeurPiste = (bornes.a - bornes.de) * PX_PAR_MIN;
  const xDe = (min) => (min - bornes.de) * PX_PAR_MIN;

  /*
   * Seuls les programmes de la plage horaire visible sont posés dans la
   * page, plus une largeur d'écran de marge de chaque côté. C'est ce qui
   * garde la grille légère : sans ce tri, chaque chaîne poserait ses
   * programmes des 24 heures, soit des milliers d'éléments inutiles.
   */
  useEffect(() => {
    const el = planning.current;
    if (!el) return;
    let raf = 0;
    const maj = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const marge = el.clientWidth / 2; // une demi-largeur d'écran de marge suffit
        setFenetre({
          de: bornes.de + (el.scrollLeft - marge) / PX_PAR_MIN,
          a: bornes.de + (el.scrollLeft + el.clientWidth + marge) / PX_PAR_MIN,
        });
      });
    };
    maj();
    el.addEventListener("scroll", maj, { passive: true });
    window.addEventListener("resize", maj);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", maj);
      window.removeEventListener("resize", maj);
    };
  }, [bornes, prete]);

  const graduations = useMemo(() => {
    const t = [];
    for (let m = bornes.de; m < bornes.a; m += PAS) t.push(m);
    return t;
  }, [bornes]);

  const allerA = useCallback(
    (min) => planning.current?.scrollTo({ left: Math.max(0, xDe(min) - 80), behavior: "smooth" }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bornes]
  );

  const maintenant = jour ? minutesCourantes(jour) : 0;
  const dansLaJournee = maintenant >= bornes.de && maintenant < bornes.a;

  // À l'ouverture d'une journée en cours, on se place sur l'heure qu'il est.
  useEffect(() => {
    dejaCentre.current = false;
  }, [pays, jour]);
  useEffect(() => {
    if (!prete || dejaCentre.current || !dansLaJournee) return;
    dejaCentre.current = true;
    requestAnimationFrame(() => allerA(maintenant - 15));
  }, [prete, dansLaJournee, maintenant, allerA]);

  const categoriesDispo = useMemo(() => {
    if (!conf) return [];
    const vues = new Set(conf.chaines.map((c) => c[2] ?? "Autres"));
    return (conf.categories ?? []).filter((c) => vues.has(c));
  }, [conf]);

  if (erreur && !index) return <Vide>{erreur}</Vide>;
  if (!index || !conf) return <Vide>Chargement de la grille…</Vide>;

  const jours = conf.jours;
  const iJour = jours.indexOf(jour);
  const nbLignes = groupes.reduce((n, g) => n + g.lignes.length, 0);

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
          <button className="fleche" onClick={() => setJour(jours[iJour - 1])} disabled={iJour <= 0} aria-label="Jour précédent">‹</button>
          <div className="dates-liste">
            {jours.map((j) => (
              <button key={j} className={j === jour ? "date actif" : "date"} onClick={() => setJour(j)}>
                {jourCourt(j)}
              </button>
            ))}
          </div>
          <button className="fleche" onClick={() => setJour(jours[iJour + 1])} disabled={iJour >= jours.length - 1} aria-label="Jour suivant">›</button>
        </div>

        <div className="outils">
          {dansLaJournee && (
            <button className="tally-bouton" onClick={() => allerA(maintenant - 15)}>
              <span className="point" />
              En direct
            </button>
          )}
          <select className="champ" value={categorie} onChange={(e) => setCategorie(e.target.value)} aria-label="Catégorie">
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
            placeholder="Chaîne ou programme"
            aria-label="Chercher"
          />
          {REPERES.map((r) => {
            const cible = prete && graduations.find((m) => heureNombre(jour, m, conf.timezone) === r.heure);
            return (
              <button key={r.id} className="repere" onClick={() => allerA(cible)} disabled={cible === undefined || !prete}>
                {r.label}
              </button>
            );
          })}
        </div>
      </header>

      {!prete && <Vide>Chargement de {jourLisible(jour)}…</Vide>}
      {prete && nbLignes === 0 && <Vide>Aucune chaîne ne correspond. Élargis la catégorie ou efface la recherche.</Vide>}

      {prete && nbLignes > 0 && (
        <div className="planning" ref={planning}>
          <div className="planning-corps" style={{ "--piste": `${largeurPiste}px` }}>
            <div className="axe">
              <div className="rail axe-coin">
                <span className="axe-jour">{jourLisible(jour)}</span>
              </div>
              <div className="piste">
                {graduations.map((m) => {
                  const h = heureDe(jour, m, conf.timezone);
                  return (
                    <span key={m} className={h.endsWith("00") ? "graduation" : "graduation demie"} style={{ left: `${xDe(m)}px` }}>
                      {h}
                    </span>
                  );
                })}
              </div>
            </div>

            {dansLaJournee && (
              <div className="tally" style={{ left: `calc(var(--rail) + ${xDe(maintenant)}px)` }}>
                <span className="tally-tete" />
              </div>
            )}

            {groupes.map((g) => (
              <section key={g.categorie ?? "tout"}>
                {g.categorie && (
                  <div className="bande" data-cat={g.categorie}>
                    <h2 className="bande-nom">{g.categorie}</h2>
                  </div>
                )}
                {g.lignes.map((l) => (
                  <Ligne
                    key={l.i}
                    l={l}
                    jour={jour}
                    tz={conf.timezone}
                    fenetre={fenetre}
                    maintenant={maintenant}
                    xDe={xDe}
                    onOuvrir={setFiche}
                  />
                ))}
              </section>
            ))}
          </div>
        </div>
      )}

      {fiche && (
        <Fiche
          prog={fiche}
          jour={jour}
          tz={conf.timezone}
          details={details[`${pays}/${jour}`]}
          onFermer={() => setFiche(null)}
        />
      )}

      <footer className="pied">
        <p>
          {conf.chaines.length} chaînes · mise à jour le{" "}
          {new Date(index.genereLe).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
        </p>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ ligne

function Ligne({ l, jour, tz, fenetre, maintenant, xDe, onOuvrir }) {
  return (
    <div className={l.priorite ? "ligne en-avant" : "ligne"}>
      <div className="rail" data-cat={l.categorie}>
        <span className="pastille" aria-hidden="true" />
        {l.numero ? <span className="canal">{l.numero}</span> : <span className="canal vide" aria-hidden="true" />}
        {l.icone ? (
          <img className="logo" src={l.icone} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
        ) : (
          <span className="logo logo-texte">{l.nom.slice(0, 2)}</span>
        )}
        <span className="chaine">{l.nom}</span>
      </div>

      <div className="piste">
        {l.programmes.map((p) => {
          if (p.debut + p.duree <= fenetre.de || p.debut >= fenetre.a) return null;
          const largeur = p.duree * PX_PAR_MIN;
          const direct = maintenant >= p.debut && maintenant < p.debut + p.duree;
          const heure = heureDe(jour, p.debut, tz);
          const cls = ["prog"];
          if (direct) cls.push("direct");
          if (largeur < LARGEUR_TITRE) cls.push("muet");
          else if (largeur < LARGEUR_TEXTE) cls.push("serre");
          const ouvrir = () => onOuvrir({ ...p, chaine: l, heure, direct });
          return (
            <article
              key={p.debut}
              className={cls.join(" ")}
              style={{ left: `${xDe(p.debut)}px`, width: `${Math.max(largeur - 2, 3)}px` }}
              title={`${heure} — ${p.titre}`}
              role="button"
              tabIndex={0}
              onClick={ouvrir}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), ouvrir())}
            >
              {largeur >= LARGEUR_TITRE && (
                <>
                  {largeur >= LARGEUR_TEXTE && <span className="prog-heure">{heure}</span>}
                  <span className="prog-titre">{p.titre}</span>
                </>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fiche

function Fiche({ prog, jour, tz, details, onFermer }) {
  const d = details && details !== "charge" ? details[`${prog.chaine.i}:${prog.debut}`] : null;
  const fin = heureDe(jour, prog.debut + prog.duree, tz);
  const h = Math.floor(prog.duree / 60);
  const m = prog.duree % 60;
  const duree = h ? `${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}` : `${m} min`;

  return (
    <div className="voile" onClick={onFermer} role="presentation">
      <div className="fiche" role="dialog" aria-modal="true" aria-label={prog.titre} onClick={(e) => e.stopPropagation()}>
        <button className="fermer" onClick={onFermer} aria-label="Fermer">×</button>

        <p className="fiche-chaine">
          {prog.chaine.numero && <span className="fiche-canal">{prog.chaine.numero}</span>}
          {prog.chaine.nom}
          {prog.direct && <span className="fiche-direct">en direct</span>}
        </p>
        <h2 className="fiche-titre">{prog.titre}</h2>
        {d?.sousTitre && <p className="fiche-sous">{d.sousTitre}</p>}
        <p className="fiche-horaire">{prog.heure} – {fin} · {duree}</p>

        {d?.image && <img className="fiche-image" src={d.image} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />}

        <ul className="etiquettes">
          {(d?.genres?.length ? d.genres : prog.genre ? [prog.genre] : []).map((g) => (
            <li key={g} className="etiquette">{g}</li>
          ))}
          {d?.annee && <li className="etiquette">{d.annee}</li>}
          {d?.rediffusion && <li className="etiquette">Rediffusion</li>}
          {d?.avis && <li className="etiquette">{d.avis}</li>}
        </ul>

        {details === "charge" && <p className="fiche-etat">Chargement des détails…</p>}

        {d?.serie?.length > 0 && (
          <ol className="fiche-serie">
            {d.serie.map((ligne, k) => <li key={k}>{ligne}</li>)}
          </ol>
        )}
        {d?.episode && <p className="fiche-episode">{d.episode}</p>}
        {d?.resume && <p className="fiche-resume">{d.resume}</p>}

        {(d?.realisateur || d?.acteurs?.length || d?.pays || d?.note) && (
          <dl className="fiche-infos">
            {d.realisateur && <><dt>Réalisation</dt><dd>{d.realisateur}</dd></>}
            {d.acteurs?.length > 0 && <><dt>Avec</dt><dd>{d.acteurs.join(", ")}</dd></>}
            {d.pays && <><dt>Pays</dt><dd>{d.pays}</dd></>}
            {d.note && <><dt>Note</dt><dd>{d.note}</dd></>}
          </dl>
        )}

        {details && details !== "charge" && !d?.resume && !d?.serie && !d?.episode && (
          <p className="fiche-etat">Cette source ne fournit pas de description pour ce programme.</p>
        )}
      </div>
    </div>
  );
}

function Vide({ children }) {
  return <p className="etat">{children}</p>;
}
