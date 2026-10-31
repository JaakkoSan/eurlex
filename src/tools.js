// MCP-työkalut: määrittelyt ja toteutukset.

import {
  parseActRef,
  existing,
  titles,
  workInfo,
  consolidatedVersions,
  relations,
  searchActs,
  fetchDocument,
  eurlexUrl,
  shortId,
  parseCaseRef,
  celexByEcli,
  caseInfo,
  casesInterpreting,
  searchCases,
  caseNumber,
  fmtLocation,
  LANGS,
  TYPE_LETTER,
} from "./cellar.js";
import { buildDocIndex, DOC_INDEX_VERSION } from "./doc.js";
import { getDerived, putDerived, SourceError } from "./http.js";

// Claude rajaa työkalun vastauksen 25 000 tokeniin; 50 000 merkkiä jättää varaa.
const MAX_OUTPUT = 50_000;
// Tietty CELEX-versio (alkuperäinen tai konsolidoitu) ei muutu.
const DOC_TTL = 30 * 86400;
// Hakemiston kappaleet jaetaan osiin, jotta artikla luetaan välimuistista ilman koko tekstiä.
// Jokainen tallennus on alipyyntö (ilmaistasolla enintään 50 kutsua kohden).
const SHARD_CHARS = 40_000;
const MAX_SHARDS = 16;

const common = {
  saados: {
    type: "string",
    description:
      "Säädös: numero (\"2016/679\", \"93/13/ETY\", \"asetus (EY) N:o 1907/2006\"), CELEX-numero (\"32016R0679\") tai ELI-osoite. Pelkällä numerolla anna myös tyyppi, jos sama numero on usealla säädöstyypillä.",
  },
  tyyppi: { type: "string", enum: ["asetus", "direktiivi", "paatos"], description: "Säädöstyyppi (valinnainen)." },
  kieli: { type: "string", enum: ["fi", "sv", "en"], description: "Kieliversio: fi (oletus), sv tai en." },
  versio: {
    type: "string",
    description:
      "Valinnainen. \"alkuperainen\" = EU:n virallisessa lehdessä julkaistu alkuperäinen teksti. Päivämäärä (VVVV-KK-PP) = konsolidoitu teksti sellaisena kuin se oli voimassa tuona päivänä. Oletus: uusin jo voimassa oleva konsolidoitu teksti.",
  },
};

