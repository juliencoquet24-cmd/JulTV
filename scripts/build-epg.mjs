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

function lireXmltv(xml, chaines, diffusions, exclues, source) {
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
      source,
      chaine: p["@channel"],
      debut,
      fin,
      titre: texte(p.title) ?? "(sans titre)",
      sousTitre: texte(p["sub-title"]),
      genre: texte(p.category?.[0] ?? p.category),
      details: detailsDe(p),
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
/** Tous les libellés d'une entrée, qu'elle soit texte, tableau ou objet. */
function libelles(entree) {
  if (typeof entree === "string") return [entree];
  if (Array.isArray(entree)) return entree;
  return [entree?.nom, ...(entree?.aussi ?? [])].filter(Boolean);
}

function tableNumeros(liste) {
  const table = new Map();
  (liste ?? []).forEach((entree, i) => {
    for (const nom of libelles(entree)) {
      const cle = normaliser(nom);
      if (cle && !table.has(cle)) table.set(cle, i + 1);
    }
  });
  return table;
}

/**
 * Catégorie déclarée pour chaque libellé. Elle prime sur la déduction faite
 * à partir des genres des programmes : les sources espagnoles n'en
 * fournissent presque jamais, si bien que des sections entières se
 * retrouvaient vides ou réduites à deux ou trois chaînes.
 */
/** Nom canonique de chaque libellé, tel qu'il est écrit dans la liste. */
function tableNoms(liste) {
  const table = new Map();
  for (const entree of liste ?? []) {
    const canon = typeof entree === "string" ? entree : entree?.nom;
    if (!canon) continue;
    for (const nom of libelles(entree)) {
      const cle = normaliser(nom);
      if (cle && !table.has(cle)) table.set(cle, canon);
    }
  }
  return table;
}

/** Comme categorieDe, mais pour le nom canonique. */
function nomCanonique(nom, table) {
  const n = normaliser(nom);
  if (table.has(n)) return table.get(n);
  for (const suf of SUFFIXES) {
    if (n.endsWith(suf)) {
      const base = n.slice(0, -suf.length);
      if (base && table.has(base)) return table.get(base);
    }
  }
  return null;
}

function tableCategories(liste) {
  const table = new Map();
  for (const entree of liste ?? []) {
    const cat = entree?.categorie;
    if (!cat) continue;
    for (const nom of libelles(entree)) {
      const cle = normaliser(nom);
      if (cle && !table.has(cle)) table.set(cle, cat);
    }
  }
  return table;
}

/** Cherche la catégorie déclarée d'une chaîne, suffixes techniques compris. */
function categorieDe(nom, table) {
  const n = normaliser(nom);
  if (table.has(n)) return table.get(n);
  for (const suf of SUFFIXES) {
    if (n.endsWith(suf)) {
      const base = n.slice(0, -suf.length);
      if (base && table.has(base)) return table.get(base);
    }
  }
  return null;
}

/**
 * Suffixes techniques qu'une source colle au nom d'une chaîne sans que ce
 * soit une autre chaîne : "TF1 HD" reste TF1.
 */
const SUFFIXES = ["hd", "fhd", "uhd", "4k", "sd", "tnt", "tv", "hd1", "1080", "720"];

/**
 * Cherche le rang d'une chaîne : nom exact normalisé, puis le même nom
 * débarrassé d'un suffixe technique.
 *
 * Surtout pas un rapprochement par préfixe libre. C'est ce qui donnait à
 * "TF1 + 1" le numéro de TF1 et à "Canal 32", une chaîne locale auboise,
 * celui de Canal+ : deux caractères d'écart suffisaient à confondre des
 * chaînes sans rapport.
 */
function numeroDe(nom, table) {
  return rangDe(nom, table).rang;
}

/**
 * Nom de base d'une chaîne, débarrassé de ses suffixes techniques, pour
 * reconnaître un même canal d'un flux à l'autre : « TF1 », « TF1 HD » et
 * « TF1 4K » donnent tous « tf1 ». Les suffixes s'enlèvent en boucle, pour
 * venir à bout d'un « France 2 HD 4K ».
 */
function nomDeBase(nom) {
  let n = normaliser(nom);
  let change = true;
  while (change) {
    change = false;
    for (const suf of SUFFIXES_TECHNIQUES) {
      if (n.length > suf.length + 1 && n.endsWith(suf)) {
        n = n.slice(0, -suf.length);
        change = true;
      }
    }
  }
  return n;
}

/**
 * Pays admis dans chaque grille. Les départements et territoires d'outre-mer
 * ont leur propre code mais sont français : La 1ère Réunion reste chez elle.
 */
const PAYS_ADMIS = {
  fr: ["fr", "re", "gp", "mq", "gf", "yt", "nc", "pf", "pm", "wf", "bl", "mf"],
  es: ["es"],
};

/**
 * Code pays porté par l'identifiant XMLTV. Les flux suivent tous la même
 * convention : « TF1.fr », « RTLTVI.be », « RTS1.ch », parfois suivis d'une
 * variante après une arobase, « TF1.fr@SD ».
 */
function paysDeIdentifiant(id) {
  const m = /\.([a-z]{2})(?:@[^.]*)?$/i.exec(id ?? "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * Filet pour les flux qui ne suffixent pas leurs identifiants : chaînes
 * étrangères francophones et hispanophones qu'on retrouve couramment.
 * Mots entiers seulement — « rts » ne doit pas attraper « sports ».
 */
const NOMS_ETRANGERS = [
  // Belgique
  /\b(rtl tvi|club rtl|plug rtl|tipik|abxplore|ab ?3|ln ?24|bx1|rtbf|la une|la deux|la trois|een|vtm|canvas|ketnet|npo ?\d?)\b/,
  // Suisse, Luxembourg
  /\b(rts( ?(un|deux|1|2))?|srf ?\d?|rsi ?\d?|l[ée]man bleu|canal alpha|la t[ée]l[ée]|rtl lux|rtl zwee)\b/,
  // Canada
  /\b(tva|radio-canada|noovo|ici t[ée]l[ée]|t[ée]l[ée]-qu[ée]bec|v t[ée]l[ée])\b/,
  // Afrique et Maghreb
  /\b(2m|al aoula|a\+ ?ivoire|rti ?\d?|ortm|rtb|crtv)\b/,
  // Portugal, Amérique latine
  /\b(rtp ?\d?|sic|tvi|latam|latinoam[ée]rica)\b/,
  // Mentions de pays dans le nom
  /\b(suisse|schweiz|belgique|belgi[eë]|belge|luxembourg|qu[ée]bec|canada|afrique|africa|maroc|alg[ée]rie|tunisie|s[ée]n[ée]gal|c[ôo]te d.ivoire|portugal|m[ée]xico|mexique|argentina|colombia|chile|per[úu])\b/,
];

/**
 * Une chaîne est-elle hors du pays de la grille ? L'identifiant fait foi
 * quand il porte un code pays ; sinon, le nom sert de filet.
 */
function estEtrangere(id, nom, code) {
  const pays = paysDeIdentifiant(id);
  if (pays) return !(PAYS_ADMIS[code] ?? [code]).includes(pays);
  const n = (nom ?? "").toLowerCase();
  return NOMS_ETRANGERS.some((r) => r.test(n));
}

/** Suffixes qui ne changent pas la chaîne — et seulement ceux-là. */
const SUFFIXES_TECHNIQUES = ["hd", "fhd", "uhd", "4k", "sd", "hevc", "1080", "720", "tnt"];

/**
 * Une déclinaison en différé (« TF1 +1 », « M6+1 ») diffuse la même grille
 * une heure plus tard : c'est un doublon de contenu, pas une chaîne de plus.
 */
const estDiffere = (nom) => /\+\s*[12]\s*$/.test(nom ?? "") || /\bplus\s*1\s*$/i.test(nom ?? "");

/** Retire du nom affiché les mentions techniques que les flux y collent. */
function nomPropre(nom) {
  return (nom ?? "")
    .replace(/\s+(HD|FHD|UHD|4K|SD|HEVC|1080p?|720p?|TNT)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Comme numeroDe, mais dit aussi si le nom correspondait mot pour mot. */
function rangDe(nom, table) {
  const n = normaliser(nom);
  if (table.has(n)) return { rang: table.get(n), exact: true };
  for (const suf of SUFFIXES) {
    if (n.endsWith(suf)) {
      const base = n.slice(0, -suf.length);
      if (base && table.has(base)) return { rang: table.get(base), exact: false };
    }
  }
  return { rang: null, exact: false };
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
  "Musique",
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
  Musique: [
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
 * @returns Map(identifiant de chaîne → catégorie), sur l'ensemble des
 * diffusions connues (tous jours confondus) pour que l'étiquette d'une
 * chaîne ne change pas d'un jour à l'autre selon ce qui est diffusé ce
 * jour-là.
 *
 * Clé sur l'identifiant plutôt que sur un indice numérique : la catégorie
 * doit être connue avant qu'on décide de l'ordre final d'affichage — c'est
 * justement elle qui sert à le construire (voir plus bas, "ordreAffichage").
 * La numéroter d'avance aurait recréé la dépendance circulaire qu'on essaie
 * de casser.
 */
function categoriser(diffusions, chaines) {
  const comptes = new Map(); // id → Map(catégorie → n)

  for (const d of diffusions) {
    if (!chaines.has(d.chaine)) continue;
    const cat = genreVersCategorie(d.genre);
    if (!cat) continue;
    if (!comptes.has(d.chaine)) comptes.set(d.chaine, new Map());
    const m = comptes.get(d.chaine);
    m.set(cat, (m.get(cat) ?? 0) + 1);
  }

  const resultat = new Map();
  for (const [id, m] of comptes) {
    let total = 0, meilleure = null, max = 0;
    for (const [cat, n] of m) {
      total += n;
      if (n > max) { max = n; meilleure = cat; }
    }
    // Sous 45 %, aucun genre ne domine vraiment : chaîne généraliste.
    resultat.set(id, max / total >= 0.45 ? meilleure : "Généralistes");
  }

  for (const id of chaines.keys()) {
    if (!resultat.has(id)) resultat.set(id, nomVersCategorie(chaines.get(id).nom));
  }
  return resultat;
}

/** Quelques valeurs, sans les vides : un objet à moitié null pèse pour rien. */
function compacter(objet) {
  const out = {};
  for (const [k, v] of Object.entries(objet)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

const liste = (v, max) => {
  if (v == null) return [];
  const t = (Array.isArray(v) ? v : [v]).map(texte).filter(Boolean);
  return max ? t.slice(0, max) : t;
};

/**
 * Détails d'une diffusion : résumé, distribution, année, épisode.
 *
 * Ils partent dans un fichier à part, chargé seulement à l'ouverture d'une
 * fiche : les résumés pèsent plusieurs fois le poids de la grille elle-même,
 * et personne ne les lit tous.
 */
function detailsDe(p) {
  // "1 . 4 . 0/1" en notation xmltv_ns : saison 2, épisode 5, comptés à zéro.
  let episode = null;
  for (const e of Array.isArray(p["episode-num"]) ? p["episode-num"] : [p["episode-num"]]) {
    const val = texte(e);
    if (!val) continue;
    const sys = e?.["@system"];
    if (sys === "xmltv_ns") {
      const [sa, ep] = val.split(".");
      const n = (x) => {
        const v = parseInt(String(x).split("/")[0].trim(), 10);
        return Number.isFinite(v) ? v + 1 : null;
      };
      const s2 = n(sa);
      const e2 = n(ep);
      if (s2 && e2) episode = `Saison ${s2}, épisode ${e2}`;
      else if (e2) episode = `Épisode ${e2}`;
    } else if (!episode) {
      episode = val;
    }
  }

  const credits = p.credits ?? {};
  return compacter({
    resume: texte(p.desc)?.slice(0, 900) ?? null,
    genres: liste(p.category, 4),
    annee: texte(p.date)?.slice(0, 4) ?? null,
    episode,
    realisateur: liste(credits.director, 2).join(", ") || null,
    acteurs: liste(credits.actor, 6),
    pays: liste(p.country, 2).join(", ") || null,
    note: texte(p["star-rating"]?.value ?? p["star-rating"]) ?? null,
    avis: texte(p.rating?.value ?? p.rating) ?? null,
    rediffusion: p["previously-shown"] !== undefined ? true : null,
    image: p.icon?.[0]?.["@src"] ?? p.icon?.["@src"] ?? null,
  });
}

// ---------------------------------------------------------------- compactage

/**
 * Programmes trop courts pour être lus dans la grille. Les chaînes musicales
 * et jeunesse listent chaque clip et chaque dessin animé de trois minutes :
 * sur une journée complète, une quarantaine de chaînes représentaient plus de
 * la moitié des diffusions, et le fichier devenait trop lourd pour un
 * téléphone. Une série d'au moins trois programmes courts consécutifs est
 * fondue en un seul bloc ; le détail reste consultable dans la fiche.
 */
const COURT_MIN = 8;

/** Nombre de chaînes par fichier de détails. */
const TRANCHE_DETAILS = 40;
const SERIE_MIN = 3;

/** Chaînes par fichier de grille : autant que pour les détails, même logique. */
const TRANCHE_CHAINES = TRANCHE_DETAILS;

/** Graduation de 30 min, comme le front : les bornes précalculées s'y calent. */
const PAS_BORNES = 30;
const arrondirBornes = (de, a) => ({
  de: Math.floor(de / PAS_BORNES) * PAS_BORNES,
  a: Math.ceil(a / PAS_BORNES) * PAS_BORNES,
});

/**
 * Découpe les diffusions par journée locale et les encode en tuples :
 *   [chaîne, début, durée, titre, genre]
 * Le genre est un indice dans la liste `g` du fichier, pas une chaîne : les
 * mêmes quinze libellés se répétaient des dizaines de milliers de fois. Le
 * sous-titre part dans les détails, chargés à l'ouverture d'une fiche.
 *
 * `categories` (chaîne → catégorie) sert uniquement à précalculer, pour
 * chaque jour, les bornes horaires de la frise — la journée entière et
 * chacune des catégories. Sans ce calcul fait une fois ici, le front devrait
 * charger le contenu de toutes les chaînes pour savoir où arrêter le
 * défilement, ce qui viderait de son sens le chargement à la demande.
 */
function parJour(diffusions, index, timezone, categories) {
  const jourDe = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const heureDe = new Intl.DateTimeFormat("fr-FR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });

  // Regroupement par journée, puis par chaîne.
  const paquets = new Map();
  for (const d of diffusions) {
    const i = index.get(d.chaine);
    if (i === undefined) continue;
    const jour = jourDe.format(d.debut);
    if (!paquets.has(jour)) paquets.set(jour, new Map());
    const parChaine = paquets.get(jour);
    if (!parChaine.has(i)) parChaine.set(i, []);
    parChaine.get(i).push(d);
  }

  const jours = new Map();
  const details = new Map();
  const dureeMin = (d) =>
    d.fin ? Math.max(1, Math.round((d.fin.getTime() - d.debut.getTime()) / 60000)) : 0;
  const estCourt = (d) => {
    const m = dureeMin(d);
    return m > 0 && m < COURT_MIN;
  };

  for (const [jour, parChaine] of paquets) {
    const minuit = Date.parse(`${jour}T00:00:00Z`);
    const aMinutes = (date) => Math.round((date.getTime() - minuit) / 60000);

    const genres = [];
    const indices = new Map();
    const codeGenre = (g) => {
      if (!g) return -1;
      if (!indices.has(g)) {
        indices.set(g, genres.length);
        genres.push(g);
      }
      return indices.get(g);
    };

    const tuples = [];
    const det = {};

    for (const [i, liste0] of parChaine) {
      liste0.sort((a, b) => a.debut - b.debut);
      // Un même flux répète parfois un programme, ou en fait se chevaucher
      // deux : on garde le premier et on écarte ce qui commence avant sa fin.
      const liste = [];
      for (const d of liste0) {
        const prec = liste[liste.length - 1];
        if (prec && d.debut.getTime() < (prec.fin ?? prec.debut).getTime()) continue;
        liste.push(d);
      }

      let k = 0;
      while (k < liste.length) {
        const d = liste[k];

        // Série de programmes courts qui se suivent sans trou.
        if (estCourt(d)) {
          let j = k + 1;
          while (
            j < liste.length &&
            estCourt(liste[j]) &&
            liste[j].debut.getTime() - (liste[j - 1].fin?.getTime() ?? 0) <= 60000
          ) {
            j++;
          }
          if (j - k >= SERIE_MIN) {
            const serie = liste.slice(k, j);
            const debut = aMinutes(serie[0].debut);
            const derniere = serie[serie.length - 1];
            const duree = Math.max(
              1,
              Math.round(((derniere.fin ?? derniere.debut).getTime() - serie[0].debut.getTime()) / 60000)
            );
            // Le genre dominant de la série donne son titre au bloc.
            const compte = new Map();
            for (const x of serie) if (x.genre) compte.set(x.genre, (compte.get(x.genre) ?? 0) + 1);
            const genre = [...compte.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

            tuples.push([i, debut, duree, `${genre ?? "Programmes courts"} · ${serie.length} titres`, codeGenre(genre)]);
            // Un bloc de clips peut couvrir la journée entière : quelques
            // centaines de titres, que personne ne lira jusqu'au bout.
            const MAX_SERIE = 30;
            const lignes = serie
              .slice(0, MAX_SERIE)
              .map((x) => `${heureDe.format(x.debut).replace(":", "h")} ${x.titre}`);
            if (serie.length > MAX_SERIE) lignes.push(`… et ${serie.length - MAX_SERIE} autres`);
            det[`${i}:${debut}`] = { serie: lignes };
            k = j;
            continue;
          }
        }

        const debut = aMinutes(d.debut);
        tuples.push([i, debut, dureeMin(d), d.titre, codeGenre(d.genre)]);
        const infos = d.sousTitre ? { ...(d.details ?? {}), sousTitre: d.sousTitre } : d.details;
        if (infos) det[`${i}:${debut}`] = infos;
        k++;
      }
    }

    tuples.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

    // Bornes de la journée entière, et de chaque catégorie séparément :
    // filtrer sur "Sport" doit arrêter le défilement à la fin du dernier
    // match, pas à la fin du dernier programme toutes chaînes confondues.
    let bTous = { de: Infinity, a: -Infinity };
    const bCat = new Map();
    for (const [i, debut, duree] of tuples) {
      const fin = debut + (duree || 60);
      if (debut < bTous.de) bTous.de = debut;
      if (fin > bTous.a) bTous.a = fin;
      const cat = categories?.get(i) ?? "Autres";
      const bc = bCat.get(cat) ?? { de: Infinity, a: -Infinity };
      if (debut < bc.de) bc.de = debut;
      if (fin > bc.a) bc.a = fin;
      bCat.set(cat, bc);
    }
    const bornes = {
      toutes: tuples.length ? arrondirBornes(bTous.de, bTous.a) : { de: 0, a: 1440 },
      parCategorie: Object.fromEntries(
        [...bCat.entries()].map(([cat, b]) => [cat, arrondirBornes(b.de, b.a)])
      ),
    };

    jours.set(jour, { g: genres, p: tuples, bornes });
    details.set(jour, det);
  }

  return { jours, details };
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
      lireXmltv(xml, chaines, diffusions, exclues, src.name);
      log(`${src.name}: ${chaines.size} chaînes, ${diffusions.length} diffusions cumulées`);
    } catch (e) {
      // Une source qui tombe ne doit pas faire échouer tout le build.
      console.error(`[epg] source ${src.name} en échec :`, e.message);
    }
  }

  if (exclues.size) log(`${code}: ${exclues.size} chaînes adultes écartées`);

  /**
   * Une chaîne, une source. Les flux suivent la même convention
   * d'identifiants — « TF1.fr » chez xmltvfr comme chez iptv-org — si bien
   * qu'une chaîne fournie par quatre sources voyait ses programmes empilés
   * quatre fois : blocs superposés, et un fichier quatre fois trop lourd
   * pour un téléphone. La première source qui fournit une chaîne la garde.
   */
  const sourceDe = new Map();
  for (const d of diffusions) {
    if (!sourceDe.has(d.chaine)) sourceDe.set(d.chaine, d.source);
  }
  const avant = diffusions.length;
  let w = 0;
  for (const d of diffusions) {
    if (sourceDe.get(d.chaine) === d.source) diffusions[w++] = d;
  }
  diffusions.length = w;
  if (avant !== w) {
    log(`${code}: ${avant - w} diffusions en double écartées (même chaîne fournie par plusieurs sources)`);
  }

  if (!diffusions.length) {
    console.error(`[epg] ${code}: aucune donnée, pays ignoré`);
    return null;
  }

  // Numéro de canal et rang de mise en avant, d'après numerotation.json.
  const reglages = reglagesPays(numerotation?.[code]);
  const tCanaux = tableNumeros(reglages.canaux);
  const tPriorites = tableNumeros(reglages.priorites);
  const tCategories = tableCategories(reglages.canaux);
  const tNoms = tableNoms(reglages.canaux);

  /**
   * On ne garde que les chaînes listées dans numerotation.json.
   *
   * Les sources XMLTV ratissent large : le flux français livre près de 800
   * entrées, chaînes belges, suisses, néerlandaises et déclinaisons
   * régionales comprises. Les publier toutes donnait une grille illisible
   * et une page que le téléphone n'arrivait plus à charger. La liste des
   * canaux fait donc office de filtre autant que d'ordre : pour ajouter une
   * chaîne, il suffit de l'ajouter au fichier.
   */
  // Nombre de diffusions par chaîne : départage les doublons à grille égale.
  const volume = new Map();
  for (const d of diffusions) volume.set(d.chaine, (volume.get(d.chaine) ?? 0) + 1);

  /**
   * Plusieurs entrées du flux désignent souvent la même chaîne : un flux
   * principal, sa déclinaison 4K, parfois un doublon sans logo. Elles
   * tombent toutes sur le même rang et la grille les affichait côte à côte.
   * On ne garde donc qu'une entrée par rang, la plus complète : celle qui a
   * un logo d'abord, puis celle dont le nom correspond mot pour mot, puis
   * celle qui a le plus de programmes.
   */
  /**
   * Toutes les chaînes des flux sont gardées, pas seulement celles de la
   * liste : numerotation.json sert désormais à ordonner, nommer et classer,
   * plus à filtrer. Ce qui disparaît, ce sont les doublons — même chaîne
   * sous deux noms, ou déclinaisons HD, 4K et différé d'un même canal.
   *
   * Une chaîne listée est reconnue par son rang ; les autres par leur nom
   * de base, ce qui suffit à réunir « Chaîne X » et « Chaîne X HD ».
   */
  const meilleur = new Map();
  let differes = 0;
  let etrangeres = 0;
  for (const [id, c] of chaines) {
    const canal = rangDe(c.nom, tCanaux);
    const prio = rangDe(c.nom, tPriorites);
    // Un différé (« +1 ») est un doublon de contenu, sauf si tu l'as mis
    // toi-même dans ta liste : c'est elle qui décide.
    if (canal.rang === null && prio.rang === null && estDiffere(c.nom)) {
      differes++;
      continue;
    }

    // Une chaîne de ta liste passe toujours, même si son identifiant dit
    // autre chose : TV5Monde est suffixée .ch par certains flux, et TMC
    // s'appelle Télé Monte-Carlo sans pour autant être monégasque.
    const listee = canal.rang !== null || prio.rang !== null;
    // Retour à l'essentiel : seule ta liste de chaînes entre dans la grille.
    // Garder toutes les chaînes des flux multipliait le volume par sept, et
    // c'est ce volume, pas l'affichage, qui rendait le site lent.
    if (!listee) {
      etrangeres++;
      continue;
    }

    const cle =
      canal.rang !== null
        ? `c${canal.rang}`
        : prio.rang !== null
          ? `p${prio.rang}`
          : `n${nomDeBase(c.nom)}`;
    const note =
      (c.icone ? 100 : 0) + ((canal.exact || prio.exact) ? 10 : 0);
    const candidat = {
      id,
      c,
      num: canal.rang,
      pri: prio.rang,
      note,
      vol: volume.get(id) ?? 0,
    };
    const actuel = meilleur.get(cle);
    if (
      !actuel ||
      candidat.note > actuel.note ||
      (candidat.note === actuel.note && candidat.vol > actuel.vol)
    ) {
      meilleur.set(cle, candidat);
    }
  }

  const gardees = new Map();
  const rangs = new Map();
  for (const m of meilleur.values()) {
    // Le nom vient de la liste, pas du flux : les sources écrivent
    // « CANAL+ CINEMA(S) HD » ou « beIN SPORTS 1 Dolby », qui ne tiennent
    // pas dans la colonne et se retrouvent tronqués à l'affichage.
    const canon = nomCanonique(m.c.nom, tNoms);
    gardees.set(m.id, { ...m.c, nom: canon ?? nomPropre(m.c.nom) });
    rangs.set(m.id, { num: m.num, pri: m.pri });
  }

  /**
   * Diagnostic publié avec la grille : les chaînes de ta liste qu'aucun flux
   * n'a fournies, et tous les noms que les flux emploient réellement. Les
   * écarts viennent presque toujours d'une orthographe différente (« beIN
   * SPORTS MAX 4 » contre « beIN Sports Max 4 »), et se corrigent en ajoutant
   * le nom du flux dans les « aussi » de numerotation.json.
   */
  {
    const trouves = new Set([...rangs.values()].map((r) => r.num).filter((n) => n !== null));
    const manquantes = (reglages.canaux ?? [])
      .map((e, k) => ({ rang: k + 1, nom: typeof e === "string" ? e : e?.nom }))
      .filter((x) => x.nom && !x.nom.startsWith("_") && !trouves.has(x.rang))
      .map((x) => x.nom);
    const nomsDuFlux = [...new Set([...chaines.values()].map((c) => c.nom))].sort((a, b) =>
      a.localeCompare(b, "fr")
    );
    await mkdir(SORTIE, { recursive: true });
    await writeFile(
      path.join(SORTIE, `${code}.diagnostic.json`),
      JSON.stringify({ manquantes, nomsDuFlux }, null, 1)
    );
    if (manquantes.length) {
      log(`${code}: ${manquantes.length} chaînes de la liste introuvables dans les flux — voir data/${code}.diagnostic.json`);
    }
  }

  if (!gardees.size) {
    console.error(`[epg] ${code}: aucune chaîne exploitable dans les sources, pays ignoré`);
    return null;
  }
  const listees = [...rangs.values()].filter((r) => r.num !== null).length;
  log(
    `${code}: ${gardees.size} chaînes après fusion des doublons, sur ${chaines.size} entrées reçues ` +
      `(${listees} reconnues dans la liste, ${gardees.size - listees} en plus, ` +
      `${differes} différés écartés, ${etrangeres} hors liste ignorées)`
  );

  /**
   * Garde-fou contre une source défaillante. Certains flux renvoient la
   * même grille pour toutes leurs chaînes : on se retrouvait avec dix
   * chaînes espagnoles diffusant le même film à la même minute. Deux ou
   * trois chaînes peuvent légitimement être en simulcast ; au-delà, c'est
   * un défaut de la source, et on ne garde que la première.
   */
  const SEUIL_CLONES = 4;
  const empreintes = new Map();
  for (const id of gardees.keys()) {
    const sienne = diffusions
      .filter((d) => d.chaine === id)
      .map((d) => `${d.debut.getTime()}|${d.titre}`)
      .sort()
      .join("~");
    if (!sienne) continue;
    if (!empreintes.has(sienne)) empreintes.set(sienne, []);
    empreintes.get(sienne).push(id);
  }

  let clones = 0;
  for (const ids of empreintes.values()) {
    if (ids.length < SEUIL_CLONES) continue;
    // La première dans l'ordre de la liste est la plus plausible.
    const trie = ids.sort(
      (a, b) => (rangs.get(a).num ?? 1e9) - (rangs.get(b).num ?? 1e9)
    );
    for (const id of trie.slice(1)) {
      gardees.delete(id);
      rangs.delete(id);
      clones++;
    }
  }
  if (clones) {
    console.error(
      `[epg] ${code}: ${clones} chaînes écartées, grille identique à une autre — la source est probablement en défaut`
    );
  }

  // Catégorie déclarée si elle existe, sinon déduite des genres diffusés.
  // Calculée par identifiant, avant tout numéro de position : elle sert
  // justement à décider cette position juste après.
  const deduites = categoriser(diffusions, gardees);
  const categorieFinaleDe = new Map();
  let declarees = 0;
  for (const id of gardees.keys()) {
    const dec = categorieDe(gardees.get(id).nom, tCategories);
    if (dec) declarees++;
    categorieFinaleDe.set(id, dec ?? deduites.get(id) ?? "Autres");
  }
  log(`${code}: ${declarees} catégories déclarées, ${gardees.size - declarees} déduites`);

  /**
   * Ordre final d'affichage : par catégorie (dans l'ordre de
   * CATEGORIES_ORDRE), puis mise en avant, puis numéro de canal, puis nom.
   * Exactement l'ordre que le site recompose lui-même à l'écran — sauf
   * qu'ici il devient l'ordre RÉEL des données, une fois pour toutes.
   *
   * C'est ce qui permet le chargement à la demande : le site charge des
   * tranches d'indices contigus (chaîne 40 à 79, par exemple). Si cet ordre
   * ne correspondait pas à l'ordre affiché, la moindre catégorie ou le
   * moindre écran visible aurait pu piocher une chaîne sur deux dans toute
   * la liste, et il aurait fallu charger la quasi-totalité de la grille pour
   * n'en montrer qu'un écran — exactement le problème qu'on cherche à
   * éviter.
   */
  const rangCategorie = new Map(CATEGORIES_ORDRE.map((c, k) => [c, k]));
  const ordre = [...gardees.keys()].sort((a, b) => {
    const ca = rangCategorie.get(categorieFinaleDe.get(a)) ?? 999;
    const cb = rangCategorie.get(categorieFinaleDe.get(b)) ?? 999;
    if (ca !== cb) return ca - cb;
    const ra = rangs.get(a), rb = rangs.get(b);
    if (ra.pri && rb.pri) return ra.pri - rb.pri;
    if (ra.pri) return -1;
    if (rb.pri) return 1;
    if (ra.num && rb.num) return ra.num - rb.num;
    if (ra.num) return -1;
    if (rb.num) return 1;
    return gardees.get(a).nom.localeCompare(gardees.get(b).nom, "fr");
  });

  const index = new Map(ordre.map((id, i) => [id, i]));
  const numeros = new Map();
  const priorites = new Map();
  const categories = new Map();
  for (const [id, i] of index) {
    const { num, pri } = rangs.get(id);
    if (num !== null) numeros.set(i, num);
    if (pri !== null) priorites.set(i, pri);
    categories.set(i, categorieFinaleDe.get(id));
  }

  const { jours, details } = parJour(diffusions, index, conf.timezone, categories);
  const retenus = joursUtiles(jours, conf.timezone);

  await mkdir(path.join(SORTIE, code), { recursive: true });
  for (const jour of retenus) {
    const { g, p } = jours.get(jour);
    // Un fichier par jour : avec ta seule liste, il pèse une centaine de Ko,
    // assez léger pour être chargé d'un bloc sans rien découper.
    await writeFile(path.join(SORTIE, code, `${jour}.json`), JSON.stringify({ jour, g, p }));
    await writeFile(
      path.join(SORTIE, code, `${jour}.details.json`),
      JSON.stringify(details.get(jour) ?? {})
    );
  }

  // Purge des journées périmées restées d'un build précédent.
  const presents = await readdir(path.join(SORTIE, code)).catch(() => []);
  for (const f of presents) {
    const j = f.replace(/\.details(\.\d+)?\.json$/, "").replace(/\.c\d+\.json$/, "").replace(/\.json$/, "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(j) && !retenus.includes(j)) {
      await writeFile(path.join(SORTIE, code, f), "").catch(() => {});
    }
  }

  log(`${code}: ${gardees.size} chaînes, ${retenus.length} jours écrits`);
  return {
    label: conf.label,
    timezone: conf.timezone,
    jours: retenus,
    categories: CATEGORIES_ORDRE,
    // [nom, icône, catégorie, numéro de canal, rang de mise en avant]
    // Dans l'ordre `ordre` : c'est cet ordre, et lui seul, qui fait
    // coïncider la position d'une chaîne avec celle de son contenu.
    chaines: ordre.map((id, i) => {
      const c = gardees.get(id);
      return [c.nom, c.icone, categories.get(i) ?? "Autres", numeros.get(i) ?? null, priorites.get(i) ?? null];
    }),
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
