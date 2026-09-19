/**
 * Agrège plusieurs fichiers XMLTV (France + Espagne, tous bouquets) et produit
 * des fichiers JSON compacts consommés par le front statique.
 *
 * Sortie dans public/data/ :
 *   index.json            — jours disponibles, chaînes par pays, date de génération
 *   <pays>/<AAAA-MM-JJ>.json — toutes les diffusions de la journée, 00h00 → 23h59
 *
 * Le format des diffusions est un tableau de tuples plutôt qu'un tableau
 * d'objets : sur 700 chaînes × 24 h, les noms de clés répétés pèsent plus
 * lourd que les données elles-mêmes.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { XMLParser } from "fast-xml-parser";
import path from "node:path";

const RACINE = process.cwd();
const SORTIE = path.join(RACINE, "public", "data");
const TRAVAIL = path.join(RACINE, ".epg-tmp");

// ---------------------------------------------------------------- utilitaires

const log = (...a) => console.log("[epg]", ...a);

/** "20260919211000 +0200" → Date */
function dateXmltv(brut) {
  if (!brut) return null;
  const m = String(brut).match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-]\d{4}))?/
  );
  if (!m) return null;
  const [, a, mo, j, h, mi, s = "00", tz] = m;
  const dec = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : "+00:00";
  const d = new Date(`${a}-${mo}-${j}T${h}:${mi}:${s}${dec}`);
  return isNaN(d) ? null : d;
}

const texte = (v) => {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = texte(x);
      if (t) return t;
    }
    return null;
  }
  if (typeof v === "object") return texte(v["#text"]);
  return null;
};

/**
 * Extrait le premier fichier .xml d'une archive .zip. Le format zip stocke
 * une table des matières en fin de fichier : impossible à lire en flux
 * continu, il faut un fichier réel sur disque pour que `unzip` puisse s'y
 * déplacer. D'où l'écriture temporaire ci-dessous.
 */
function depuisZip(buf, nomTemp) {
  mkdirSync(TRAVAIL, { recursive: true });
  const zipTmp = path.join(TRAVAIL, `${nomTemp}.zip`);
  writeFileSync(zipTmp, buf);

  const listing = execFileSync("unzip", ["-Z1", zipTmp], { maxBuffer: 1 << 20 })
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const entree = listing.find((n) => n.toLowerCase().endsWith(".xml"));
  if (!entree) throw new Error(`aucun .xml dans l'archive (contenu : ${listing.join(", ")})`);

  return execFileSync("unzip", ["-p", zipTmp, entree], { maxBuffer: 1 << 30 });
}

/** Décompresse selon l'extension. .xz et .zip nécessitent des outils système. */
function decompresser(buf, url, nomTemp) {
  if (url.endsWith(".gz")) return gunzipSync(buf);
  if (url.endsWith(".zip")) return depuisZip(buf, nomTemp);
  if (url.endsWith(".xz")) {
    return execFileSync("xz", ["-dc"], { input: buf, maxBuffer: 1 << 30 });
  }
  return buf;
}

// ------------------------------------------------------- récupération sources

async function viaUrl(src) {
  log(`téléchargement ${src.name} …`);
  const res = await fetch(src.url, {
    headers: { "user-agent": "grille-tv/1.0 (+github-actions)" },
  });
  if (!res.ok) throw new Error(`${src.name}: HTTP ${res.status}`);
  const brut = Buffer.from(await res.arrayBuffer());
  log(`${src.name}: ${(brut.length / 1e6).toFixed(1)} Mo compressés`);
  return decompresser(brut, src.url, src.name).toString("utf8");
}

/**
 * Lance le grabber iptv-org/epg, cloné au préalable par le workflow dans
 * .epg-tmp/iptv-org-epg. Chaque site produit son propre XMLTV.
 */
async function viaGrabber(src) {
  const depot = path.join(TRAVAIL, "iptv-org-epg");
  const cible = path.join(TRAVAIL, `${src.name}.xml`);
  log(`grabbing ${src.site} (${src.days} jours) …`);
  execFileSync(
    "npm",
    [
      "run",
      "grab",
      "--",
      `--sites=${src.site}`,
      `--days=${src.days}`,
      `--output=${cible}`,
      "--maxConnections=5",
    ],
    { cwd: depot, stdio: "inherit", timeout: 45 * 60 * 1000 }
  );
  return readFile(cible, "utf8");
}

// ------------------------------------------------------------------- parsing

const analyseur = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (nom) =>
    ["channel", "programme", "category", "display-name", "icon"].includes(nom),
  // Le XMLTV de xmltvfr.fr déclare plusieurs centaines d'entités DOCTYPE pour
  // les caractères accentués : ça dépasse largement la limite anti-bombe XML
  // par défaut de fast-xml-parser (1000). On la desserre sans la désactiver.
  processEntities: {
    maxTotalExpansions: 20000,
    maxEntityCount: 5000,
    maxExpandedLength: 2_000_000,
  },
});