export const TOOLS = [
  {
    name: "hae_eu_saadoksia",
    description:
      "Hakee EU-säädöksiä (asetukset, direktiivit, päätökset) nimen sanoilla EU:n julkaisutoimiston tietokannasta (EUR-Lexin aineisto). Palauttaa tunnukset, CELEX-numerot, päivämäärät ja nimet uusimmasta vanhimpaan. Käytä sanan vartaloa, esim. \"tietosuoj\", \"lääkinnällis laittei\".",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sanat, jotka säädöksen nimessä on oltava (kaikki). Vähintään 4 merkin sanat katkaistaan vartaloksi." },
        tyyppi: common.tyyppi,
        vain_voimassa: { type: "boolean", description: "Vain voimassa olevat (oletus true)." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        kieli: common.kieli,
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
      },
      required: ["hakusana"],
    },
  },
  {
    name: "eu_saados_tiedot",
    description:
      "Palauttaa EU-säädöksen tiedot: nimi, CELEX- ja ELI-tunnus, antopäivä, voimaantulo- ja soveltamispäivät, voimassaolo, konsolidoidut versiot (myös tulevat), muuttavat ja kumoavat säädökset sekä sisällysluettelo (luvut, artiklat ja liitteet).",
    inputSchema: {
      type: "object",
      properties: { saados: common.saados, tyyppi: common.tyyppi, versio: common.versio, kieli: common.kieli },
      required: ["saados"],
    },
  },
  {
    name: "hae_eu_artikla",
    description:
      "Palauttaa EU-säädöksen artiklan, johdanto-osan perustelukappaleen tai liitteen sanatarkan tekstin. Oletuksena uusin voimassa oleva konsolidoitu teksti; johdanto-osan perustelukappaleet ovat vain alkuperäisessä tekstissä. Anna yksi: artikla, johdanto_kappale tai liite.",
    inputSchema: {
      type: "object",
      properties: {
        saados: common.saados,
        tyyppi: common.tyyppi,
        artikla: { type: "string", description: "Artiklan numero, esim. \"6\" tai \"10 a\"." },
        johdanto_kappale: { type: "string", description: "Johdanto-osan perustelukappaleen numero, esim. \"47\"." },
        liite: { type: "string", description: "Liitteen numero, esim. \"I\" tai \"XVI\". Jos liitteitä on yksi, \"1\"." },
        versio: common.versio,
        kieli: common.kieli,
      },
      required: ["saados"],
    },
  },
  {
    name: "etsi_eu_saadoksesta",
    description:
      "Etsii yhden EU-säädöksen tekstistä sanaa tai sanontaa ja palauttaa osumat artikloittain (sekä johdanto-osan perustelukappaleet ja liitteet) lyhyine otteineen. Haku on kirjaimellinen: käytä sanan vartaloa.",
    inputSchema: {
      type: "object",
      properties: {
        saados: common.saados,
        tyyppi: common.tyyppi,
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä)." },
        versio: common.versio,
        kieli: common.kieli,
      },
      required: ["saados", "hakusana"],
    },
  },
  {
    name: "hae_eu_tuomioita",
    description:
      "Hakee EU-tuomioistuimen ja unionin yleisen tuomioistuimen tuomioita: joko tuomiot, jotka tulkitsevat tiettyä säädöstä tai sen artiklaa (esim. tietosuoja-asetuksen 6 artikla), tai haku otsikon sanoilla (otsikossa ovat asianosaiset ja usein asiasanat). Palauttaa asianumerot, päivämäärät, ECLI-tunnukset ja tulkitut kohdat uusimmasta vanhimpaan.",
    inputSchema: {
      type: "object",
      properties: {
        saados: { ...common.saados, description: "Säädös, jota tuomiot tulkitsevat (kuten muissa työkaluissa). Valinnainen, jos hakusana annetaan." },
        tyyppi: common.tyyppi,
        artikla: { type: "string", description: "Artikla, jota tuomiot tulkitsevat, esim. \"6\". Vaatii säädöksen." },
        hakusana: { type: "string", description: "Sanat tuomion otsikosta, esim. asianosainen (\"Schrems\") tai aihe (\"henkilötietojen\")." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        kieli: common.kieli,
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
      },
    },
  },
  {
    name: "eu_tuomio",
    description:
      "Palauttaa EU-tuomioistuimen tuomion: asianosaiset, päivämäärä, ECLI, tulkitut säännökset ja tuomiolauselma (ratkaisu). Parametrilla kohdat tuomion perustelujen numeroidut kohdat (esim. \"94-105\"), parametrilla hakusana osumat kohtineen.",
    inputSchema: {
      type: "object",
      properties: {
        tuomio: { type: "string", description: "Asianumero (\"C-311/18\", \"T-604/18\"), CELEX-numero (\"62018CJ0311\") tai ECLI-tunnus." },
        kohdat: { type: "string", description: "Numeroidut kohdat, esim. \"94-105\" tai \"134, 168-170\". Enintään 60 kohtaa kerralla. Valinnainen." },
        hakusana: { type: "string", description: "Etsittävä merkkijono tuomion tekstistä. Valinnainen." },
        kieli: common.kieli,
      },
      required: ["tuomio"],
    },
  },
];

