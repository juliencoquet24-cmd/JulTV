import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const BASE = `${import.meta.env.BASE_URL}data`;
const RAFRAICHISSEMENT = 5 * 60 * 1000;

/** Largeur d'une minute de programme, en pixels. 30 min ≈ 110 px. */
const PX_PAR_MIN = 3.1;

/** En dessous, le bloc est trop étroit pour porter du texte lisible. */
const LARGEUR_TEXTE = 52;
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

/** L'heure locale seule, en nombre, pour placer les raccourcis de navigation. */
function heureNombre(jour, minutes, timezone) {
  const d = new Date(Date.parse(`${jour}T00:00:00Z`) + minutes * 60000);
  const p = new Intl.DateTimeFormat("fr-FR", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  }).format(d);
  return Number(p);
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

export default function App() {
  const [index, setIndex] = useState(null);
  const [pays, setPays] = useState(null);
  const [jour, setJour] = useState(null);
  const [grille, setGrille] = useState(null);
  const [categorie, setCategorie] = useState("toutes");
  const [recherche, setRecherche] = useState("");
  const [erreur, setErreur] = useState(null);
  const [tic, setTic] = useState(() => Date.now());
  const cache = useRef(new Map());
  const planning = useRef(null);
  const dejaCentre = useRef(false);

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

  const conf = index?.pays?.[pays];
  const prete = grille && grille._cle === `${pays}/${jour}` ? grille : null;

  // Bornes réelles de la journée : selon le fuseau, minuit local ne tombe pas
  // sur la minute 0, et les programmes de nuit débordent au-delà de 24 h.
  const bornes = useMemo(() => {
    if (!prete?.p?.length) return { de: 0, a: 1440 };
    let de = Infinity;
    let a = -Infinity;
    for (const [, debut, duree] of prete.p) {
      if (debut < de) de = debut;
      const fin = debut + (duree || 60);
      if (fin > a) a = fin;
    }
    return { de: Math.floor(de / PAS) * PAS, a: Math.ceil(a / PAS) * PAS };
  }, [prete]);

  const largeurPiste = (bornes.a - bornes.de) * PX_PAR_MIN;
  const xDe = (min) => (min - bornes.de) * PX_PAR_MIN;

  const groupes = useMemo(() => {
    if (!conf || !prete) return [];

    const q = recherche.trim().toLowerCase();
    const parChaine = new Map();

    for (const [i, debut, duree, titre, sousTitre, genre] of prete.p) {
      const [nom, , cat] = conf.chaines[i] ?? ["?", null, "Autres"];
      if (categorie !== "toutes" && cat !== categorie) continue;
      if (q && !nom.toLowerCase().includes(q) && !titre.toLowerCase().includes(q)) continue;
      if (!parChaine.has(i)) parChaine.set(i, []);
      parChaine.get(i).push({ debut, duree: duree || 60, titre, sousTitre, genre });
    }

    const lignes = [...parChaine.entries()]
      .map(([i, programmes]) => {
        const [nom, icone, cat, numero, priorite] =
          conf.chaines[i] ?? ["?", null, "Autres", null, null];
        return {
          i,
          nom,
          icone,
          numero: numero ?? null,
          priorite: priorite ?? null,
          categorie: cat ?? "Autres",
          programmes,
        };
      })
      .sort((a, b) => {
        if (a.priorite && b.priorite) return a.priorite - b.priorite;
        if (a.priorite) return -1;
        if (b.priorite) return 1;
        if (a.numero && b.numero) return a.numero - b.numero;
        if (a.numero) return -1;
        if (b.numero) return 1;
        return a.nom.localeCompare(b.nom, "fr");
      });

    if (categorie !== "toutes") return [{ categorie: null, lignes }];

    const parCat = new Map();
    for (const l of lignes) {
      if (!parCat.has(l.categorie)) parCat.set(l.categorie, []);
      parCat.get(l.categorie).push(l);
    }
    return (conf.categories ?? [])
      .filter((c) => parCat.has(c))
      .map((c) => ({ categorie: c, lignes: parCat.get(c) }));
  }, [conf, prete, categorie, recherche]);

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

            {groupes.map((g) => (
              <section key={g.categorie ?? "tout"} className="bloc">
                {g.categorie && (
                  <div className="bande" data-cat={g.categorie}>
                    <h2 className="bande-nom">{g.categorie}</h2>
                  </div>
                )}

                {g.lignes.map((l) => (
                  <div
                    className={l.priorite ? "ligne en-avant" : "ligne"}
                    key={l.i}
                  >
                    <div className="rail" data-cat={l.categorie}>
                      <span className="pastille" aria-hidden="true" />
                      {l.numero ? (
                        <span className="canal">{l.numero}</span>
                      ) : (
                        <span className="canal vide" aria-hidden="true" />
                      )}
                      {l.icone ? (
                        <img className="logo" src={l.icone} alt="" loading="lazy" />
                      ) : (
                        <span className="logo logo-texte">{l.nom.slice(0, 2)}</span>
                      )}
                      <span className="chaine">{l.nom}</span>
                    </div>

                    <div className="piste">
                      {l.programmes.map((p, k) => {
                        const largeur = p.duree * PX_PAR_MIN;
                        const direct = maintenant >= p.debut && maintenant < p.debut + p.duree;
                        const heure = heureDe(jour, p.debut, conf.timezone);
                        const classes = ["prog"];
                        if (direct) classes.push("direct");
                        // Un bloc de quelques minutes ne peut pas porter de
                        // texte : on le garde visible mais muet, plutôt que
                        // d'aligner des tranches de lettres illisibles.
                        if (largeur < LARGEUR_TEXTE) classes.push("muet");
                        return (
                          <article
                            key={k}
                            className={classes.join(" ")}
                            style={{
                              left: `${xDe(p.debut)}px`,
                              width: `${Math.max(largeur - 2, 3)}px`,
                            }}
                            title={`${heure} — ${p.titre}${p.sousTitre ? ` · ${p.sousTitre}` : ""}`}
                          >
                            {largeur >= LARGEUR_TEXTE && (
                              <>
                                <span className="prog-heure">{heure}</span>
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
                ))}
              </section>
            ))}
          </div>
        </div>
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

function Vide({ children }) {
  return (
    <div className="app">
      <p className="etat">{children}</p>
    </div>
  );
}