function lireXmltv(xml, chaines, diffusions, exclues) {
  const doc = analyseur.parse(xml);
  const tv = doc?.tv;
  if (!tv) return;

  for (const c of tv.channel ?? []) {
    const id = c["@id"];
    if (!id || chaines.has(id)) continue;
    const nom = texte(c["display-name"]) ?? id;
    // Écartée dès la lecture : ni la chaîne ni ses programmes n'entreront
    // dans les données, donc rien à filtrer ensuite côté site.
    if (estAdulte(nom) || estAdulte(id)) {
      exclues.add(id);
      continue;
    }
    chaines.set(id, {
      id,
      nom,
      icone: c.icon?.[0]?.["@src"] ?? c.icon?.["@src"] ?? null,
    });
  }

  for (const p of tv.programme ?? []) {
    if (exclues.has(p["@channel"])) continue;
    const debut = dateXmltv(p["@start"]);
    if (!debut) continue;
    const fin = dateXmltv(p["@stop"]);
    diffusions.push({
      chaine: p["@channel"],
      debut,
      fin,
      titre: texte(p.title) ?? "(sans titre)",
      sousTitre: texte(p["sub-title"]),
      genre: texte(p.category?.[0] ?? p.category),
    });
  }
}

// ------------------------------------------------------- filtrage & numéros

/** Minuscules, sans accents ni ponctuation : "L'Équipe HD" → "lequipe". */
const normaliser = (s) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

/**
 * Chaînes pour adultes, exclues du site. On compare sur le nom normalisé,
 * donc "XXL" ne déclenche pas "xxx" et "Passion" seul ne suffit pas.
 * Les marques sont listées explicitement plutôt que devinées : un filtre
 * trop large supprimerait des chaînes légitimes (Pink TV, Blues...).
 */
const MARQUES_ADULTES = [
  "dorcel", "hustler", "playboy", "penthouse", "brazzers", "vivid",
  "privatetv", "privatespice", "daringtv", "eroxxx", "xxl", "sexysat",
  "frenchlover", "pinkx", "pinkerotic", "redlight", "sextreme",
  "blueh", "blue hustler", "vizionplus", "satisfaction", "libido",
  "adultchannel", "xdream", "extasy", "erotic", "erotik", "erotico",
];

/** Motifs plus génériques, cherchés en tant que mot entier normalisé. */
const MOTIFS_ADULTES = [/(^|[^a-z])xxx([^a-z]|$)/, /^adult/, /porno?$/, /^porn/];

function estAdulte(nom) {
  const n = normaliser(nom);
  if (MARQUES_ADULTES.some((m) => n.includes(normaliser(m)))) return true;
  // Sur le nom d'origine espacé, pour les motifs à frontière de mot.
  const espace = ` ${(nom ?? "").toLowerCase()} `;
  return MOTIFS_ADULTES.some((r) => r.test(espace) || r.test(n));
}

/**
 * Construit une table nom normalisé → rang à partir d'une liste. Le premier
 * élément vaut 1. Sert deux fois : pour les numéros de canal, et pour les
 * chaînes mises en avant.
 */
function tableNumeros(liste) {
  const table = new Map();
  (liste ?? []).forEach((entree, i) => {
    const noms = Array.isArray(entree) ? entree : [entree];
    for (const nom of noms) {
      const cle = normaliser(nom);
      if (cle && !table.has(cle)) table.set(cle, i + 1);
    }
  });
  return table;
}

/**
 * Cherche le rang d'une chaîne. On tente d'abord le nom exact normalisé,
 * puis un préfixe très court : "france2hd" retombe sur "france2".
 *
 * La marge est volontairement de trois caractères, de quoi absorber "hd",
 * "tnt" ou "sd" et rien de plus : à quatre, "Canal+ Foot" héritait du
 * numéro de Canal+, ce qui est faux — c'est une autre chaîne.
 */
function numeroDe(nom, table) {
  const n = normaliser(nom);
  if (table.has(n)) return table.get(n);
  for (const [cle, num] of table) {
    if (n.startsWith(cle) && n.length - cle.length <= 3) return num;
  }
  return null;
}

/** Accepte `{ canaux: [...], priorites: [...] }` ou un tableau seul. */
function reglagesPays(brut) {
  if (Array.isArray(brut)) return { canaux: brut, priorites: [] };
  return { canaux: brut?.canaux ?? [], priorites: brut?.priorites ?? [] };
}

// ------------------------------------------------------------ catégorisation