const TITLES = {
  hae_eu_saadoksia: "Hae EU-säädöksiä",
  eu_saados_tiedot: "EU-säädöksen tiedot",
  hae_eu_artikla: "Hae EU-säädöksen artikla",
  etsi_eu_saadoksesta: "Etsi EU-säädöksen tekstistä",
  hae_eu_tuomioita: "Hae EU-tuomioita",
  eu_tuomio: "EU-tuomio",
};
for (const t of TOOLS) {
  t.annotations = { title: TITLES[t.name] ?? t.name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

// ---------- Apufunktiot ----------

class UserError extends Error {}

const asLang = (v) => (v === "sv" || v === "en" ? v : "fi");

function fmtDate(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${+m[3]}.${+m[2]}.${m[1]}` : String(iso ?? "");
}

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + "\n\n… (Tuloste katkaistu pituuden vuoksi. Hae tarvittaessa yksittäinen artikla tai liite.)";
}

const today = () => new Date().toISOString().slice(0, 10);

/** Säädösviitteestä CELEX-numero. */
async function resolveAct(args) {
  if (args.tyyppi && !TYPE_LETTER[args.tyyppi]) throw new UserError("Tyyppi on asetus, direktiivi tai paatos.");
  const r = parseActRef(args.saados, args.tyyppi);
  if (r.error) throw new UserError(r.error);
  const found = await existing(r.candidates);
  if (!found.length) {
    throw new UserError(
      `Säädöstä ${r.candidates.map(shortId).join(" / ")} ei löytynyt. Tarkista numero ja tyyppi, tai etsi nimellä hae_eu_saadoksia-työkalulla.`,
    );
  }
  if (found.length > 1) {
    const names = await titles(found, asLang(args.kieli)).catch(() => ({}));
    throw new UserError(
      "Numerolla on useita säädöksiä. Anna tyyppi tai CELEX-numero:\n" +
        found.map((c) => `- ${shortId(c)} (CELEX ${c})${names[c] ? `: ${names[c].slice(0, 200)}` : ""}`).join("\n"),
    );
  }
  return found[0];
}

/**
 * Valitsee tekstin version. Palauttaa { celex, kind, date, future, note }.
 * kind: "consolidated" | "original".
 */
function chooseVersion(baseCelex, versions, versio) {
  const now = today();
  const future = versions.filter((v) => v.date > now).sort((a, b) => (a.date < b.date ? -1 : 1));
  const original = { celex: baseCelex, kind: "original", date: null, future, note: "" };
  if (versio === "alkuperainen") return original;
  let at = now;
  if (versio) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(versio)) throw new UserError("Versio on \"alkuperainen\" tai päivämäärä muodossa VVVV-KK-PP.");
    at = versio;
  }
  const v = versions.find((x) => x.date <= at);
  if (!v) {
    return {
      ...original,
      note: versions.length
        ? `Päivämääränä ${fmtDate(at)} ei ole konsolidoitua versiota (ensimmäinen ${fmtDate(versions.at(-1).date)}), joten näytetään alkuperäinen teksti.`
        : "",
    };
  }
  return { celex: v.celex, kind: "consolidated", date: v.date, future: versio ? [] : future, note: "" };
}

const partKey = (celex, lang, part) =>
  `https://publications.europa.eu/resource/celex/${encodeURIComponent(celex)}?_lang=${lang}&_index=${DOC_INDEX_VERSION}&_part=${part}`;

/** Asiakirjan hakemisto (base) ja kappaleosien lataaja. */
async function loadDoc(celex, lang) {
  let base = await getDerived(partKey(celex, lang, "base"), DOC_TTL);
  let built = null;
  const build = async () => {
    const text = await fetchDocument(celex, lang, DOC_TTL);
    if (text === null) {
      throw new UserError(
        `Tekstiä ${celex} ei ole saatavilla HTML-muodossa kielellä ${lang}. Osa vanhemmista alkuperäisistä teksteistä on julkaisutoimiston aineistossa vain PDF:nä. ` +
          `Kokeile konsolidoitua tekstiä (jätä versio pois), toista kieltä tai lue teksti EUR-Lexistä: ${eurlexUrl(celex, lang)}`,
      );
    }
    // Sektori 6 = oikeuskäytäntö: tunnistetaan numeroidut kohdat ja tuomiolauselma.
    const idx = buildDocIndex(text, { judgment: celex.startsWith("6") });
    if (!idx) throw new UserError(`Säädöksen ${celex} tekstiä ei voitu tulkita.`);
    const shards = [[]];
    const starts = [0];
    let n = 0;
    for (const t of idx.paras) {
      if (n >= SHARD_CHARS && shards.length < MAX_SHARDS) {
        starts.push(starts.at(-1) + shards.at(-1).length);
        shards.push([]);
        n = 0;
      }
      shards.at(-1).push(t);
      n += t.length;
    }
    // Sisällysluettelo on oma osansa: artiklahaku ei tarvitse sitä.
    const { toc, ...rest } = idx.base;
    const b = { ...rest, shardStarts: starts };
    await putDerived(
      [[partKey(celex, lang, "base"), b], [partKey(celex, lang, "toc"), toc], ...shards.map((s, i) => [partKey(celex, lang, `p${i}`), s])],
      DOC_TTL,
    );
    return { base: b, shards, toc };
  };
  if (!base || base.v !== DOC_INDEX_VERSION) {
    built = await build();
    base = built.base;
  }
  const doc = { celex, lang, base };
  doc.toc = async () => {
    if (built) return built.toc;
    const t = await getDerived(partKey(celex, lang, "toc"), DOC_TTL);
    if (t !== undefined) return t;
    built = await build();
    doc.base = built.base;
    return built.toc;
  };
  /** Kappaleet väleiltä [[s, e], ...]. */
  doc.paras = async (ranges) => {
    const starts = doc.base.shardStarts;
    const partOf = (i) => {
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1] <= i) k++;
      return k;
    };
    const need = new Set();
    for (const [s, e] of ranges) for (let k = partOf(s); k <= partOf(Math.max(s, e - 1)); k++) need.add(k);
    const loaded = new Map();
    for (const k of need) {
      let p = built?.shards[k];
      if (p === undefined) p = await getDerived(partKey(celex, lang, `p${k}`), DOC_TTL);
      if (p === undefined) {
        // Osa poistunut välimuistista: muodostetaan hakemisto uudelleen.
        built = await build();
        doc.base = built.base;
        return doc.paras(ranges);
      }
      loaded.set(k, p);
    }
    const out = [];
    for (const [s, e] of ranges) for (let i = s; i < e; i++) out.push(loaded.get(partOf(i))[i - starts[partOf(i)]]);
    return out;
  };
  return doc;
}

const normId = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/artikla|artikel|article|liite|bilaga|annex|kappale/g, "")
    .replace(/[\s.()]/g, "");

