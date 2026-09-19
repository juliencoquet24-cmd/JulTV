import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const BASE = `${import.meta.env.BASE_URL}data`;
const RAFRAICHISSEMENT = 5 * 60 * 1000;

/** Minutes depuis minuit UTC → étiquette locale du pays. */
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

function jourLisible(jour) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${jour}T12:00:00Z`));
}

/** Minutes écoulées depuis minuit UTC du jour affiché. */
function minutesCourantes(jour) {
  return Math.round((Date.now() - Date.parse(`${jour}T00:00:00Z`)) / 60000);
}

const TRANCHES = [
  { id: "maintenant", label: "En ce moment" },
  { id: "matin", label: "Matin", de: 6 * 60, a: 12 * 60 },
  { id: "aprem", label: "Après-midi", de: 12 * 60, a: 18 * 60 },
  { id: "soiree", label: "Soirée", de: 20 * 60, a: 23 * 60 },
  { id: "nuit", label: "Nuit", de: 23 * 60, a: 30 * 60 },
  { id: "tout", label: "Journée entière", de: 0, a: 24 * 60 },
];

export default function App() {
  const [index, setIndex] = useState(null);
  const [pays, setPays] = useState(null);
  const [jour, setJour] = useState(null);
  const [grille, setGrille] = useState(null);
  const [tranche, setTranche] = useState("soiree");
  const [recherche, setRecherche] = useState("");
  const [erreur, setErreur] = useState(null);
  const [tic, setTic] = useState(() => Date.now());
  const cache = useRef(new Map());

  // Index général : pays disponibles, jours, chaînes.
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
      .catch((e) => setErreur(`Grille indisponible (${e.message})`));
  }, []);

  // Grille du jour sélectionné, mise en cache côté client.
  const charger = useCallback(async (p, j) => {
    if (!p || !j) return;
    const cle = `${p}/${j}`;
    if (cache.current.has(cle)) return setGrille(cache.current.get(cle));
    setGrille(null);
    try {
      const r = await fetch(`${BASE}/${cle}.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      cache.current.set(cle, json);
      setGrille(json);
    } catch (e) {
      setErreur(`Journée indisponible (${e.message})`);
    }
  }, []);

  useEffect(() => {
    charger(pays, jour);
  }, [charger, pays, jour]);

  // Le repère « en cours » suit l'heure réelle ; on recharge au retour d'onglet.
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

  const chaines = useMemo(() => {
    if (!conf || !grille) return [];

    const maintenant = minutesCourantes(jour);
    const t = TRANCHES.find((x) => x.id === tranche);
    const de = tranche === "maintenant" ? maintenant - 1 : t.de;
    const a = tranche === "maintenant" ? maintenant + 1 : t.a;

    const q = recherche.trim().toLowerCase();
    const parChaine = new Map();

    for (const [i, debut, duree, titre, sousTitre, genre] of grille.p) {
      const fin = duree ? debut + duree : debut + 60;
      if (fin <= de || debut >= a) continue;

      const nom = conf.chaines[i]?.[0] ?? "?";
      if (q && !nom.toLowerCase().includes(q) && !titre.toLowerCase().includes(q))
        continue;

      if (!parChaine.has(i)) parChaine.set(i, []);
      parChaine.get(i).push({ debut, fin, titre, sousTitre, genre });
    }

    return [...parChaine.entries()]
      .map(([i, programmes]) => ({
        i,
        nom: conf.chaines[i][0],
        icone: conf.chaines[i][1],
        programmes: programmes.slice(0, tranche === "tout" ? 200 : 12),
      }))
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  }, [conf, grille, jour, tranche, recherche, tic]);

  if (erreur && !index) return <Cadre><p className="etat">{erreur}</p></Cadre>;
  if (!index || !conf) return <Cadre><p className="etat">Chargement de la grille…</p></Cadre>;

  const maintenant = minutesCourantes(jour);

  return (
    <Cadre>
      <header className="entete">
        <h1>
          <span className="sur-titre">Grille complète</span>
          {jourLisible(jour)}
        </h1>

        <div className="onglets">
          {Object.entries(index.pays).map(([code, p]) => (
            <button
              key={code}
              className={code === pays ? "onglet actif" : "onglet"}
              onClick={() => {
                setPays(code);
                const jours = index.pays[code].jours;
                setJour(jours.includes(jour) ? jour : jours[0]);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="barre">
          <select value={jour} onChange={(e) => setJour(e.target.value)} aria-label="Jour">
            {conf.jours.map((j) => (
              <option key={j} value={j}>{jourLisible(j)}</option>
            ))}
          </select>

          <select value={tranche} onChange={(e) => setTranche(e.target.value)} aria-label="Tranche horaire">
            {TRANCHES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>

          <input
            type="search"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Chaîne ou programme"
            aria-label="Rechercher"
          />
        </div>

        <p className="compteur">
          {chaines.length} chaîne{chaines.length > 1 ? "s" : ""} sur {conf.chaines.length}
          {" · "}mise à jour {new Date(index.genereLe).toLocaleString("fr-FR", {
            dateStyle: "short",
            timeStyle: "short",
          })}
        </p>
      </header>

      {!grille && <p className="etat">Chargement de la journée…</p>}

      {grille && chaines.length === 0 && (
        <p className="etat">Rien ne correspond à cette recherche sur ce créneau.</p>
      )}

      <ol className="grille">
        {chaines.map((c) => (
          <li key={c.i} className="chaine">
            <div className="chaine-nom">
              {c.icone ? (
                <img src={c.icone} alt="" loading="lazy" width="32" height="32" />
              ) : (
                <span className="initiale">{c.nom.slice(0, 2)}</span>
              )}
              <h2>{c.nom}</h2>
            </div>

            <div className="creneaux">
              {c.programmes.map((p, k) => {
                const direct = maintenant >= p.debut && maintenant < p.fin;
                return (
                  <article key={k} className={direct ? "creneau direct" : "creneau"}>
                    <p className="heure">
                      {heureDe(jour, p.debut, conf.timezone)}
                      {direct && <span className="badge">en cours</span>}
                    </p>
                    <h3>{p.titre}</h3>
                    {p.sousTitre && <p className="sous-titre">{p.sousTitre}</p>}
                    {p.genre && <p className="genre">{p.genre}</p>}
                  </article>
                );
              })}
            </div>
          </li>
        ))}
      </ol>

      <footer className="pied">
        Données XMLTV agrégées depuis xmltvfr.fr (France) et les grabbers
        iptv-org (Espagne), reconstruites quatre fois par jour par GitHub Actions.
      </footer>
    </Cadre>
  );
}

function Cadre({ children }) {
  return <main className="cadre">{children}</main>;
}
