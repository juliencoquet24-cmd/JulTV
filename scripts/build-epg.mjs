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
import { createReadStream } from "node:fs";
import { gunzipSync, unzipSync } from "node:zlib";
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

/** Décompresse selon l'extension. .xz nécessite l'outil système xz. */
function decompresser(buf, url) {
  if (url.endsWith(".gz")) return gunzipSync(buf);
  if (url.endsWith(".zip")) {
    // unzipSync n'existe pas pour les archives multi-fichiers : on passe par unzip.
    throw new Error("Archives .zip non gérées, préfère .gz ou .xml");
  }
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
  return decompresser(brut, src.url).toString("utf8");
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
      `--site=${src.site}`,
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
});

function lireXmltv(xml, chaines, diffusions) {
  const doc = analyseur.parse(xml);
  const tv = doc?.tv;
  if (!tv) return;

  for (const c of tv.channel ?? []) {
    const id = c["@id"];
    if (!id || chaines.has(id)) continue;
    chaines.set(id, {
      id,
      nom: texte(c["display-name"]) ?? id,
      icone: c.icon?.[0]?.["@src"] ?? c.icon?.["@src"] ?? null,
    });
  }

  for (const p of tv.programme ?? []) {
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

// ---------------------------------------------------------------- compactage

/** Découpe les diffusions par journée locale et les encode en tuples. */
function parJour(diffusions, chaines, timezone) {
  const jourDe = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const index = new Map([...chaines.keys()].map((id, i) => [id, i]));
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

async function traiterPays(code, conf) {
  const chaines = new Map();
  const diffusions = [];

  for (const src of conf.sources) {
    try {
      const xml = src.type === "grab" ? await viaGrabber(src) : await viaUrl(src);
      lireXmltv(xml, chaines, diffusions);
      log(`${src.name}: ${chaines.size} chaînes, ${diffusions.length} diffusions cumulées`);
    } catch (e) {
      // Une source qui tombe ne doit pas faire échouer tout le build.
      console.error(`[epg] source ${src.name} en échec :`, e.message);
    }
  }

  if (!diffusions.length) {
    console.error(`[epg] ${code}: aucune donnée, pays ignoré`);
    return null;
  }

  const jours = parJour(diffusions, chaines, conf.timezone);
  const retenus = joursUtiles(jours, conf.timezone);

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
    chaines: [...chaines.values()].map((c) => [c.nom, c.icone]),
  };
}

async function main() {
  const conf = JSON.parse(
    await readFile(path.join(RACINE, "scripts", "sources.json"), "utf8")
  );

  await mkdir(SORTIE, { recursive: true });
  const index = { genereLe: new Date().toISOString(), pays: {} };

  for (const [code, c] of Object.entries(conf)) {
    if (code.startsWith("_")) continue;
    const res = await traiterPays(code, c);
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