function header(info, ver, lang) {
  const lines = [info.title || shortId(info.celex)];
  lines.push(`Tunnus: ${shortId(info.celex)}, CELEX ${info.celex}${info.eli ? `, ELI ${info.eli}` : ""}.`);
  if (info.inForce === false) lines.push(`VOIMASSAOLO: säädös EI ole voimassa${info.endOfValidity ? ` (päättynyt ${fmtDate(info.endOfValidity)})` : ""}.`);
  if (ver.kind === "consolidated") {
    lines.push(
      `Teksti: KONSOLIDOITU versio ${fmtDate(ver.date)} (CELEX ${ver.celex}). Konsolidoitu teksti on EUR-Lexin dokumentointiväline eikä oikeudellisesti sitova; virallinen teksti on EU:n virallisessa lehdessä julkaistu säädös ja sen muutokset.`,
    );
  } else {
    lines.push("Teksti: ALKUPERÄINEN, EU:n virallisessa lehdessä julkaistu (ei sisällä myöhempiä muutoksia).");
  }
  if (ver.note) lines.push(ver.note);
  if (ver.future?.length) {
    lines.push(
      `HUOM: tulossa konsolidoitu versio, joka on voimassa ${ver.future.map((v) => fmtDate(v.date)).join(", ")} alkaen. Muutettu sanamuoto saadaan versio-parametrilla (esim. versio: "${ver.future[0].date}").`,
    );
  }
  if (info.titleLang !== lang) lines.push(`Säädöksen nimi on englanniksi, koska nimeä ei ole kielellä ${lang}.`);
  lines.push(`Lähde: ${eurlexUrl(ver.celex, lang)}`);
  return lines.join("\n");
}

/** Muutosmerkintöjen selite niille merkeille, jotka tekstissä esiintyvät. */
function legendFor(base, text) {
  if (!base.legend) return "";
  const marks = [...new Set([...text.matchAll(/[►▼]([MACB]\d*)/g)].map((m) => m[1]))];
  const lines = marks.filter((k) => base.legend[k]).map((k) => `${k} = ${base.legend[k]}`);
  if (!lines.length) return "";
  return "Muutosmerkinnät (▼ alkaa, ►…◄ rajaa muutetun kohdan; B = alkuperäinen, M = muutos, A = liittymisasiakirja, C = oikaisu):\n" + lines.join("\n");
}

const ACT_TTL = 6 * 3600;

/**
 * Säädöksen tunnistus, perustiedot ja versiot. Tallennetaan yhtenä välimuistimerkintänä
 * viitteen mukaan, jotta kutsu tekee yhden välimuistiluvun kolmen SPARQL-vastauksen sijaan.
 */