/**
 * Aucune source XMLTV ne dit "cette chaîne est une chaîne de sport" : seuls
 * les programmes portent un genre. On en déduit la catégorie de la chaîne en
 * regardant ce qu'elle diffuse le plus souvent. Une chaîne où un genre domine
 * nettement (ex. 80 % de sport) prend cette catégorie ; une chaîne dont la
 * grille est mélangée (JT, séries, jeux, films...) reste "Généralistes" —
 * exactement ce qu'est TF1 ou France 2 dans la vraie vie.
 */
const CATEGORIES_ORDRE = [
  "Généralistes",
  "Information",
  "Cinéma",
  "Séries",
  "Sport",
  "Jeunesse",
  "Documentaire",
  "Musique & Culture",
  "Divertissement",
  "Autres",
];

// Mots-clés en français et en espagnol, cherchés dans le genre brut du
// programme (en minuscules, accents conservés car ils diffèrent peu ici).
const MOTS_CLES = {
  Information: ["info", "actualit", "journal", "news", "noticias", "meteo", "tiempo"],
  Cinéma: ["film", "cinema", "cinéma", "cine", "movie", "largometraje", "long métrage"],
  Séries: ["serie", "série", "soap", "telenovela", "novela", "feuilleton"],
  Sport: [
    "sport", "deporte", "football", "fútbol", "futbol", "baloncesto", "basket",
    "tennis", "rugby", "cyclisme", "ciclismo", "golf", "boxe", "boxeo",
    "formule 1", "f1", "moto", "nascar", "mma", "ufc", "hípica", "hipica",
  ],
  Jeunesse: ["jeunesse", "infantil", "enfant", "kids", "dessin anime", "dibujos", "animacion infantil"],
  Documentaire: ["documentaire", "documental", "decouverte", "reportage", "reportaje"],
  "Musique & Culture": [
    "musique", "musica", "música", "concert", "clip", "culture", "cultura",
    "spectacle", "theatre", "théâtre", "teatro", "opera", "opéra", "danse",
  ],
  Divertissement: [
    "divertissement", "entretenimiento", "emission", "émission", "magazine",
    "variedades", "talk", "jeu", "concours", "reality", "telerealite",
  ],
};

function genreVersCategorie(genreBrut) {
  if (!genreBrut) return null;
  const g = genreBrut.toLowerCase();
  for (const cat of CATEGORIES_ORDRE) {
    const mots = MOTS_CLES[cat];
    if (mots && mots.some((m) => g.includes(m))) return cat;
  }
  return null;
}

/** Repli quand une chaîne n'a aucun programme genré ce jour-là (rare). */
function nomVersCategorie(nom) {
  const n = nom.toLowerCase();
  for (const cat of CATEGORIES_ORDRE) {
    const mots = MOTS_CLES[cat];
    if (mots && mots.some((m) => n.includes(m))) return cat;
  }
  return "Autres";
}

/**
 * @returns Map(indexChaine → catégorie), sur l'ensemble des diffusions
 * connues (tous jours confondus) pour que l'étiquette d'une chaîne ne
 * change pas d'un jour à l'autre selon ce qui est diffusé ce jour-là.
 */
function categoriser(diffusions, index, chaines) {
  const comptes = new Map(); // i → Map(catégorie → n)

  for (const d of diffusions) {
    const i = index.get(d.chaine);
    const cat = genreVersCategorie(d.genre);
    if (i === undefined || !cat) continue;
    if (!comptes.has(i)) comptes.set(i, new Map());
    const m = comptes.get(i);
    m.set(cat, (m.get(cat) ?? 0) + 1);
  }

  const resultat = new Map();
  for (const [i, m] of comptes) {
    let total = 0, meilleure = null, max = 0;
    for (const [cat, n] of m) {
      total += n;
      if (n > max) { max = n; meilleure = cat; }
    }
    // Sous 45 %, aucun genre ne domine vraiment : chaîne généraliste.
    resultat.set(i, max / total >= 0.45 ? meilleure : "Généralistes");
  }

  for (const [id, i] of index) {
    if (!resultat.has(i)) resultat.set(i, nomVersCategorie(chaines.get(id).nom));
  }
  return resultat;
}

// ---------------------------------------------------------------- compactage

/** Découpe les diffusions par journée locale et les encode en tuples. */
function parJour(diffusions, index, timezone) {
  const jourDe = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const jours = new Map();

  for (const d of diffusions) {
    const i = index.get(d.chaine);
    if (i === undefined) continue;

    const jour = jourDe.format(d.debut);
    if (!jours.has(jour)) jours.set(jour, []);

    // Minutes depuis minuit UTC du jour, pour rester compact et sans ambiguïté.
    const minuit = Date.parse(`${jour}T00:00:00Z`);
    const debut = Math.round((d.debut.getTime() - minuit) / 60000);
    const duree = d.fin
      ? Math.max(1, Math.round((d.fin.getTime() - d.debut.getTime()) / 60000))
      : 0;

    jours.get(jour).push([i, debut, duree, d.titre, d.sousTitre, d.genre]);
  }

  for (const liste of jours.values()) liste.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return jours;
}

