// EU:n tuoterekisterit:
// - Safety Gate (EU:n vaarallisten muiden kuin elintarvikkeiden hälytysjärjestelmä, komissio / DG JUST):
//   viikkoraportit XML-muodossa, https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/...
//   (data.europa.eu: XML-raportit CC0). Uusi raportti julkaistaan perjantaisin, myös suomeksi.
// - EUDAMED (lääkinnällisten laitteiden tietokanta, asetukset (EU) 2017/745 ja 2017/746): julkinen API
//   SANTE Data Platformissa https://api.datalake.sante.service.ec.europa.eu/eudamed (ei avainta, vain GET).
//   Suodattimet ovat tarkkoja kenttävastaavuuksia (esim. PRIMARY_DI, MF_SRN, ACT_COUNTRY_ISO2_CODE);
//   tuntematon tai pienellä kirjoitettu parametri antaa virheen 500.

import { fetchText } from "./http.js";

const SG = "https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport";
const EUDAMED = "https://api.datalake.sante.service.ec.europa.eu/eudamed";
export const EUDAMED_SEARCH_URL = "https://ec.europa.eu/tools/eudamed/#/screen/search-device";
export const SG_SEARCH_URL = "https://ec.europa.eu/safety-gate-alerts/screen/webReport";

// ---------- Safety Gate ----------

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const tag = (x, name) => {
  const m = x.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return null;
  const v = m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
  return v ? decode(v).replace(/[ \t]{2,}/g, " ") : null;
};

// Raportissa useampi EAN-13-koodi voi olla yhteen kirjoitettuna (esim. 39 numeroa).
const splitBarcodes = (s) => (s && /^\d{26,}$/.test(s) && s.length % 13 === 0 ? s.match(/\d{13}/g).join(", ") : s);

/** Viikkoraporttien luettelo, uusin ensin: [{ reference, date (ISO), url }]. */
export async function sgReports() {
  const xml = await fetchText(`${SG}/list/xml/fi`, { ttl: 6 * 3600 });
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<weeklyReport>([\s\S]*?)<\/weeklyReport>/g)) {
    const r = m[1];
    const d = tag(r, "publicationDate")?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const url = tag(r, "URL");
    if (!d || !url) continue;
    out.push({ reference: tag(r, "reference"), date: `${d[3]}-${d[2]}-${d[1]}`, url });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Toimenpidekenttä on raportissa yhtenä merkkijonona ilman erottimia, esim.
 * "Viranomaisen määräämien toimenpiteiden kohteena olevan talouden toimijan tyyppi: JälleenmyyjäToimenpideluokka: …Voimaantulopäivä: 15/05/2026".
 */
export function parseMeasures(s) {
  if (!s) return [];
  const out = [];
  const re = /(Ilmoitetut toimenpiteet toteuttavan|Viranomaisen määräämien toimenpiteiden kohteena olevan) talouden toimijan tyyppi:\s*([\s\S]*?)Toimenpideluokka:\s*([\s\S]*?)Voimaantulopäivä:\s*([\s\S]*?)(?=Ilmoitetut toimenpiteet toteuttavan|Viranomaisen määräämien|$)/g;
  for (const m of s.matchAll(re)) {
    out.push({ ordered: m[1].startsWith("Viranomaisen"), operator: m[2].trim(), measure: m[3].trim(), from: m[4].trim().replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, (_, d, mo, y) => `${+d}.${+mo}.${y}`) });
  }
  return out.length ? out : [{ ordered: null, operator: null, measure: s.trim(), from: null }];
}

/** Yhden viikkoraportin hälytykset. Julkaistu raportti ei muutu (välimuisti 30 vrk). */
export async function sgReport(report) {
  const xml = await fetchText(report.url, { ttl: 30 * 86400 });
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<notifications\b[^>]*>([\s\S]*?)<\/notifications>/g)) {
    const n = m[1];
    out.push({
      date: report.date,
      week: report.reference,
      caseNumber: tag(n, "caseNumber"),
      link: tag(n, "reference"),
      category: tag(n, "category"),
      product: tag(n, "product"),
      brand: tag(n, "brand"),
      name: tag(n, "name"),
      model: tag(n, "type_numberOfModel"),
      batch: tag(n, "batchNumber"),
      barcode: splitBarcodes(tag(n, "barcode")),
      riskType: tag(n, "riskType"),
      danger: tag(n, "danger"),
      measures: parseMeasures(tag(n, "measures")),
      recallUrl: tag(n, "URLrecall"),
      description: tag(n, "description"),
      notifying: tag(n, "notifyingCountry"),
      origin: tag(n, "countryOfOrigin"),
      level: tag(n, "level"),
      trader: tag(n, "onlineTrader"),
    });
  }
  return out;
}