async function loadAct(args) {
  const lang = asLang(args.kieli);
  const ref = String(args.saados ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  const key = `https://publications.europa.eu/resource/celex/_act?ref=${encodeURIComponent(ref)}&type=${args.tyyppi ?? ""}&lang=${lang}&v=1`;
  const hit = await getDerived(key, ACT_TTL);
  if (hit) return { lang, ...hit };
  const celex = await resolveAct(args);
  const [info, versions] = await Promise.all([workInfo(celex, lang), consolidatedVersions(celex)]);
  if (!info) throw new UserError(`Säädöksen ${celex} tietoja ei löytynyt.`);
  await putDerived([[key, { celex, info, versions }]], ACT_TTL);
  return { lang, celex, info, versions };
}

// ---------- Toteutukset ----------

async function haeEuSaadoksia(args) {
  const lang = asLang(args.kieli);
  const page = Math.max(1, Number(args.sivu) || 1);
  if (args.tyyppi && !TYPE_LETTER[args.tyyppi]) throw new UserError("Tyyppi on asetus, direktiivi tai paatos.");
  const rows = await searchActs({
    words: args.hakusana,
    types: args.tyyppi ? [TYPE_LETTER[args.tyyppi]] : null,
    inForce: args.vain_voimassa !== false,
    from: args.alkaen_vuosi,
    to: args.paattyen_vuosi,
    lang,
    page,
  });
  if (rows === null) throw new UserError("Anna hakusana.");
  if (!rows.length) {
    return page > 1 ? "Ei enempää tuloksia." : "Ei osumia. Kokeile sanan vartaloa (esim. \"tietosuoj\"), vähempiä sanoja tai vain_voimassa=false.";
  }
  const lines = rows.slice(0, 10).map(
    (r) => `${shortId(r.celex)} (CELEX ${r.celex}), ${fmtDate(r.date)}${r.inForce === false ? ", EI voimassa" : ""}\n  ${r.title.slice(0, 400)}`,
  );
  let out = `EU-säädökset (sivu ${page}, uusimmasta vanhimpaan):\n\n` + lines.join("\n\n");
  if (rows.length > 10) out += `\n\nLisää tuloksia: hae sivu ${page + 1}.`;
  out += "\n\nHae tiedot eu_saados_tiedot-työkalulla tai teksti hae_eu_artikla-työkalulla (saados: CELEX-numero).";
  return out;
}

async function euSaadosTiedot(args) {
  const { lang, celex, info, versions } = await loadAct(args);
  const ver = chooseVersion(celex, versions, args.versio);
  const [rels, doc] = await Promise.all([relations(celex, lang), loadDoc(ver.celex, lang)]);
  const out = [header(info, ver, lang), ""];
  if (info.date) out.push(`Annettu: ${fmtDate(info.date)}`);
  if (info.entryIntoForce.length) out.push(`Voimaantulo- ja soveltamispäivät: ${info.entryIntoForce.map(fmtDate).join(", ")}`);
  if (info.inForce !== null) out.push(`Voimassa: ${info.inForce ? "kyllä" : "ei"}${info.endOfValidity ? `, voimassaolo päättyy ${fmtDate(info.endOfValidity)}` : ""}`);
  if (versions.length) {
    const now = today();
    out.push(
      "",
      `Konsolidoidut versiot (${versions.length}, uusimmasta):`,
      ...versions.slice(0, 12).map((v) => `- ${fmtDate(v.date)} (CELEX ${v.celex})${v.date > now ? " EI VIELÄ VOIMASSA" : ""}`),
    );
  } else {
    out.push("", "Konsolidoituja versioita ei ole: alkuperäinen teksti on ajantasainen tai säädöstä ei ole konsolidoitu.");
  }
  const amending = rels.filter((r) => r.rel === "muuttaa" && /^3\d{4}[RLD]\d{4}$/.test(r.celex));
  const repealing = rels.filter((r) => r.rel === "kumoaa");
  if (amending.length) {
    out.push("", `Muuttavat säädökset (${amending.length}${amending.length > 15 ? ", näytetään 15 uusinta" : ""}):`);
    for (const r of amending.slice(0, 15)) out.push(`- ${shortId(r.celex)} (${fmtDate(r.date)})${r.title ? `: ${r.title.slice(0, 200)}` : ""}`);
  }
  if (repealing.length) {
    out.push("", "Kumoava säädös:");
    for (const r of repealing.slice(0, 5)) out.push(`- ${shortId(r.celex)} (${fmtDate(r.date)})${r.title ? `: ${r.title.slice(0, 200)}` : ""}`);
  }
  const b = doc.base;
  out.push(
    "",
    `Rakenne: ${b.articles.length} artiklaa, ${b.annexes.length} liitettä${b.recitals.length ? `, ${b.recitals.length} johdanto-osan perustelukappaletta` : ""}.`,
    "Sisällys:",
    (await doc.toc()) || "(sisällysluetteloa ei saatu muodostettua)",
  );
  return clip(out.join("\n"));
}

async function haeEuArtikla(args) {
  const given = ["artikla", "johdanto_kappale", "liite"].filter((k) => args[k] !== undefined && args[k] !== "");
  if (given.length !== 1) throw new UserError("Anna yksi: artikla, johdanto_kappale tai liite. Sisällysluettelo: eu_saados_tiedot.");
  const what = given[0];
  const { lang, celex, info, versions } = await loadAct(args);
  let ver = chooseVersion(celex, versions, args.versio);
  if (what === "johdanto_kappale" && ver.kind === "consolidated") {
    // Konsolidoiduissa teksteissä ei ole johdanto-osaa.
    ver = { ...chooseVersion(celex, versions, "alkuperainen"), note: "Johdanto-osan perustelukappaleet ovat vain alkuperäisessä tekstissä." };
  }
  const doc = await loadDoc(ver.celex, lang);
  const b = doc.base;
  const want = normId(args[what]);
  const list = what === "artikla" ? b.articles : what === "liite" ? b.annexes : b.recitals;
  let item = list.find((x) => normId(x.n) === want);
  if (!item && what === "liite" && list.length === 1 && (want === "1" || want === "")) item = list[0];
  if (!item) {
    const names = { artikla: "Artiklaa", liite: "Liitettä", johdanto_kappale: "Johdanto-osan perustelukappaletta" };
    const avail = list.map((x) => x.n).slice(0, 250);
    throw new UserError(
      `${names[what]} ${args[what]} ei löytynyt tekstistä (${ver.kind === "consolidated" ? `konsolidoitu ${fmtDate(ver.date)}` : "alkuperäinen"}). ` +
        (avail.length ? `Saatavilla: ${avail.join(", ")}.` : "Tekstistä ei tunnistettu tällaisia osia."),
    );
  }
  let paras = await doc.paras(item.parts);
  if (what === "johdanto_kappale" && paras.length && !/^\(\d+\)/.test(paras[0])) paras = [`(${item.n}) ${paras[0]}`, ...paras.slice(1)];
  const text = paras.join("\n");
  const out = [header(info, ver, lang), "", text];
  const legend = legendFor(b, text);
  if (legend) out.push("", legend);
  return clip(out.join("\n"));
}

async function etsiEuSaadoksesta(args) {
  const q = String(args.hakusana ?? "").trim();
  if (q.length < 3) throw new UserError("Hakusanan pitää olla vähintään 3 merkkiä.");
  const { lang, celex, info, versions } = await loadAct(args);
  const ver = chooseVersion(celex, versions, args.versio);
  const doc = await loadDoc(ver.celex, lang);
  const b = doc.base;
  const all = await doc.paras([[0, b.nParas]]);
  const where = new Array(b.nParas).fill("");
  const label = (x, kind) => (kind === "art" ? `${x.h ?? `${x.n} artikla`}${x.title ? ` ${x.title}` : ""}` : kind === "anx" ? x.h ?? `Liite ${x.n}` : `Johdanto-osan perustelukappale (${x.n})`);
  for (const [list, kind] of [[b.articles, "art"], [b.annexes, "anx"], [b.recitals, "rct"]]) {
    for (const x of list) for (const [s, e] of x.parts) for (let i = s; i < e; i++) where[i] = label(x, kind);
  }
  const ql = q.toLowerCase();
  const hits = [];
  for (let i = 0; i < all.length && hits.length < 30; i++) {
    const j = all[i].toLowerCase().indexOf(ql);
    if (j === -1) continue;
    const start = Math.max(0, j - 120);
    hits.push({ where: where[i] || "Muu teksti (johdanto, allekirjoitukset tms.)", text: (start > 0 ? "…" : "") + all[i].slice(start, j + q.length + 160) + (j + q.length + 160 < all[i].length ? "…" : "") });
  }
  const out = [header(info, ver, lang), ""];
  if (!hits.length) out.push(`Hakusanaa "${q}" ei löytynyt. Kokeile sanan vartaloa tai toista kieltä.`);
  else {
    out.push(`Osumat hakusanalle "${q}" (${hits.length}${hits.length >= 30 ? "+, näytetään 30" : ""}):`);
    for (const h of hits) out.push("", h.where, `  ${h.text}`);
  }
  return clip(out.join("\n"));
}

// ---------- Oikeuskäytäntö ----------

/** Otsikko osiin: "Tuomioistuin päivä.#Asianosaiset#Asiasanat#Asia C-…" */
function caseTitleParts(title) {
  // Otsikon osat erotetaan #-merkillä; Cellarin otsikoissa voi olla rivinvaihtoentiteetti &#xd;.
  const parts = String(title ?? "")
    .replace(/&#x?d;|&#13;/gi, " ")
    .split("#")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { head: parts[0] ?? "", rest: parts.slice(1).filter((x) => !/^Asia [CTF]-|^Mål [CTF]-|^Case [CTF]-/.test(x)) };
}

function locationsText(interprets) {
  return interprets
    .filter((x) => x.locations.length || /^3/.test(x.celex))
    .map((x) => `${shortId(x.celex)}${x.locations.length ? `: ${[...new Set(x.locations.map(fmtLocation))].join("; ")}` : ""}`);
}

async function haeEuTuomioita(args) {
  const lang = asLang(args.kieli);
  const page = Math.max(1, Number(args.sivu) || 1);
  let rows;
  let heading;
  if (args.saados) {
    const act = await loadAct(args);
    rows = await casesInterpreting({ actCelex: act.celex, article: args.artikla, from: args.alkaen_vuosi, lang, page });
    if (rows === null) throw new UserError("Anna artikla numerona, esim. \"6\" tai \"10 a\".");
    heading = `Tuomiot, jotka tulkitsevat säädöstä ${shortId(act.celex)}${args.artikla ? `, ${args.artikla} artikla` : ""}`;
  } else if (args.hakusana) {
    rows = await searchCases({ words: args.hakusana, from: args.alkaen_vuosi, lang, page });
    if (rows === null) throw new UserError("Anna hakusana.");
    heading = `Tuomiot hakusanalla "${args.hakusana}"`;
  } else {
    throw new UserError("Anna säädös (ja halutessasi artikla) tai hakusana.");
  }
  if (!rows.length) {
    return page > 1
      ? "Ei enempää tuloksia."
      : args.saados
        ? "Tuomioita ei löytynyt. Tulkintatiedot ovat julkaisutoimiston luokittelua; kokeile ilman artiklaa tai hakusanalla."
        : "Ei osumia. Kokeile sanan vartaloa tai asianosaisen nimeä.";
  }
  const lines = rows.slice(0, 10).map((r) => {
    const t = caseTitleParts(r.title);
    const locs = r.locations?.length ? `\n  Tulkitut kohdat: ${[...new Set(r.locations.map(fmtLocation))].join("; ")}` : "";
    return `${caseNumber(r.jc)} (${fmtDate(r.date)}${r.ecli ? `, ${r.ecli}` : ""}) ${t.head}\n  ${t.rest.join(" ").slice(0, 300)}${locs}`;
  });
  let out = `${heading} (sivu ${page}, uusimmasta vanhimpaan):\n\n${lines.join("\n\n")}`;
  if (rows.length > 10) out += `\n\nLisää tuloksia: hae sivu ${page + 1}.`;
  out += "\n\nHae tuomio eu_tuomio-työkalulla (asianumero).";
  return out;
}

async function resolveCase(args) {
  const r = parseCaseRef(args.tuomio);
  if (r.error) throw new UserError(r.error);
  if (r.ecli) {
    const c = await celexByEcli(r.ecli);
    if (!c) throw new UserError(`Tuomiota ${r.ecli} ei löytynyt.`);
    return c;
  }
  const found = await existing(r.candidates);
  if (!found.length) throw new UserError(`Tuomiota tai määräystä ${args.tuomio} ei löytynyt. Tarkista asianumero, tai etsi hae_eu_tuomioita-työkalulla.`);
  return found[0];
}

/** "94-105, 134" -> [94..105, 134]. */
function parseRanges(s) {
  const out = [];
  for (const part of String(s).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:[-–](\d+))?$/);
    if (!m) throw new UserError("Anna kohdat muodossa \"94-105\" tai \"134, 168-170\".");
    const a = +m[1];
    const b = m[2] ? +m[2] : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(n);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

async function euTuomio(args) {
  const lang = asLang(args.kieli);
  const celex = await resolveCase(args);
  const [info, doc] = await Promise.all([caseInfo(celex, lang), loadDoc(celex, lang)]);
  if (!info) throw new UserError(`Tuomion ${celex} tietoja ei löytynyt.`);
  const b = doc.base;
  const j = b.judgment;
  const t = caseTitleParts(info.title);
  const out = [`${t.head}${t.rest.length ? ` ${t.rest.join(" ")}` : ""}`.slice(0, 600)];
  out.push(`Asia ${caseNumber(celex)}, CELEX ${celex}${info.ecli ? `, ${info.ecli}` : ""}${info.date ? `, annettu ${fmtDate(info.date)}` : ""}.`);
  const locs = locationsText(info.interprets);
  if (locs.length) out.push(`Tulkitut säännökset (julkaisutoimiston luokittelu): ${locs.join(" | ")}`);
  out.push(`Lähde: ${eurlexUrl(celex, lang)}`, "");
  if (!j || !j.jp.length) {
    // Määräykset ja vanhat tuomiot voivat olla rakenteeltaan erilaisia: koko teksti.
    const all = await doc.paras([[0, b.nParas]]);
    out.push(all.join("\n"));
    return clip(out.join("\n"));
  }
  const N = j.jp.length;
  const paraRange = (n) => [j.jp[n - 1], n < N ? j.jp[n] : j.op ? j.op[0] : b.nParas];

  if (args.kohdat) {
    const nums = parseRanges(args.kohdat).filter((n) => n >= 1 && n <= N);
    if (!nums.length) throw new UserError(`Tuomiossa on kohdat 1–${N}.`);
    if (nums.length > 60) throw new UserError("Enintään 60 kohtaa kerralla.");
    const ranges = nums.map(paraRange);
    const texts = await doc.paras(ranges);
    // Kohtien väliin osuvat väliotsikot näkyvät tekstissä sellaisinaan.
    out.push(`Kohdat ${args.kohdat}:`, "", texts.join("\n"));
    return clip(out.join("\n"));
  }

  if (args.hakusana) {
    const q = String(args.hakusana).trim();
    if (q.length < 3) throw new UserError("Hakusanan pitää olla vähintään 3 merkkiä.");
    const all = await doc.paras([[0, b.nParas]]);
    const numAt = new Array(b.nParas).fill(0);
    for (let n = 1; n <= N; n++) {
      const [s, e] = paraRange(n);
      for (let i = s; i < e; i++) numAt[i] = n;
    }
    const ql = q.toLowerCase();
    const hits = [];
    for (let i = 0; i < all.length && hits.length < 30; i++) {
      const k = all[i].toLowerCase().indexOf(ql);
      if (k === -1) continue;
      const start = Math.max(0, k - 120);
      const where = numAt[i] ? `kohta ${numAt[i]}` : j.op && i >= j.op[0] && i < j.op[1] ? "tuomiolauselma" : "muu teksti";
      hits.push(`${where}: ${start > 0 ? "…" : ""}${all[i].slice(start, k + q.length + 160)}…`);
    }
    out.push(hits.length ? `Osumat hakusanalle "${q}" (${hits.length}${hits.length >= 30 ? "+" : ""}):\n\n${hits.join("\n\n")}` : `Hakusanaa "${q}" ei löytynyt.`);
    return clip(out.join("\n"));
  }

  if (j.op) {
    const op = await doc.paras([j.op]);
    out.push("Tuomiolauselma:", op.join("\n"));
  } else {
    out.push("(Tuomiolauselmaa ei tunnistettu tekstistä.)");
  }
  // Väliotsikot ja kohta, josta kukin alkaa.
  const firstNumAfter = (i) => {
    const k = j.jp.findIndex((x) => x > i);
    return k === -1 ? null : k + 1;
  };
  const heads = j.headings
    .filter(([i]) => i > (j.jp[0] ?? 0) - 1)
    .map(([i, h]) => {
      const n = firstNumAfter(i);
      return n ? `- ${h} (kohdasta ${n})` : null;
    })
    .filter(Boolean);
  out.push("", `Tuomiossa on ${N} numeroitua kohtaa. Hae kohtia kohdat-parametrilla (esim. "1-10") tai etsi hakusana-parametrilla.`);
  if (heads.length) out.push("Rakenne:", ...heads.slice(0, 60));
  return clip(out.join("\n"));
}

const HANDLERS = {
  hae_eu_saadoksia: haeEuSaadoksia,
  eu_saados_tiedot: euSaadosTiedot,
  hae_eu_artikla: haeEuArtikla,
  etsi_eu_saadoksesta: etsiEuSaadoksesta,
  hae_eu_tuomioita: haeEuTuomioita,
  eu_tuomio: euTuomio,
};

export async function callTool(name, args = {}) {
  const fn = HANDLERS[name];
  if (!fn) return { isError: true, content: [{ type: "text", text: `Tuntematon työkalu: ${name}` }] };
  try {
    return { content: [{ type: "text", text: await fn(args ?? {}) }] };
  } catch (e) {
    const msg =
      e instanceof UserError
        ? e.message
        : e instanceof SourceError
          ? `EU:n julkaisutoimiston rajapinta ei vastannut (${e.message}). Yritä hetken päästä uudelleen.`
          : `Odottamaton virhe: ${e?.message ?? e}`;
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}
