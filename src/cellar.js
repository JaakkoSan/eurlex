// EU:n julkaisutoimiston Cellar: asiakirjat sisältöneuvottelulla CELEX-numerolla
// ja metatiedot SPARQL-rajapinnasta. Ei vaadi rekisteröitymistä.
//   Asiakirja: https://publications.europa.eu/resource/celex/{CELEX}
//              (Accept: application/xhtml+xml, Accept-Language: fin)
//   SPARQL:    https://publications.europa.eu/webapi/rdf/sparql

import { fetchText, memoGet, memoSet } from "./http.js";

const RESOURCE = "https://publications.europa.eu/resource/celex/";
const SPARQL = "https://publications.europa.eu/webapi/rdf/sparql";
const CDM = "http://publications.europa.eu/ontology/cdm#";
const LANG_URI = "http://publications.europa.eu/resource/authority/language/";

export const LANGS = {
  fi: { code: "fin", uri: "FIN", eurlex: "FI" },
  sv: { code: "swe", uri: "SWE", eurlex: "SV" },
  en: { code: "eng", uri: "ENG", eurlex: "EN" },
};

export const TYPE_LETTER = { asetus: "R", direktiivi: "L", paatos: "D" };
export const TYPE_NAME = { R: "asetus", L: "direktiivi", D: "päätös" };

const DAY = 86400;

// ---------- Säädösviitteen tulkinta ----------

const CELEX_RE = /^([0-9CE])(\d{4})([A-Z]{1,2})(\d{4})(\(\d+\))?$/;
const CONS_RE = /^0(\d{4})([A-Z]{1,2})(\d{4})-(\d{8})$/;

function typeFromText(s) {
  const t = s.toLowerCase();
  if (/asetu|förordning|regulation/.test(t)) return "R";
  if (/direktiiv|direktiv|directive/.test(t)) return "L";
  if (/päätö|paato|beslut|decision/.test(t)) return "D";
  return null;
}

const fullYear = (y) => (y < 100 ? (y >= 52 ? 1900 + y : 2000 + y) : y);
const plausibleYear = (s) => s.length === 4 && +s >= 1952 && +s <= 2100;

/**
 * Tulkitsee säädösviitteen. Palauttaa { candidates: [CELEX...] } tai { error }.
 * Esimerkit: "2016/679" + tyyppi, "asetus (EU) 2016/679", "direktiivi 93/13/ETY",
 * "asetus (EY) N:o 1907/2006", "32016R0679", "http://data.europa.eu/eli/reg/2016/679/oj".
 */
export function parseActRef(input, tyyppi) {
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "Anna säädös, esim. \"2016/679\" tai CELEX \"32016R0679\"." };
  const up = raw.toUpperCase().replace(/\s+/g, "");
  const cons = up.match(CONS_RE);
  if (cons) return { candidates: [`3${cons[1]}${cons[2]}${cons[3]}`] };
  if (CELEX_RE.test(up)) return { candidates: [up] };
  const eli = raw.match(/eli\/(reg|dir|dec)(?:_impl|_del)?\/(\d{4})\/(\d+)/i);
  if (eli) {
    const t = { reg: "R", dir: "L", dec: "D" }[eli[1].toLowerCase()];
    return { candidates: [`3${eli[2]}${t}${eli[3].padStart(4, "0")}`] };
  }
  const m = raw.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
  if (!m) return { error: `Säädösviitettä "${raw}" ei tunnistettu. Anna muodossa "2016/679", "93/13/ETY" tai CELEX-numerona.` };
  const [, a, b] = m;
  let year;
  let number;
  if (/N:o|\bNo\b|\bnr\b/i.test(raw.slice(0, m.index + 1))) {
    number = a;
    year = b;
  } else if (plausibleYear(a) && !plausibleYear(b)) {
    year = a;
    number = b;
  } else if (plausibleYear(b) && !plausibleYear(a)) {
    number = a;
    year = b;
  } else {
    // Kaksinumeroinen vuosi edellä (direktiivit ja päätökset: 93/13/ETY).
    year = a;
    number = b;
  }
  const y = fullYear(+year);
  const t = (tyyppi && TYPE_LETTER[tyyppi]) || typeFromText(raw);
  // Pääte numeron perässä (93/13/ETY, 2011/83/EU) on vain direktiiveillä ja päätöksillä.
  const suffix = /^\s*\/\s*[A-ZÄÖ]{2,}/i.test(raw.slice(m.index + m[0].length));
  const letters = t ? [t] : suffix ? ["L", "D"] : ["R", "L", "D"];
  return { candidates: letters.map((l) => `3${y}${l}${String(+number).padStart(4, "0")}`) };
}

