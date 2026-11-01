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
  parseComRef,
  proposalInfo,
  searchProposals,
} from "./cellar.js";
import { buildDocIndex, DOC_INDEX_VERSION } from "./doc.js";
import { getDerived, putDerived, SourceError } from "./http.js";
import {
  sgReports,
  sgReport,
  eudamedRefs,
  refText,
  actorsByCountry,
  actorBySrn,
  devicesByManufacturer,
  devicesByUdi,
  devicesByBasicUdi,
  ACTOR_TYPES_FI,
  COUNTRY_ISO2,
  EUDAMED_SEARCH_URL,
  SG_SEARCH_URL,
} from "./products.js";

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
  {
    name: "tuotevaroitukset",
    description:
      "Hakee EU:n Safety Gate -järjestelmän hälytyksiä vaarallisista kulutustuotteista (ei elintarvikkeet eikä lääkkeet) viikkoraporteista suomeksi: tuote, merkki, malli, viivakoodi, vaara, riskitaso, toimenpiteet (myynnistä poisto, takaisinveto) ja ilmoittajamaa. Esim. kosmetiikka, lelut, sähkölaitteet. Uusin ensin.",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana tai merkkijono, jota etsitään tuotteesta, merkistä, nimestä, mallista, kuvauksesta, vaarasta ja viivakoodista, esim. \"TPO\", \"geelilakka\", merkin nimi tai EAN-koodi. Valinnainen." },
        kategoria: { type: "string", description: "Tuoteluokka suomeksi tai sen osa, esim. \"kosmetiikka\", \"lelut\", \"sähkölaitteet\". Valinnainen." },
        maa: { type: "string", description: "Ilmoittajamaa suomeksi, esim. \"Suomi\", \"Ruotsi\". Valinnainen." },
        viikkoja: { type: "integer", description: "Montako viimeisintä viikkoraporttia käydään läpi (oletus 8, enintään 52)." },
      },
    },
  },
  {
    name: "eu_laiterekisteri",
    description:
      "Hakee EU:n lääkinnällisten laitteiden tietokannasta (EUDAMED) laitteen tai toimijan tiedot: riskiluokka, sovellettava säädös (MDR, IVDR tai vanha direktiivi), markkinatila, valmistaja ja sen SRN-tunnus. Hakutavat: udi_di (pakkauksen UDI-DI), basic_udi, srn (toimijan tunnus, esim. FI-MF-000006499; antaa myös laitteet) tai valmistaja + maa (nimen osa). Laitteen nimellä ei voi hakea ilman toimijaa.",
    inputSchema: {
      type: "object",
      properties: {
        udi_di: { type: "string", description: "Laitteen ensisijainen UDI-DI (esim. pakkauksen GTIN-koodi). Valinnainen." },
        basic_udi: { type: "string", description: "Basic UDI-DI. Valinnainen." },
        srn: { type: "string", description: "Toimijan yksilöllinen rekisterinumero (SRN), esim. FI-MF-000006499. Valinnainen." },
        laite: { type: "string", description: "Rajaa srn-haun laitteet nimen, mallin tai tuotenumeron osalla. Valinnainen." },
        valmistaja: { type: "string", description: "Toimijan nimen osa (valmistaja, maahantuoja tai valtuutettu edustaja). Käytä maa-parametrin kanssa." },
        maa: { type: "string", description: "Toimijan maa suomeksi tai ISO-koodina, esim. \"Suomi\", \"SE\" (oletus Suomi)." },
      },
    },
  },
  {
    name: "hae_eu_ehdotuksia",
    description:
      "Hakee Euroopan komission säädösehdotuksia (COM-asiakirjat: ehdotukset asetuksiksi, direktiiveiksi ja päätöksiksi) nimen sanoilla, vuosilla ja tilalla (vireillä tai hyväksytty). Palauttaa COM-tunnuksen, päivän, menettelytunnuksen (esim. 2021/0106(COD)), tilan ja hyväksytyn säädöksen.",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sanat, jotka ehdotuksen nimessä on oltava. Vähintään 4 merkin sanat katkaistaan vartaloksi, esim. \"kosmeettis\", \"lääkinnällis laittei\"." },
        tila: { type: "string", enum: ["vireilla", "hyvaksytty"], description: "vireilla = käsittely kesken, hyvaksytty = säädös annettu. Valinnainen." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        kieli: common.kieli,
        sivu: { type: "integer", description: "Tulossivu (10 ehdotusta sivulla)." },
      },
    },
  },
  {
    name: "eu_ehdotus",
    description:
      "Palauttaa komission säädösehdotuksen tiedot: nimi, COM-tunnus, antopäivä, valmistellut pääosasto, menettely ja sen tyyppi, tila, hyväksytty säädös, säädökset joita ehdotus muuttaisi, sekä käsittelyn vaiheet päivämäärineen (komissio, Euroopan parlamentti, neuvosto, lausunnot). Ehdotuksen artiklat saa hae_eu_artikla-työkalulla COM-tunnuksella.",
    inputSchema: {
      type: "object",
      properties: {
        ehdotus: { type: "string", description: "COM-tunnus (\"COM(2021) 206\") tai CELEX-numero (\"52021PC0206\")." },
        kaikki_vaiheet: { type: "boolean", description: "true = jokainen vaihe erikseen (oletus: peräkkäiset samanlaiset vaiheet tiivistetään)." },
        kieli: common.kieli,
      },
      required: ["ehdotus"],
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
  hae_eu_ehdotuksia: "Hae komission säädösehdotuksia",
  eu_ehdotus: "Komission säädösehdotus",
  tuotevaroitukset: "EU:n tuotevaroitukset (Safety Gate)",
  eu_laiterekisteri: "EU:n lääkinnällisten laitteiden rekisteri (EUDAMED)",
};
for (const t of TOOLS) {
  t.annotations = { title: TITLES[t.name] ?? t.name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

// ---------- Apufunktiot ----------

class UserError extends Error {}

const lc1 = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
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
  if (info.celex.startsWith("5")) {
    lines.push(`Teksti: KOMISSION EHDOTUS (${shortId(info.celex)}). ${PROPOSAL_NOTE} Menettelyn tila ja hyväksytty säädös: eu_ehdotus-työkalulla.`);
    lines.push(`Lähde: ${eurlexUrl(info.celex, lang)}`);
    return lines.join("\n");
  }
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
  if (/^\s*COM\b/i.test(String(args.saados ?? "")) || /^5\d{4}(PC|DC)/i.test(String(args.saados ?? "").trim())) {
    return euEhdotus({ ehdotus: args.saados, kieli: args.kieli });
  }
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

// ---------- Komission säädösehdotukset ----------

const PROPOSAL_NOTE =
  "Komission ehdotus ei ole voimassa olevaa oikeutta. Parlamentti ja neuvosto voivat muuttaa sitä, ja hyväksytty säädös voi poiketa siitä merkittävästi.";
const procUrl = (proc, lang) => {
  const m = String(proc ?? "").match(/^(\d{4})\/(\d+)/);
  return m ? `https://eur-lex.europa.eu/procedure/${LANGS[lang].eurlex}/${m[1]}_${+m[2]}` : null;
};
const STATUS_FI = { PROP_PENDING: "vireillä", PROP_ADOPTED: "hyväksytty (säädös annettu)", PROP_WITHDRAWN: "peruttu" };

async function resolveProposal(v) {
  const raw = String(v ?? "").trim();
  if (!raw) throw new UserError('Anna ehdotus, esim. "COM(2021) 206" tai CELEX "52021PC0206".');
  const up = raw.toUpperCase().replace(/\s+/g, "");
  const cands = /^5\d{4}(PC|DC)\d{4}/.test(up) ? [up] : parseComRef(raw);
  if (!cands) throw new UserError(`Ehdotusta "${raw}" ei tunnistettu. Anna muodossa "COM(2021) 206" tai CELEX-numerona (52021PC0206).`);
  const found = await existing(cands);
  if (!found.length) throw new UserError(`Asiakirjaa ${cands.map(shortId)[0]} ei löytynyt. Etsi ehdotuksia hae_eu_ehdotuksia-työkalulla.`);
  return found[0];
}

async function haeEuEhdotuksia(args) {
  const lang = asLang(args.kieli);
  const tila = args.tila;
  if (tila && !["vireilla", "hyvaksytty"].includes(tila)) throw new UserError("tila: vireilla tai hyvaksytty.");
  const from = args.alkaen_vuosi ? +args.alkaen_vuosi : null;
  const to = args.paattyen_vuosi ? +args.paattyen_vuosi : null;
  if (!args.hakusana && !from && !to && !tila) throw new UserError("Anna hakusana, vuosi tai tila (esim. tila: vireilla).");
  const page = Math.max(1, Number.parseInt(args.sivu, 10) || 1);
  const rows = await searchProposals({ words: args.hakusana, from, to, tila, lang, page });
  if (!rows.length) return page > 1 ? "Ei enempää tuloksia." : "Ei osumia. Kokeile sanan vartaloa (esim. \"kosmeettis\"), toista sanaa tai laajempaa vuosiväliä.";
  const out = [`Komission säädösehdotukset (sivu ${page}, uusimmasta vanhimpaan):`, ""];
  for (const r of rows.slice(0, 10)) {
    const bits = [fmtDate(r.date), r.procs.length ? `menettely ${r.procs.join(", ")}` : null, r.status.length ? STATUS_FI[r.status[0]] ?? r.status[0] : null, r.adopted.length ? `säädös ${r.adopted.map(shortId).join(", ")}` : null].filter(Boolean);
    out.push(`${shortId(r.celex)} (CELEX ${r.celex}), ${bits.join(", ")}`);
    out.push(`  ${String(r.title).replace(/\s+/g, " ").slice(0, 400)}`);
  }
  if (rows.length > 10) out.push("", `Lisää tuloksia: sivu ${page + 1}.`);
  out.push("", "Menettelyn vaiheet eu_ehdotus-työkalulla; ehdotuksen artiklat hae_eu_artikla-työkalulla (saados: \"COM(vuosi) numero\"). Vanhoilla ehdotuksilla menettelytietoja ei aina ole.");
  return clip(out.join("\n"));
}

async function euEhdotus(args) {
  const lang = asLang(args.kieli);
  const celex = await resolveProposal(args.ehdotus);
  const info = await proposalInfo(celex, lang);
  if (!info) throw new UserError(`Ehdotuksen ${shortId(celex)} tietoja ei löytynyt.`);
  const out = [String(info.title).replace(/\s+/g, " ").trim() || shortId(celex)];
  out.push(`Tunnus: ${shortId(celex)}, CELEX ${celex}${info.titleLang !== lang ? " (nimi englanniksi; kieliversiota ei ole)" : ""}.`);
  if (info.date) out.push(`Annettu: ${fmtDate(info.date)}${info.dg ? `, valmistellut ${info.dg}` : ""}.`);
  if (info.procedure) out.push(`Menettely: ${info.procedure}${info.procedureType ? `, ${lc1(info.procedureType)}` : ""}.`);
  const st = info.withdrawn ? "peruttu" : info.statusLabel ?? STATUS_FI[info.status] ?? null;
  if (st) out.push(`Tila: ${lc1(st)}${info.adoptedDate && info.status === "PROP_ADOPTED" ? ` (${fmtDate(info.adoptedDate)})` : ""}.`);
  if (info.adopted.length) {
    const names = await titles(info.adopted, lang).catch(() => ({}));
    out.push("", "Hyväksytty säädös:", ...info.adopted.map((c) => `- ${shortId(c)} (CELEX ${c})${names[c] ? `: ${names[c].slice(0, 250)}` : ""}`));
    out.push("Voimassa oleva teksti: hae_eu_artikla tai eu_saados_tiedot hyväksytyn säädöksen numerolla.");
  }
  if (info.amends.length) out.push("", `Ehdotus muuttaisi säädöksiä (${info.amends.length}): ${info.amends.slice(0, 30).map(shortId).join(", ")}${info.amends.length > 30 ? " …" : ""}`);

  if (info.events.length) {
    // Toistuvat samanlaiset vaiheet (esim. neuvoston valmisteluelinten käsittelyt) tiivistetään.
    const all = args.kaikki_vaiheet === true;
    const lines = [];
    let prev = null;
    let count = 0;
    let first = null;
    const flush = () => {
      if (!prev) return;
      lines.push(`- ${fmtDate(first)}${count > 1 ? `–${fmtDate(prev.date)} (${count} kertaa)` : ""} ${prev.label ?? prev.code}${prev.inst ? ` [${prev.inst}]` : ""}`);
    };
    for (const e of info.events) {
      if (!all && prev && prev.code === e.code) {
        count++;
        prev = e;
        continue;
      }
      flush();
      prev = e;
      first = e.date;
      count = 1;
    }
    flush();
    out.push("", `Vaiheet (${info.events.length}):`, ...lines.slice(0, 80));
    if (lines.length > 80) out.push(`… ja ${lines.length - 80} muuta.`);
  } else {
    out.push("", "Menettelyn vaiheita ei ole julkaisutoimiston aineistossa (koskee erityisesti vanhoja ehdotuksia).");
  }
  out.push("", PROPOSAL_NOTE, `Ehdotuksen teksti: hae_eu_artikla tai etsi_eu_saadoksesta (saados: "${shortId(celex)}").`);
  out.push(`Lähde: ${eurlexUrl(celex, lang)}`);
  const pu = procUrl(info.procedure, lang);
  if (pu) out.push(`Menettely EUR-Lexissä: ${pu}`);
  return clip(out.join("\n"));
}

// ---------- Safety Gate ----------

const SG_SOURCE = "Lähde: EU Safety Gate (Euroopan komissio), viikkoraportit, avoin data CC0";
const MAX_ALERTS = 30;
const foldText = (s) => String(s ?? "").toLowerCase();
const trimTo = (s, n) => (s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function alertText(a) {
  const lines = [`${a.caseNumber ?? "(ei numeroa)"} · ${fmtDate(a.date)} · ${a.category ?? ""}`];
  const what = [a.product, a.brand && `merkki ${a.brand}`, a.name && a.name !== a.product ? `nimi ${a.name}` : null, a.model && `malli ${a.model}`].filter(Boolean);
  lines.push(`Tuote: ${what.join(", ")}`);
  const ids = [a.barcode && `viivakoodi ${a.barcode}`, a.batch && `erä ${a.batch}`].filter(Boolean);
  if (ids.length) lines.push(`Tunnisteet: ${ids.join(", ")}`);
  if (a.description) lines.push(`Kuvaus: ${trimTo(a.description, 300)}`);
  lines.push(`Riski: ${[a.level, a.riskType].filter(Boolean).join(", ")}`);
  if (a.danger) lines.push(`Vaara: ${trimTo(a.danger, 600)}`);
  const ms = a.measures.map((m) =>
    m.ordered === null ? m.measure : `${m.measure} (${m.ordered ? "viranomaisen määräämä" : "toimijan oma"}${m.operator ? `, ${m.operator.toLowerCase()}` : ""}${m.from ? `, ${m.from}` : ""})`,
  );
  if (ms.length) lines.push(`Toimenpiteet: ${trimTo(ms.join("; "), 600)}`);
  if (a.trader) lines.push(`Verkkokauppa: ${trimTo(a.trader, 200)}`);
  lines.push(`Ilmoittaja: ${a.notifying ?? "?"} · alkuperämaa: ${a.origin ?? "?"}`);
  if (a.link) lines.push(`Lähde: ${a.link}`);
  return lines.join("\n");
}

async function tuotevaroitukset(args) {
  const weeks = Math.min(52, Math.max(1, Number.parseInt(args.viikkoja, 10) || 8));
  const q = foldText(args.hakusana).trim();
  const cat = foldText(args.kategoria).trim();
  const country = foldText(args.maa).trim();
  if (q && q.length < 2) throw new UserError("Hakusanan pitää olla vähintään 2 merkkiä.");
  const reports = (await sgReports()).slice(0, weeks);
  if (!reports.length) throw new SourceError("Safety Gate -raporttien luetteloa ei saatu", 0);
  const all = (await mapLimit(reports, 6, sgReport)).flat();
  const hits = all.filter((a) => {
    if (cat && !foldText(a.category).includes(cat)) return false;
    if (country && !foldText(a.notifying).includes(country)) return false;
    if (q) {
      const hay = [a.product, a.brand, a.name, a.model, a.description, a.danger, a.barcode, a.batch, a.caseNumber].map(foldText).join(" \u0001 ");
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const span = `${fmtDate(reports.at(-1).date)}–${fmtDate(reports[0].date)} (${reports.length} viikkoraporttia, ${all.length} hälytystä)`;
  const filt = [q && `hakusana "${args.hakusana}"`, cat && `kategoria "${args.kategoria}"`, country && `ilmoittajamaa "${args.maa}"`].filter(Boolean).join(", ");
  if (!hits.length) {
    return [`Safety Gate ${span}${filt ? `, ${filt}` : ""}: ei osumia.`, weeks < 52 ? "Laajenna tarvittaessa viikkoja-parametrilla (enintään 52)." : null, `Haku verkossa: ${SG_SEARCH_URL}`, SG_SOURCE].filter(Boolean).join("\n");
  }
  const out = [`Safety Gate ${span}${filt ? `, ${filt}` : ""}: ${hits.length} ${hits.length === 1 ? "hälytys" : "hälytystä"}${hits.length > MAX_ALERTS ? `, näytetään ${MAX_ALERTS} uusinta` : ""}.`, ""];
  out.push(hits.slice(0, MAX_ALERTS).map(alertText).join("\n\n"));
  out.push("", "Hälytys koskee juuri kuvattua tuotetta (merkki, malli, erä); saman tuotetyypin muut tuotteet eivät ole sen kohteena.", SG_SOURCE);
  return clip(out.join("\n"));
}

// ---------- EUDAMED ----------

const EUDAMED_SOURCE = "Lähde: EUDAMED (Euroopan komissio), julkinen rajapinta";
const MAX_DEVICES = 40;

const flag = (v) => Number(v) === 1;

function deviceText(d, refs, full = true) {
  const name = d.TRADE_NAME && d.DEVICE_NAME && d.TRADE_NAME !== d.DEVICE_NAME ? `${d.TRADE_NAME} (${d.DEVICE_NAME})` : d.TRADE_NAME ?? d.DEVICE_NAME ?? "(nimetön)";
  const head = [name, d.DEVICE_MODEL && `malli ${d.DEVICE_MODEL}`, d.REFERENCE && `tuotenro ${d.REFERENCE}`].filter(Boolean).join(", ");
  const risk = refText(refs, "RISK_CLASS_ID", d.RISK_CLASS_ID);
  const leg = refText(refs, "APPLICABLE_LEGISLATION_ID", d.APPLICABLE_LEGISLATION_ID);
  const status = refText(refs, "DEVICE_STATUS_TYPE_ID", d.DEVICE_STATUS_TYPE_ID);
  if (!full) return `- ${head} · UDI-DI ${d.PRIMARY_DI} · ${[risk, leg?.replace(/ \(.*$/, ""), status].filter(Boolean).join(" · ")}`;
  const lines = [head, `UDI-DI: ${d.PRIMARY_DI} · Basic UDI-DI: ${d.BASIC_UDI ?? "?"}`];
  lines.push(`Valmistaja: ${d.MF_NAME ?? "?"} (SRN ${d.MF_SRN ?? "?"})`);
  if (d.AR_NAME || d.AR_SRN) lines.push(`Valtuutettu edustaja: ${d.AR_NAME ?? "?"} (SRN ${d.AR_SRN ?? "?"})`);
  if (risk) lines.push(`Riskiluokka: ${risk}`);
  if (leg) lines.push(`Säädös: ${leg}${d.DEVICE_CRITERION === "LEGACY" ? " (direktiivin mukainen ns. legacy-laite)" : ""}`);
  if (status) lines.push(`Markkinatila: ${status}`);
  const first = refText(refs, "PLACED_ON_THE_MARKET_ID", d.PLACED_ON_THE_MARKET_ID);
  if (first) lines.push(`Ensimmäinen markkinoille saattamisen maa: ${first}`);
  if (d.NOMENCLATURE_CODE) lines.push(`EMDN-nimikkeistökoodi: ${String(d.NOMENCLATURE_CODE).trim()}`);
  const special = refText(refs, "SPECIAL_DEVICE_TYPE_ID", d.SPECIAL_DEVICE_TYPE_ID);
  if (special) lines.push(`Erityinen laitetyyppi: ${special}`);
  const flags = [
    flag(d.STERILE) && "steriili",
    flag(d.STERILIZATION) && "steriloitava ennen käyttöä",
    flag(d.REUSABLE) && "uudelleenkäytettävä",
    flag(d.IMPLANTABLE) && "implantoitava",
    flag(d.ACTIVE) && "aktiivinen laite",
    flag(d.MEASURING_FUNCTION) && "mittaustoiminto",
    flag(d.LATEX) && "sisältää lateksia",
    flag(d.CMR_SUBSTANCE) && "sisältää CMR-aineita",
    flag(d.ENDOCRINE_DISRUPTOR) && "sisältää hormonitoimintaa häiritseviä aineita",
    flag(d.MEDICINAL_PRODUCT) && "sisältää lääkeaineen",
  ].filter(Boolean);
  if (flags.length) lines.push(`Ominaisuudet: ${flags.join(", ")}`);
  return lines.join("\n");
}

function actorText(a) {
  const type = ACTOR_TYPES_FI[a.ACTOR_TYPE] ?? a.ACTOR_TYPE;
  const addr = [[a.ACT_ADDR_STREET_NAME, a.ACT_ADDR_BUILDING_NUMBER].filter(Boolean).join(" "), [a.ACT_ADDR_POSTAL_ZONE, a.ACT_ADDR_CITY_NAME].filter(Boolean).join(" "), a.ACT_ADDR_COUNTRY_NAME]
    .filter(Boolean)
    .join(", ")
    .replace(/\s{2,}/g, " ");
  const lines = [`${a.NAME}${a.ABBREVIATED_NAME && a.ABBREVIATED_NAME !== a.NAME ? ` (${a.ABBREVIATED_NAME})` : ""} · ${type} · SRN ${a.ACTOR_ID}`];
  const more = [a.STATUS && `tila ${a.STATUS === "Active" ? "aktiivinen" : a.STATUS}`, a.EUROPEAN_VAT_NUMBER && `ALV-tunnus ${a.EUROPEAN_VAT_NUMBER}`].filter(Boolean);
  if (more.length) lines.push(more.join(" · "));
  if (addr) lines.push(`Osoite: ${addr}`);
  const contact = [a.ACT_TELEPHONE, a.ACT_WEBSITE].filter(Boolean);
  if (contact.length) lines.push(`Yhteystiedot: ${contact.join(" · ")}`);
  return lines.join("\n");
}

function toIso2(v) {
  const s = String(v ?? "suomi").trim();
  if (/^[a-z]{2}$/i.test(s)) return s.toUpperCase();
  const iso = COUNTRY_ISO2[s.toLowerCase()];
  if (!iso) throw new UserError(`Maata "${s}" ei tunnistettu. Anna maan nimi suomeksi tai kaksikirjaiminen ISO-koodi (esim. SE).`);
  return iso;
}

const EUDAMED_NOTE =
  "EUDAMED sisältää vain rekisteröidyt laitteet ja toimijat, ja haku vaatii tarkan tunnuksen. Se, ettei laitetta löydy, ei yksin tarkoita, ettei laite olisi markkinakelpoinen. Suomessa toimivaltainen viranomainen on Fimea.";

async function euLaiterekisteri(args) {
  const di = String(args.udi_di ?? "").trim();
  const basic = String(args.basic_udi ?? "").trim();
  const srn = String(args.srn ?? "").trim();
  const name = String(args.valmistaja ?? "").trim();

  if (di || basic) {
    const [rows, refs] = await Promise.all([di ? devicesByUdi(di) : devicesByBasicUdi(basic), eudamedRefs()]);
    if (!rows.length) return [`${di ? `UDI-DI ${di}` : `Basic UDI-DI ${basic}`}: ei laitetta EUDAMEDissa.`, EUDAMED_NOTE, `Haku verkossa: ${EUDAMED_SEARCH_URL}`, EUDAMED_SOURCE].join("\n");
    const shown = rows.slice(0, di ? 5 : MAX_DEVICES);
    const out = [rows.length > 1 ? `${rows.length} laitetta:` : "Laite:", "", shown.map((d) => deviceText(d, refs, rows.length <= 5)).join(rows.length <= 5 ? "\n\n" : "\n")];
    if (rows.length > shown.length) out.push(`… ja ${rows.length - shown.length} muuta.`);
    out.push("", `Haku verkossa: ${EUDAMED_SEARCH_URL}`, EUDAMED_SOURCE);
    return clip(out.join("\n"));
  }

  if (srn) {
    if (!/^[A-Z]{2}-[A-Z]{2}-\d{6,}$/i.test(srn)) throw new UserError("SRN-tunnus on muotoa MAA-TYYPPI-NUMERO, esim. FI-MF-000006499.");
    const [actor, devices, refs] = await Promise.all([actorBySrn(srn), /-(MF|PR)-/i.test(srn) ? devicesByManufacturer(srn) : Promise.resolve(null), eudamedRefs()]);
    if (!actor) return [`SRN ${srn.toUpperCase()}: toimijaa ei löytynyt EUDAMEDista.`, EUDAMED_SOURCE].join("\n");
    const out = [actorText(actor)];
    if (devices) {
      const f = foldText(args.laite).trim();
      const list = f ? devices.filter((d) => [d.TRADE_NAME, d.DEVICE_NAME, d.DEVICE_MODEL, d.REFERENCE].map(foldText).join(" ").includes(f)) : devices;
      out.push("", `Rekisteröityjä laitteita ${devices.length}${f ? `, joista hakuun "${args.laite}" osuu ${list.length}` : ""}.`);
      if (list.length) {
        const shown = list.slice(0, MAX_DEVICES);
        out.push(list.length <= 3 ? shown.map((d) => deviceText(d, refs)).join("\n\n") : shown.map((d) => deviceText(d, refs, false)).join("\n"));
        if (list.length > shown.length) out.push(`… ja ${list.length - shown.length} muuta. Rajaa laite-parametrilla tai hae yksittäinen laite udi_di-parametrilla.`);
      }
    } else {
      out.push("", "Laiteluettelo haetaan vain valmistajan (MF) tai toimenpidepakkauksen kokoajan (PR) tunnuksella.");
    }
    out.push("", EUDAMED_NOTE, EUDAMED_SOURCE);
    return clip(out.join("\n"));
  }

  if (name) {
    if (name.length < 3) throw new UserError("Anna toimijan nimestä vähintään 3 merkkiä.");
    const iso = toIso2(args.maa);
    const all = await actorsByCountry(iso);
    const f = name.toLowerCase();
    const hits = all.filter((a) => `${a.NAME ?? ""} ${a.ABBREVIATED_NAME ?? ""}`.toLowerCase().includes(f));
    if (!hits.length) return [`Maassa ${iso} ei ole EUDAMEDiin rekisteröityä toimijaa, jonka nimessä on "${name}" (${all.length} toimijaa läpikäyty).`, EUDAMED_NOTE, EUDAMED_SOURCE].join("\n");
    const out = [`${hits.length} ${hits.length === 1 ? "toimija" : "toimijaa"} (maa ${iso}, nimessä "${name}"):`, "", hits.slice(0, 20).map(actorText).join("\n\n")];
    if (hits.length > 20) out.push(`… ja ${hits.length - 20} muuta. Tarkenna nimeä.`);
    out.push("", "Hae valmistajan laitteet srn-parametrilla.", EUDAMED_SOURCE);
    return clip(out.join("\n"));
  }

  throw new UserError("Anna udi_di, basic_udi, srn tai valmistaja (ja tarvittaessa maa).");
}

const HANDLERS = {
  hae_eu_saadoksia: haeEuSaadoksia,
  eu_saados_tiedot: euSaadosTiedot,
  hae_eu_artikla: haeEuArtikla,
  etsi_eu_saadoksesta: etsiEuSaadoksesta,
  hae_eu_tuomioita: haeEuTuomioita,
  eu_tuomio: euTuomio,
  hae_eu_ehdotuksia: haeEuEhdotuksia,
  eu_ehdotus: euEhdotus,
  tuotevaroitukset,
  eu_laiterekisteri: euLaiterekisteri,
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
          ? `${name === "tuotevaroitukset" ? "Safety Gate -palvelu" : name === "eu_laiterekisteri" ? "EUDAMED-rajapinta" : "EU:n julkaisutoimiston rajapinta"} ei vastannut (${e.message}). Yritä hetken päästä uudelleen.`
          : `Odottamaton virhe: ${e?.message ?? e}`;
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}