// ---------- EUDAMED ----------

async function eudamed(path, params) {
  const q = new URLSearchParams({ "api-version": "v1.0", format: "json", ...params });
  const txt = await fetchText(`${EUDAMED}/${path}?${q.toString()}`, { ttl: 86400 });
  if (!txt) return [];
  const d = JSON.parse(txt);
  return Array.isArray(d.value) ? d.value : [];
}

let refMemo = null;

/** Viitetiedot suomeksi. Sama ID voi esiintyä eri koodeilla, joten avain on "KOODI:ID". */
export async function eudamedRefs() {
  if (refMemo && refMemo.exp > Date.now()) return refMemo.map;
  const rows = await eudamed("reference", { LANGUAGE: "fi" });
  const map = new Map(rows.map((r) => [`${r.CODE}:${Number(r.ID)}`, String(r.VALUE ?? "").replace(/ /g, " ")]));
  refMemo = { map, exp: Date.now() + 6 * 3600_000 };
  return map;
}

export const refText = (refs, code, id) => (id === null || id === undefined ? null : refs.get(`${code}:${Number(id)}`) ?? null);

/** Rajapinta palauttaa saman tietueen useana kopiona; pidetään uusin versio. */
function latest(rows, key, ver) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    const prev = m.get(k);
    if (!prev || Number(r[ver] ?? 0) > Number(prev[ver] ?? 0)) m.set(k, r);
  }
  return [...m.values()];
}

export const actorsByCountry = async (iso2) => latest(await eudamed("actors", { ACT_COUNTRY_ISO2_CODE: iso2.toUpperCase() }), "ACTOR_ID", "VERSION");
export const actorBySrn = async (srn) => latest(await eudamed("actors", { ACTOR_ID: srn.toUpperCase() }), "ACTOR_ID", "VERSION")[0] ?? null;
export const devicesByManufacturer = async (srn) => latest(await eudamed("udi", { MF_SRN: srn.toUpperCase() }), "PRIMARY_DI", "VERSION_NUMBER");
export const devicesByUdi = async (di) => latest(await eudamed("udi", { PRIMARY_DI: di }), "PRIMARY_DI", "VERSION_NUMBER");
export const devicesByBasicUdi = async (b) => latest(await eudamed("udi", { BASIC_UDI: b }), "PRIMARY_DI", "VERSION_NUMBER");

export const ACTOR_TYPES_FI = {
  Manufacturer: "valmistaja",
  "Authorised Representative": "valtuutettu edustaja",
  Importer: "maahantuoja",
  "System/Procedure Pack Producer": "järjestelmän tai toimenpidepakkauksen kokoaja",
  "Notified Body": "ilmoitettu laitos",
  "Competent Authority": "toimivaltainen viranomainen",
  "Designating Authority": "nimeävä viranomainen",
};

// Maat, joiden toimijoita EUDAMEDissa on (EU, ETA, Sveitsi, Turkki, Pohjois-Irlanti XI). ISO 3166-1 alpha-2.
export const COUNTRY_ISO2 = {
  suomi: "FI", ruotsi: "SE", norja: "NO", tanska: "DK", islanti: "IS", viro: "EE", latvia: "LV", liettua: "LT",
  saksa: "DE", puola: "PL", ranska: "FR", alankomaat: "NL", hollanti: "NL", belgia: "BE", luxemburg: "LU",
  itävalta: "AT", sveitsi: "CH", liechtenstein: "LI", espanja: "ES", portugali: "PT", italia: "IT", irlanti: "IE",
  tšekki: "CZ", tsekki: "CZ", slovakia: "SK", unkari: "HU", slovenia: "SI", kroatia: "HR", romania: "RO",
  bulgaria: "BG", kreikka: "GR", kypros: "CY", malta: "MT", turkki: "TR", "pohjois-irlanti": "XI",
};