// ---------- SPARQL ----------

const lit = (s) => `"${String(s).replace(/["\\]/g, "")}"^^<http://www.w3.org/2001/XMLSchema#string>`;

async function sparql(query, ttl = 6 * 3600) {
  const url = `${SPARQL}?query=${encodeURIComponent(query)}`;
  // Isolaatin muisti ensin: peräkkäiset kutsut samaan säädökseen toistavat samat kyselyt.
  const hit = memoGet(url);
  if (hit !== undefined) return hit;
  const text = await fetchText(url, { ttl, headers: { Accept: "application/sparql-results+json" } });
  if (text === null) return [];
  const data = JSON.parse(text);
  const rows = data.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  memoSet(url, rows, ttl);
  return rows;
}

/** Mitkä ehdokkaista ovat olemassa (järjestys säilyy). */
export async function existing(candidates) {
  if (candidates.length === 1) return candidates;
  const rows = await sparql(
    `PREFIX cdm: <${CDM}> SELECT DISTINCT ?c WHERE { VALUES ?c { ${candidates.map(lit).join(" ")} } ?w cdm:resource_legal_id_celex ?c . }`,
    30 * DAY,
  );
  const found = new Set(rows.map((r) => r.c));
  return candidates.filter((c) => found.has(c));
}

/** Nimet usealle säädökselle (monitulkintaisen viitteen selventämiseen). */
export async function titles(celexes, lang) {
  const L = LANGS[lang];
  const rows = await sparql(`PREFIX cdm: <${CDM}>
SELECT ?c ?t WHERE { VALUES ?c { ${celexes.map(lit).join(" ")} }
  ?w cdm:resource_legal_id_celex ?c . ?e cdm:expression_belongs_to_work ?w ; cdm:expression_uses_language <${LANG_URI}${L.uri}> ; cdm:expression_title ?t . }`);
  return Object.fromEntries(rows.map((r) => [r.c, r.t]));
}

/** Perustiedot ja nimi (valittu kieli ja englanti varalla). */
export async function workInfo(celex, lang) {
  const L = LANGS[lang];
  const rows = await sparql(`PREFIX cdm: <${CDM}>
SELECT ?p ?o WHERE {
  ?w cdm:resource_legal_id_celex ${lit(celex)} .
  { ?w ?p ?o . FILTER(?p IN (cdm:work_date_document, cdm:resource_legal_in-force, cdm:resource_legal_eli,
      cdm:resource_legal_date_entry-into-force, cdm:resource_legal_date_end-of-validity, cdm:resource_legal_date_signature)) }
  UNION
  { ?e cdm:expression_belongs_to_work ?w ; cdm:expression_uses_language ?p ; cdm:expression_title ?o .
    FILTER(?p IN (<${LANG_URI}${L.uri}>, <${LANG_URI}ENG>)) }
}`);
  if (!rows.length) return null;
  const get = (p) => rows.filter((r) => r.p === CDM + p).map((r) => r.o);
  const title = rows.find((r) => r.p === LANG_URI + L.uri)?.o ?? rows.find((r) => r.p === LANG_URI + "ENG")?.o ?? "";
  const force = get("resource_legal_in-force")[0];
  return {
    celex,
    title,
    titleLang: rows.some((r) => r.p === LANG_URI + L.uri) ? lang : "en",
    date: get("work_date_document")[0] ?? null,
    inForce: force === undefined ? null : force === "1" || force === "true",
    eli: get("resource_legal_eli")[0] ?? null,
    entryIntoForce: [...new Set(get("resource_legal_date_entry-into-force"))].filter((d) => !d.startsWith("1001")).sort(),
    endOfValidity: get("resource_legal_date_end-of-validity").find((d) => !d.startsWith("9999")) ?? null,
  };
}