// -------------------------------------------------------------------- limites

/**
 * On ne conserve que les jours utiles. Garder l'historique ferait grossir le
 * dépôt sans fin, et une grille d'il y a trois semaines n'intéresse personne.
 */
function joursUtiles(jours, timezone) {
  const aujourdhui = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const hier = new Date(Date.parse(`${aujourdhui}T00:00:00Z`) - 864e5)
    .toISOString()
    .slice(0, 10);
  return [...jours.keys()].filter((j) => j >= hier).sort();
}

// ----------------------------------------------------------------------- main

async function traiterPays(code, conf, numerotation) {
  const chaines = new Map();
  const diffusions = [];
  const exclues = new Set();

  for (const src of conf.sources) {
    try {
      const xml = src.type === "grab" ? await viaGrabber(src) : await viaUrl(src);
      lireXmltv(xml, chaines, diffusions, exclues);
      log(`${src.name}: ${chaines.size} chaînes, ${diffusions.length} diffusions cumulées`);
    } catch (e) {
      // Une source qui tombe ne doit pas faire échouer tout le build.
      console.error(`[epg] source ${src.name} en échec :`, e.message);
    }
  }

  if (exclues.size) log(`${code}: ${exclues.size} chaînes adultes écartées`);

  if (!diffusions.length) {
    console.error(`[epg] ${code}: aucune donnée, pays ignoré`);
    return null;
  }

  const index = new Map([...chaines.keys()].map((id, i) => [id, i]));
  const categories = categoriser(diffusions, index, chaines);
  const jours = parJour(diffusions, index, conf.timezone);
  const retenus = joursUtiles(jours, conf.timezone);

  // Numéro de canal et rang de mise en avant, quand la chaîne est listée.
  const reglages = reglagesPays(numerotation?.[code]);
  const tCanaux = tableNumeros(reglages.canaux);
  const tPriorites = tableNumeros(reglages.priorites);

  const numeros = new Map();
  const priorites = new Map();
  for (const [id, i] of index) {
    const nom = chaines.get(id).nom;
    const num = numeroDe(nom, tCanaux);
    if (num !== null) numeros.set(i, num);
    const pri = numeroDe(nom, tPriorites);
    if (pri !== null) priorites.set(i, pri);
  }
  log(
    `${code}: ${numeros.size} chaînes numérotées, ${priorites.size} mises en avant, sur ${chaines.size}`
  );

  await mkdir(path.join(SORTIE, code), { recursive: true });
  for (const jour of retenus) {
    await writeFile(
      path.join(SORTIE, code, `${jour}.json`),
      JSON.stringify({ jour, p: jours.get(jour) })
    );
  }

  // Purge des journées périmées restées d'un build précédent.
  const presents = await readdir(path.join(SORTIE, code)).catch(() => []);
  for (const f of presents) {
    const j = f.replace(/\.json$/, "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(j) && !retenus.includes(j)) {
      await writeFile(path.join(SORTIE, code, f), "").catch(() => {});
    }
  }

  log(`${code}: ${chaines.size} chaînes, ${retenus.length} jours écrits`);
  return {
    label: conf.label,
    timezone: conf.timezone,
    jours: retenus,
    categories: CATEGORIES_ORDRE,
    // [nom, icône, catégorie, numéro de canal, rang de mise en avant]
    chaines: [...chaines.values()].map((c, i) => [
      c.nom,
      c.icone,
      categories.get(i) ?? "Autres",
      numeros.get(i) ?? null,
      priorites.get(i) ?? null,
    ]),
  };
}

async function main() {
  const conf = JSON.parse(
    await readFile(path.join(RACINE, "scripts", "sources.json"), "utf8")
  );

  // Table optionnelle : son absence dégrade le tri, pas le build.
  let numerotation = {};
  try {
    numerotation = JSON.parse(
      await readFile(path.join(RACINE, "scripts", "numerotation.json"), "utf8")
    );
  } catch (e) {
    console.error("[epg] numerotation.json illisible, tri alphabétique :", e.message);
  }

  await mkdir(SORTIE, { recursive: true });
  const index = { genereLe: new Date().toISOString(), pays: {} };

  for (const [code, c] of Object.entries(conf)) {
    if (code.startsWith("_")) continue;
    const res = await traiterPays(code, c, numerotation);
    if (res) index.pays[code] = res;
  }

  if (!Object.keys(index.pays).length) {
    throw new Error("Aucun pays n'a produit de données : build interrompu");
  }

  await writeFile(path.join(SORTIE, "index.json"), JSON.stringify(index));
  log("terminé.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