/** Konsolidoidut versiot uusimmasta vanhimpaan: [{ celex, date }]. */
export async function consolidatedVersions(celex) {
  const rows = await sparql(`PREFIX cdm: <${CDM}>
SELECT DISTINCT ?cc ?d WHERE {
  ?w cdm:resource_legal_id_celex ${lit(celex)} .
  ?c cdm:act_consolidated_based_on_resource_legal ?w ; cdm:resource_legal_id_celex ?cc .
  OPTIONAL { ?c cdm:act_consolidated_date ?d }
}`);
  return rows
    .filter((r) => CONS_RE.test(r.cc))
    .map((r) => {
      const m = r.cc.match(CONS_RE);
      return { celex: r.cc, date: r.d ?? `${m[4].slice(0, 4)}-${m[4].slice(4, 6)}-${m[4].slice(6, 8)}` };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Säädökset, jotka muuttavat tai kumoavat tämän: [{ rel, celex, date, title }]. */
export async function relations(celex, lang) {
  const L = LANGS[lang];
  const rows = await sparql(`PREFIX cdm: <${CDM}>
SELECT DISTINCT ?rel ?celex ?date ?title WHERE {
  ?w cdm:resource_legal_id_celex ${lit(celex)} .
  { ?m cdm:resource_legal_amends_resource_legal ?w . BIND("muuttaa" AS ?rel) }
  UNION { ?m cdm:resource_legal_repeals_resource_legal ?w . BIND("kumoaa" AS ?rel) }
  UNION { ?m cdm:resource_legal_implicitly_repeals_resource_legal ?w . BIND("kumoaa" AS ?rel) }
  ?m cdm:resource_legal_id_celex ?celex ; cdm:work_date_document ?date .
  OPTIONAL { ?e cdm:expression_belongs_to_work ?m ; cdm:expression_uses_language <${LANG_URI}${L.uri}> ; cdm:expression_title ?title }
} ORDER BY DESC(?date) LIMIT 80`);
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.rel}:${r.celex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Otsikkohaku. Sanat katkaistaan vartaloksi (vähintään 4 merkkiä ennen *-merkkiä). */
export async function searchActs({ words, types, inForce, from, to, lang, page }) {
  const L = LANGS[lang];
  const terms = String(words ?? "")
    .split(/[^\p{L}\p{N}-]+/u)
    .map((w) => w.replace(/-/g, " ").trim())
    .filter((w) => w.length >= 2)
    .slice(0, 6)
    .map((w) => (w.length >= 4 && !w.includes(" ") ? `"${w}*"` : `"${w}"`));
  if (!terms.length) return null;
  const typeClass = (types?.length ? types : ["R", "L", "D"]).join("");
  const filters = [`REGEX(STR(?celex), "^3[0-9]{4}[${typeClass}][0-9]{4}$")`];
  if (from) filters.push(`?date >= "${+from}-01-01"^^<http://www.w3.org/2001/XMLSchema#date>`);
  if (to) filters.push(`?date <= "${+to}-12-31"^^<http://www.w3.org/2001/XMLSchema#date>`);
  const force = inForce ? `?w cdm:resource_legal_in-force ?force . FILTER(STR(?force) IN ("1", "true"))` : `OPTIONAL { ?w cdm:resource_legal_in-force ?force }`;
  const rows = await sparql(
    `PREFIX cdm: <${CDM}>
SELECT DISTINCT ?celex ?title ?date ?force WHERE {
  ?e cdm:expression_uses_language <${LANG_URI}${L.uri}> ; cdm:expression_title ?title ; cdm:expression_belongs_to_work ?w .
  ?title bif:contains '${terms.join(" AND ").replace(/'/g, "")}' .
  ?w cdm:resource_legal_id_celex ?celex ; cdm:work_date_document ?date .
  ${force}
  FILTER(${filters.join(" && ")})
} ORDER BY DESC(?date) LIMIT 11 OFFSET ${(Math.max(1, page) - 1) * 10}`,
    3600,
  );
  return rows.map((r) => ({ ...r, inForce: r.force === undefined ? null : r.force === "1" || r.force === "true" }));
}

// ---------- Asiakirja ----------

/**
 * Asiakirjan teksti. Uudet ja konsolidoidut tekstit ovat XHTML:nä, vanhimmat
 * alkuperäiset vain HTML 4:nä. Palauttaa null, jos kieliversiota ei ole.
 */
export async function fetchDocument(celex, lang, ttl) {
  const headers = { "Accept-Language": LANGS[lang].code };
  const xhtml = await fetchText(RESOURCE + encodeURIComponent(celex), { ttl, headers: { ...headers, Accept: "application/xhtml+xml" } });
  if (xhtml !== null) return xhtml;
  return fetchText(RESOURCE + encodeURIComponent(celex), { ttl, headers: { ...headers, Accept: "text/html" } });
}

export function eurlexUrl(celex, lang) {
  return `https://eur-lex.europa.eu/legal-content/${LANGS[lang].eurlex}/TXT/?uri=CELEX:${celex}`;
}

/** Ihmisluettava tunnus CELEX-numerosta: "asetus 2016/679". */
export function shortId(celex) {
  // Perussopimukset ja perusoikeuskirja (sektori 1): 12007P047 = perusoikeuskirjan 47 artikla.
  const t = celex.match(/^1(\d{4})([PEM])(\d{3})?/);
  if (t) {
    const name = { P: "EU:n perusoikeuskirja", E: "SEUT (sopimus Euroopan unionin toiminnasta)", M: "SEU (sopimus Euroopan unionista)" }[t[2]];
    return t[3] ? `${name}, ${+t[3]} art.` : name;
  }
  const m = celex.match(/^3(\d{4})([RLD])(\d{4})$/);
  if (!m) return `CELEX ${celex}`;
  // Ennen vuotta 1999 vuosi kirjoitettiin kahdella numerolla (93/13/ETY, N:o 2913/92).
  const y = +m[1] < 1999 ? m[1].slice(2) : m[1];
  // Ennen vuotta 2015 annetut asetukset numeroitiin muotoon N:o numero/vuosi.
  if (m[2] === "R" && +m[1] < 2015) return `asetus N:o ${+m[3]}/${y}`;
  return `${TYPE_NAME[m[2]]} ${y}/${+m[3]}`;
}

// ---------- Oikeuskäytäntö (EU-tuomioistuin, CELEX-sektori 6) ----------

const CASE_CELEX_RE = /^6(\d{4})(CJ|TJ|CO|TO|FJ|FO)(\d{4})$/;
const CASE_NO_RE = /^([CTF])\s*[-‑–]\s*(\d{1,4})\s*\/\s*(\d{2}|\d{4})(?:\s*(?:P|RENV|REV))?$/i;
const OWL = "http://www.w3.org/2002/07/owl#";

/** Asianumero CELEX-numerosta: 62018CJ0311 -> "C-311/18". */
export function caseNumber(celex) {
  const m = celex.match(CASE_CELEX_RE);
  if (!m) return celex;
  return `${m[2][0] === "C" ? "C" : m[2][0]}-${+m[3]}/${m[1].slice(2)}`;
}

/**
 * Tulkitsee tuomioviitteen: "C-311/18", "T-604/18", CELEX "62018CJ0311" tai ECLI.
 * Palauttaa { candidates } tai { ecli } tai { error }.
 */
export function parseCaseRef(input) {
  const raw = String(input ?? "").trim();
  const up = raw.toUpperCase().replace(/\s+/g, "");
  if (CASE_CELEX_RE.test(up)) return { candidates: [up] };
  if (/^ECLI:EU:[CTF]:\d{4}:\d+$/i.test(up)) return { ecli: up };
  const m = raw.match(CASE_NO_RE);
  if (!m) return { error: `Tuomioviitettä "${raw}" ei tunnistettu. Anna asianumero (esim. "C-311/18"), CELEX-numero (62018CJ0311) tai ECLI-tunnus.` };
  const court = m[1].toUpperCase();
  const y = m[3].length === 2 ? (+m[3] >= 50 ? 1900 + +m[3] : 2000 + +m[3]) : +m[3];
  const n = String(+m[2]).padStart(4, "0");
  // Tuomio ensin, sitten määräys.
  return { candidates: [`6${y}${court}J${n}`, `6${y}${court}O${n}`] };
}

export async function celexByEcli(ecli) {
  const rows = await sparql(
    `PREFIX cdm: <${CDM}> SELECT ?c WHERE { ?w cdm:case-law_ecli ${lit(ecli)} ; cdm:resource_legal_id_celex ?c . FILTER(REGEX(STR(?c), "^6[0-9]{4}[A-Z]{2}[0-9]{4}$")) } LIMIT 1`,
    30 * DAY,
  );
  return rows[0]?.c ?? null;
}

/** Tulkittu kohta luettavaksi: "A46P2LC" -> "46 art. 2 kohta c alak.". */
export function fmtLocation(loc) {
  // Artiklan kirjainosa (10 a) ei voi olla P (kohta) eikä L (alakohta).
  const m = String(loc).match(/^A0*(\d+)([A-KM-OQ-Z]?)(?:P0*(\d+))?((?:L(?:\d+|[A-Z]+))*)/);
  if (!m) return loc;
  let s = `${m[1]}${m[2] ? ` ${m[2].toLowerCase()}` : ""} art.`;
  if (m[3]) s += ` ${m[3]} kohta`;
  // L-osia voi olla useita (L1LB = 1. alakohdan b alakohta); näytetään kirjaimella merkitty.
  const ls = [...(m[4] ?? "").matchAll(/L(\d+|[A-Z]+)/g)].map((x) => x[1]);
  const letter = ls.reverse().find((x) => /^[A-Z]+$/.test(x));
  if (letter) s += ` ${letter.toLowerCase()} alak.`;
  else if (ls.length) s += ` ${ls[0]} alak.`;
  return s;
}

const LOC_FILTER = `?a <${OWL}annotatedSource> ?j ; <${OWL}annotatedProperty> cdm:case-law_interpretes_resource_legal ; <${OWL}annotatedTarget> ?t ; ?ap ?loc . FILTER(STRENDS(STR(?ap), "reference_to_modified_location"))`;

/** Tuomion perustiedot ja tulkitut säännökset. */
export async function caseInfo(celex, lang) {
  const L = LANGS[lang];
  const [meta, interp] = await Promise.all([
    sparql(`PREFIX cdm: <${CDM}>
SELECT ?p ?o WHERE {
  ?w cdm:resource_legal_id_celex ${lit(celex)} .
  { ?w ?p ?o . FILTER(?p IN (cdm:work_date_document, cdm:case-law_ecli)) }
  UNION
  { ?e cdm:expression_belongs_to_work ?w ; cdm:expression_uses_language ?p ; cdm:expression_title ?o .
    FILTER(?p IN (<${LANG_URI}${L.uri}>, <${LANG_URI}ENG>)) }
}`),
    sparql(`PREFIX cdm: <${CDM}>
SELECT ?tc ?loc WHERE {
  ?j cdm:resource_legal_id_celex ${lit(celex)} .
  ?j cdm:case-law_interpretes_resource_legal ?t . ?t cdm:resource_legal_id_celex ?tc .
  OPTIONAL { ${LOC_FILTER} }
}`),
  ]);
  if (!meta.length) return null;
  const title = meta.find((r) => r.p === LANG_URI + L.uri)?.o ?? meta.find((r) => r.p === LANG_URI + "ENG")?.o ?? "";
  const acts = new Map();
  for (const r of interp) {
    if (!acts.has(r.tc)) acts.set(r.tc, new Set());
    if (r.loc) acts.get(r.tc).add(r.loc);
  }
  return {
    celex,
    title,
    date: meta.find((r) => r.p === CDM + "work_date_document")?.o ?? null,
    ecli: meta.find((r) => r.p === CDM + "case-law_ecli")?.o ?? null,
    interprets: [...acts].map(([c, locs]) => ({ celex: c, locations: [...locs].sort() })),
  };
}

/**
 * Tuomiot, jotka tulkitsevat säädöstä (valinnaisesti tiettyä artiklaa), uusimmasta.
 * artikla: "6" tai "10a".
 */
export async function casesInterpreting({ actCelex, article, from, lang, page }) {
  const L = LANGS[lang];
  let artFilter = "";
  if (article) {
    const m = String(article).toUpperCase().replace(/\s+/g, "").match(/^(\d+)([A-Z]?)$/);
    if (!m) return null;
    artFilter = `FILTER(REGEX(STR(?loc), "^A0*${+m[1]}${m[2]}($|[A-Z])"))`;
  }
  const rows = await sparql(`PREFIX cdm: <${CDM}>
SELECT ?jc ?date (SAMPLE(?ti) AS ?title) (SAMPLE(?ec) AS ?ecli) (GROUP_CONCAT(DISTINCT ?loc; separator=",") AS ?locs) WHERE {
  ?t cdm:resource_legal_id_celex ${lit(actCelex)} .
  ?j cdm:case-law_interpretes_resource_legal ?t ; cdm:resource_legal_id_celex ?jc ; cdm:work_date_document ?date .
  FILTER(REGEX(STR(?jc), "^6[0-9]{4}(CJ|TJ)[0-9]{4}$"))
  ${from ? `FILTER(?date >= "${+from}-01-01"^^<http://www.w3.org/2001/XMLSchema#date>)` : ""}
  ${article ? `${LOC_FILTER} ${artFilter}` : `OPTIONAL { ${LOC_FILTER} }`}
  OPTIONAL { ?j cdm:case-law_ecli ?ec }
  OPTIONAL { ?e cdm:expression_belongs_to_work ?j ; cdm:expression_uses_language <${LANG_URI}${L.uri}> ; cdm:expression_title ?ti }
} GROUP BY ?jc ?date ORDER BY DESC(?date) LIMIT 11 OFFSET ${(Math.max(1, page) - 1) * 10}`);
  return rows.map((r) => ({ ...r, locations: r.locs ? r.locs.split(",").sort() : [] }));
}

/** Tuomiot otsikon sanoilla (otsikossa ovat asianosaiset ja asiasanat). */
export async function searchCases({ words, from, to, lang, page }) {
  const L = LANGS[lang];
  const terms = String(words ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)
    .slice(0, 6)
    .map((w) => (w.length >= 4 ? `"${w}*"` : `"${w}"`));
  if (!terms.length) return null;
  const filters = [`REGEX(STR(?jc), "^6[0-9]{4}(CJ|TJ)[0-9]{4}$")`];
  if (from) filters.push(`?date >= "${+from}-01-01"^^<http://www.w3.org/2001/XMLSchema#date>`);
  if (to) filters.push(`?date <= "${+to}-12-31"^^<http://www.w3.org/2001/XMLSchema#date>`);
  return sparql(
    `PREFIX cdm: <${CDM}>
SELECT ?jc ?date (SAMPLE(?ti) AS ?title) (SAMPLE(?ec) AS ?ecli) WHERE {
  ?e cdm:expression_uses_language <${LANG_URI}${L.uri}> ; cdm:expression_title ?ti ; cdm:expression_belongs_to_work ?j .
  ?ti bif:contains '${terms.join(" AND ").replace(/'/g, "")}' .
  ?j cdm:resource_legal_id_celex ?jc ; cdm:work_date_document ?date .
  OPTIONAL { ?j cdm:case-law_ecli ?ec }
  FILTER(${filters.join(" && ")})
} GROUP BY ?jc ?date ORDER BY DESC(?date) LIMIT 11 OFFSET ${(Math.max(1, page) - 1) * 10}`,
    3600,
  );
}
