// mcp-runko 1.1.0 sha256:8b47c8176dfcf730e0bb88e59a6acfa1427c58f27f41a7533c7a183e01d04807. Älä muokkaa tässä repossa: tämä on kopio yhteisestä rungosta (MIT).
// mcp-runko: MCP-liitinten yhteinen runko (Streamable HTTP, tilaton, JSON-vastaukset) Cloudflare Workerissa.
// MIT-lisenssi. Ei riippuvuuksia. Toimii Workerissa ja Node 22:ssa (Web Crypto, Request, Response).
//
// Sisältö: salaisen polun tarkistus (vähintään 12 merkkiä, prosenttikoodaus puretaan, vakioaikainen
// SHA-256-vertailu), Origin-tarkistus, MCP-Protocol-Version-tarkistus, JSON-RPC-käsittely (erät,
// ilmoitukset, initialize, ping, tools/list, tools/call, tyhjät resources ja prompts), käyttörajojen
// vastaus, työkalun poikkeusten piilotus ja User-Agent-muoto.
// 1.1.0: työkalun määrittely tyokalu() (logiikka hae-funktiona, teksti ja structuredContent), oikeudet ja
// annotations, työkalujen suodatus oikeuden mukaan, sivutusapurit ja tiivista, rakenteinen virhe (koodi),
// skeematarkistin (testitila ja valinnainen syötteen tarkistus), yhteensopivuusvaroitukset sekä protokolla
// 2026-07-28 (tilaton, ei initializea; server/discover, _meta, resultType, ttlMs ja cacheScope, Mcp-Method-
// ja Mcp-Name-otsakkeet, x-mcp-header) vanhojen versioiden rinnalla (dual-era).
//
// Lähde: MCP-spesifikaatio 2025-11-25, Transports (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports):
// - "Servers MUST validate the Origin header ... If the Origin header is present and invalid, servers MUST respond
//   with HTTP 403 Forbidden."
// - "If the server receives a request with an invalid or unsupported MCP-Protocol-Version, it MUST respond with
//   400 Bad Request."
// - GET: "return HTTP 405 Method Not Allowed" kun SSE-virtaa ei tarjota.
// Lähde: MCP-spesifikaatio 2026-07-28 (https://modelcontextprotocol.io/specification/2026-07-28/changelog),
// Versioning, Streamable HTTP (Request Metadata, Server Validation), Discovery, Caching ja Tools.
// MCP Inspector: selaimesta suoraan tehty yhteys saa 403 (vieras Origin). Käytä Inspectorin proxy-tilaa
// (palvelinpuolen yhteys ilman Originia); localhostia ei lisätä tuotannon sallittuihin.

export const RUNKO_VERSIO = "1.1.0";

// Initialize-kättelyllä neuvoteltavat (vanhat, "legacy") protokollaversiot, uusin ensin. Jos asiakas pyytää muuta,
// vastataan uusimmalla (Lifecycle, Version Negotiation).
export const PROTOKOLLAT = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// Tilattomat ("modern") versiot: versio kulkee jokaisen pyynnön _meta-kentässä ja MCP-Protocol-Version-otsakkeessa,
// eikä initializea ole. Niitä ei voi neuvotella initializella (2026-07-28, Versioning).
export const MODERNIT_PROTOKOLLAT = ["2026-07-28"];

/** Kaikki tuetut versiot, uusin ensin (server/discover supportedVersions ja UnsupportedProtocolVersionError). */
export const TUETUT_PROTOKOLLAT = [...MODERNIT_PROTOKOLLAT, ...PROTOKOLLAT];

// Selainten Origin-arvot, jotka hyväksytään. Clauden palvelinkutsuissa Originia ei yleensä ole; claude.ai ja
// claude.com sallitaan varmuuden vuoksi. Sama alkuperä kuin palvelimella hyväksytään aina.
export const SALLITUT_ORIGINIT = ["https://claude.ai", "https://claude.com"];

const RAJA_TEKSTI = "Liian monta hakua lyhyessä ajassa. Odota noin minuutti ja yritä uudelleen.";
const YLEINEN_VIRHE = "Haku epäonnistui. Yritä hetken päästä uudelleen.";

/** Rakenteisen virheen kiinteät koodit. Liitinkohtainen tai lähteen koodi kuuluu kenttään lahteen_koodi. */
export const VIRHEKOODIT = ["syote", "ei_loydy", "raja", "lahde", "yleinen"];

/** Työkalun oikeus: luku ei muuta mitään, ehdotus odottaa ihmisen hyväksyntää, kirjoitus on kaikki muu. */
export const OIKEUDET = ["luku", "ehdotus", "kirjoitus"];

/**
 * Virhe, jonka teksti saa näkyä kutsujalle (esim. käyttäjän antaman arvon muotovirhe). Muiden poikkeusten teksti piilotetaan.
 * 1.1.0: koodi (VIRHEKOODIT, oletus "yleinen") ja valinnainen lahteen_koodi tyokalu()-työkalujen rakenteiseen virheeseen.
 */
export class NaytettavaVirhe extends Error {
  constructor(viesti, koodi = "yleinen", { lahteen_koodi } = {}) {
    super(viesti);
    this.name = "NaytettavaVirhe";
    this.koodi = VIRHEKOODIT.includes(koodi) ? koodi : "yleinen";
    if (lahteen_koodi !== undefined && lahteen_koodi !== null) this.lahteen_koodi = String(lahteen_koodi).slice(0, 100);
  }
}

const encoder = new TextEncoder();

/** Vakioaikainen vertailu: molemmista lasketaan SHA-256 ja tiivisteet verrataan tavu kerrallaan ilman aikaista poistumista. */
export async function vakioaikainenVertailu(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let ero = 0;
  for (let i = 0; i < x.length; i++) ero |= x[i] ^ y[i];
  return ero === 0;
}

/**
 * Onko polku /mcp/<salaisuus> jollakin annetuista salaisuuksista. Salaisuudet: merkkijono tai lista.
 * Alle 12 merkin salaisuudet ja muut kuin merkkijonot hylätään. Prosenttikoodaus puretaan; rikkinäinen koodaus hylätään.
 * Kaikki kelvolliset salaisuudet verrataan aina, joten vastausaika ei kerro, mikä täsmäsi.
 */
export async function oikeaPolku(pathname, salaisuudet) {
  const lista = Array.isArray(salaisuudet) ? salaisuudet : [salaisuudet];
  const kelvolliset = lista.filter((s) => typeof s === "string" && s.length >= 12);
  if (!kelvolliset.length || typeof pathname !== "string" || !pathname.startsWith("/mcp/")) return false;
  let annettu;
  try {
    annettu = decodeURIComponent(pathname.slice(5));
  } catch {
    return false;
  }
  const tulokset = await Promise.all(kelvolliset.map((s) => vakioaikainenVertailu(annettu, s)));
  return tulokset.some(Boolean);
}

/** Rate Limiting -sidonnan tarkistus. Puuttuva sidonta (paikallinen testi) tai sidonnan virhe ei estä palvelua. */
export async function rajassa(sidonta, avain) {
  if (!sidonta) return true;
  try {
    const { success } = await sidonta.limit({ key: avain });
    return success !== false;
  } catch {
    return true;
  }
}

/** User-Agent liittimen omiin hakuihin: `<nimi>-mcp/<versio> (Claude-liitin; Cloudflare Worker)`. */
export function userAgent(nimi, versio, lisa = "Cloudflare Worker") {
  return `${nimi}-mcp/${versio} (Claude-liitin; ${lisa})`;
}

export function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** Kuljetustason virhe (403, 400): spesifikaation sallima JSON-RPC-virhevastaus ilman id-kenttää. */
export function virheIlmanId(code, message) {
  return { jsonrpc: "2.0", error: { code, message } };
}

export function json(obj, status = 200, lisaOtsakkeet = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...lisaOtsakkeet },
  });
}

function teksti(sisalto, status = 200, lisa = {}) {
  return new Response(sisalto, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...lisa } });
}

/** Origin on sallittu, jos sitä ei ole, se on sama kuin palvelimen tai se on listalla. */
export function originSallittu(request, sallitut = SALLITUT_ORIGINIT) {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  if (origin === new URL(request.url).origin) return true;
  return sallitut.includes(origin);
}

// ---------- sivutus ja tiivistys ----------

/** Syötekentät uusiin työkaluihin. Olemassa olevien työkalujen kenttiä ei nimetä uudelleen (siirtymäsääntö, README). */
export const SIVUTUS_KENTAT = { sivu: { type: "integer", minimum: 1, description: "Tulossivu (oletus 1)." } };
export const JATKO_KENTAT = { jatko: { type: "string", maxLength: 2000, description: "Edellisen haun antama jatkotunniste." } };
export const SIIRTYMA_KENTAT = {
  alku: { type: "integer", minimum: 0, description: "Monennestako tuloksesta alkaen (oletus 0)." },
  maara: { type: "integer", minimum: 1, description: "Tuloksia enintään." },
};

const kokonais = (x, oletus) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.floor(n) : oletus;
};

/**
 * Muistilistan sivutus: { rivit, sivu, sivuja, yhteensa, seuraava }; seuraava on seuraavan sivun numero tai null.
 * koko rajataan väliin 1–enintaan; liian suuri sivu antaa viimeisen sivun. Sama palautusmuoto kuin liittimien omissa sivutusfunktioissa.
 */
export function sivuta(lista, { sivu = 1, koko = 20, enintaan = 100 } = {}) {
  const rivit0 = Array.isArray(lista) ? lista : [];
  const k = Math.min(Math.max(1, kokonais(koko, 20)), Math.max(1, kokonais(enintaan, 100)));
  const yhteensa = rivit0.length;
  const sivuja = Math.max(1, Math.ceil(yhteensa / k));
  const s = Math.min(Math.max(1, kokonais(sivu, 1)), sivuja);
  return { rivit: rivit0.slice((s - 1) * k, s * k), sivu: s, sivuja, yhteensa, seuraava: s < sivuja ? s + 1 : null };
}

/** Lähteen oma sivutus (ei leikkaa listaa): { sivu, sivuja, yhteensa, seuraava }. yhteensa on lähteen ilmoittama. */
export function sivutieto({ sivu = 1, sivuja = 1, yhteensa } = {}) {
  const s = Math.max(1, kokonais(sivu, 1));
  const n = Math.max(s, kokonais(sivuja, s));
  const tiedossa = yhteensa !== undefined && yhteensa !== null && Number.isFinite(Number(yhteensa));
  return { sivu: s, sivuja: n, yhteensa: tiedossa ? Number(yhteensa) : null, seuraava: s < n ? s + 1 : null };
}

/** Jatkotunniste: { jatko }; jatko on merkkijono tai null (viimeinen sivu). */
export function jatkotieto(jatko) {
  return { jatko: typeof jatko === "string" && jatko ? jatko : null };
}

/**
 * Siirtymä: { alku, maara, seuraava_alku, yhteensa? }. seuraava_alku on null, kun saatiin < maara tai yhteensa on
 * tiedossa ja täyttyi.
 */
export function siirtymatieto({ alku = 0, maara, saatiin = 0, yhteensa } = {}) {
  const a = Math.max(0, kokonais(alku, 0));
  const m = Math.max(1, kokonais(maara, 1));
  const s = Math.max(0, kokonais(saatiin, 0));
  const tiedossa = yhteensa !== undefined && yhteensa !== null && Number.isFinite(Number(yhteensa));
  let seuraava = s < m ? null : a + s;
  if (tiedossa && seuraava !== null && seuraava >= Number(yhteensa)) seuraava = null;
  const tulos = { alku: a, maara: m, seuraava_alku: seuraava };
  if (tiedossa) tulos.yhteensa = Number(yhteensa);
  return tulos;
}

/**
 * Katkaisee liian pitkän tekstin rivin rajalta ja lisää rivin "Tulos katkaistu: N merkkiä näytetty. <ohje>".
 * Ei koske structuredContentia (rakenteisen tuloksen koko rajataan sivutuksella).
 */
export function tiivista(teksti, enintaan = 50000, ohje = "Rajaa hakua tai käytä sivutusta.") {
  const t = String(teksti ?? "");
  if (t.length <= enintaan) return t;
  const raja = t.lastIndexOf("\n", enintaan);
  const osa = (raja > 0 ? t.slice(0, raja) : t.slice(0, enintaan)).replace(/\s+$/, "");
  return `${osa}\n\nTulos katkaistu: ${osa.length} merkkiä näytetty. ${ohje}`;
}

// ---------- skeemat ja skeematarkistin ----------

/** Rakenteisen tuloksen yhteinen lähdekenttä: lahde.nimi pakollinen, liitin saa lisätä kenttiä. */
export const LAHDE_SKEEMA = {
  type: "object",
  properties: { nimi: { type: "string" }, linkki: { type: "string" }, haettu: { type: "string" } },
  required: ["nimi"],
};

/**
 * Rakenteinen virhe. Työkalulla, jolla on tulosSkeema, virheen structuredContent annetaan vain, jos { virhe } on skeeman
 * mukainen (esim. skeema oneOf: [onnistunut tulos, { properties: { virhe: VIRHE_SKEEMA }, required: ["virhe"] }]).
 */
export const VIRHE_SKEEMA = {
  type: "object",
  properties: {
    koodi: { type: "string", enum: VIRHEKOODIT },
    viesti: { type: "string" },
    lahteen_koodi: { type: "string" },
  },
  required: ["koodi", "viesti"],
};

const TARKISTETUT = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "anyOf", "oneOf",
]);
// Selitteet, jotka eivät rajaa arvoa (ei varoitusta).
const SELITTEET = new Set([
  "description", "title", "default", "examples", "$schema", "$comment", "$id", "deprecated", "readOnly", "writeOnly",
  "x-mcp-header",
]);
const MAX_SYVYYS = 64;

function tyyppiOn(arvo, tyyppi) {
  switch (tyyppi) {
    case "null": return arvo === null;
    case "boolean": return typeof arvo === "boolean";
    case "string": return typeof arvo === "string";
    case "integer": return typeof arvo === "number" && Number.isInteger(arvo);
    case "number": return typeof arvo === "number" && Number.isFinite(arvo);
    case "array": return Array.isArray(arvo);
    case "object": return arvo !== null && typeof arvo === "object" && !Array.isArray(arvo);
    default: return false;
  }
}

function samat(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => samat(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && samat(a[k], b[k]));
}

function tarkista(skeema, arvo, polku, virheet, tarkistamattomat, syvyys) {
  if (skeema === true || skeema === undefined) return;
  if (skeema === false) {
    virheet.push(`${polku}: arvoa ei sallita`);
    return;
  }
  if (!skeema || typeof skeema !== "object") return;
  if (syvyys > MAX_SYVYYS) {
    virheet.push(`${polku}: skeema on liian syvä`);
    return;
  }
  for (const k of Object.keys(skeema)) {
    if (!TARKISTETUT.has(k) && !SELITTEET.has(k)) tarkistamattomat.add(k);
  }
  if (Array.isArray(skeema.items)) tarkistamattomat.add("items (lista)");
  if (skeema.type !== undefined) {
    const tyypit = Array.isArray(skeema.type) ? skeema.type : [skeema.type];
    if (!tyypit.some((t) => tyyppiOn(arvo, t))) {
      virheet.push(`${polku}: odotettiin tyyppiä ${tyypit.join(" tai ")}`);
      return;
    }
  }
  if (Array.isArray(skeema.enum) && !skeema.enum.some((e) => samat(e, arvo))) {
    virheet.push(`${polku}: arvo ei ole sallittujen joukossa (${skeema.enum.map((e) => JSON.stringify(e)).join(", ")})`);
  }
  if (Object.hasOwn(skeema, "const") && !samat(skeema.const, arvo)) {
    virheet.push(`${polku}: arvon pitää olla ${JSON.stringify(skeema.const)}`);
  }
  if (typeof arvo === "number") {
    if (typeof skeema.minimum === "number" && arvo < skeema.minimum) virheet.push(`${polku}: pienempi kuin ${skeema.minimum}`);
    if (typeof skeema.maximum === "number" && arvo > skeema.maximum) virheet.push(`${polku}: suurempi kuin ${skeema.maximum}`);
  }
  if (typeof arvo === "string") {
    const pituus = [...arvo].length;
    if (typeof skeema.minLength === "number" && pituus < skeema.minLength) virheet.push(`${polku}: lyhyempi kuin ${skeema.minLength} merkkiä`);
    if (typeof skeema.maxLength === "number" && pituus > skeema.maxLength) virheet.push(`${polku}: pidempi kuin ${skeema.maxLength} merkkiä`);
    if (typeof skeema.pattern === "string") {
      let re = null;
      // u-lippu (Unicode); jos lauseke ei käänny sillä (esim. ^\d{4}\-\d{2}$), käännetään ilman lippua.
      try {
        re = new RegExp(skeema.pattern, "u");
      } catch {
        try {
          re = new RegExp(skeema.pattern);
        } catch {
          virheet.push(`${polku}: skeeman pattern ei ole kelvollinen säännöllinen lauseke`);
        }
      }
      if (re && !re.test(arvo)) virheet.push(`${polku}: ei vastaa muotoa ${skeema.pattern}`);
    }
  }
  if (Array.isArray(arvo)) {
    if (typeof skeema.minItems === "number" && arvo.length < skeema.minItems) virheet.push(`${polku}: alle ${skeema.minItems} alkiota`);
    if (typeof skeema.maxItems === "number" && arvo.length > skeema.maxItems) virheet.push(`${polku}: yli ${skeema.maxItems} alkiota`);
    if (skeema.items !== undefined && !Array.isArray(skeema.items)) {
      arvo.forEach((x, i) => tarkista(skeema.items, x, `${polku}[${i}]`, virheet, tarkistamattomat, syvyys + 1));
    }
  }
  if (tyyppiOn(arvo, "object")) {
    const ominaisuudet = skeema.properties && typeof skeema.properties === "object" ? skeema.properties : {};
    if (Array.isArray(skeema.required)) {
      for (const k of skeema.required) if (!Object.hasOwn(arvo, k)) virheet.push(`${polku}.${k}: pakollinen kenttä puuttuu`);
    }
    for (const [k, v] of Object.entries(arvo)) {
      if (Object.hasOwn(ominaisuudet, k)) tarkista(ominaisuudet[k], v, `${polku}.${k}`, virheet, tarkistamattomat, syvyys + 1);
      else if (skeema.additionalProperties === false) virheet.push(`${polku}.${k}: kenttää ei sallita`);
      else if (skeema.additionalProperties && typeof skeema.additionalProperties === "object") {
        tarkista(skeema.additionalProperties, v, `${polku}.${k}`, virheet, tarkistamattomat, syvyys + 1);
      }
    }
  }
  for (const [avain, vaadittu] of [["anyOf", "vähintään yksi"], ["oneOf", "tasan yksi"]]) {
    if (!Array.isArray(skeema[avain])) continue;
    let osumia = 0;
    for (const osa of skeema[avain]) {
      const v = [];
      tarkista(osa, arvo, polku, v, tarkistamattomat, syvyys + 1);
      if (!v.length) osumia++;
    }
    if (avain === "anyOf" ? osumia < 1 : osumia !== 1) virheet.push(`${polku}: ${avain} vaatii, että ${vaadittu} vaihtoehto täsmää (täsmäsi ${osumia})`);
  }
}

/**
 * Tarkistaa arvon JSON Schemaa vasten (rungon oma, rajattu tarkistin; README luettelee tarkistetut avainsanat).
 * Palauttaa { virheet: string[], tarkistamattomat: string[] }; tarkistamattomat ovat skeeman avainsanoja, joita ei tarkisteta.
 */
export function tarkistaSkeema(skeema, arvo) {
  const virheet = [];
  const tarkistamattomat = new Set();
  tarkista(skeema, arvo, "$", virheet, tarkistamattomat, 0);
  return { virheet, tarkistamattomat: [...tarkistamattomat] };
}

/** Skeeman kaikki avainsanat, joita tarkistin ei tarkista (käydään skeema läpi ilman arvoa). */
function tarkistamattomatAvainsanat(skeema, tulos = new Set(), syvyys = 0) {
  if (!skeema || typeof skeema !== "object" || syvyys > MAX_SYVYYS) return tulos;
  for (const [k, v] of Object.entries(skeema)) {
    if (!TARKISTETUT.has(k) && !SELITTEET.has(k)) tulos.add(k);
    if (k === "items" && Array.isArray(v)) {
      tulos.add("items (lista)");
      for (const s of v) tarkistamattomatAvainsanat(s, tulos, syvyys + 1);
    } else if (k === "properties" && v && typeof v === "object") for (const s of Object.values(v)) tarkistamattomatAvainsanat(s, tulos, syvyys + 1);
    else if ((k === "items" || k === "additionalProperties") && v && typeof v === "object") tarkistamattomatAvainsanat(v, tulos, syvyys + 1);
    else if ((k === "anyOf" || k === "oneOf") && Array.isArray(v)) for (const s of v) tarkistamattomatAvainsanat(s, tulos, syvyys + 1);
  }
  return tulos;
}

/**
 * Yhteensopivuusvaroitukset tools/list-määrittelyistä ja instructions-tekstistä (Copilot Studion tunnetut rajoitteet:
 * tyyppilista, $ref, exclusiveMinimum lukuna, ei-merkkijonoinen enum; instructions yli 4000 merkkiä). Ei kaada mitään.
 */
export function yhteensopivuusVaroitukset(tools = [], instructions = "") {
  const varoitukset = [];
  const kay = (skeema, nimi, polku, syvyys = 0) => {
    if (!skeema || typeof skeema !== "object" || syvyys > MAX_SYVYYS) return;
    if (Array.isArray(skeema)) {
      skeema.forEach((s, i) => kay(s, nimi, `${polku}[${i}]`, syvyys + 1));
      return;
    }
    if (Array.isArray(skeema.type)) varoitukset.push(`${nimi} ${polku}: tyyppilista ${JSON.stringify(skeema.type)}`);
    if (Object.hasOwn(skeema, "$ref")) varoitukset.push(`${nimi} ${polku}: $ref`);
    if (typeof skeema.exclusiveMinimum === "number") varoitukset.push(`${nimi} ${polku}: exclusiveMinimum lukuna`);
    if (Array.isArray(skeema.enum) && skeema.enum.some((e) => typeof e !== "string")) varoitukset.push(`${nimi} ${polku}: enum, jossa muu kuin merkkijono`);
    for (const [k, v] of Object.entries(skeema)) {
      if (v && typeof v === "object" && k !== "enum" && k !== "const" && k !== "default" && k !== "examples") kay(v, nimi, `${polku}.${k}`, syvyys + 1);
    }
  };
  for (const t of tools) {
    kay(t?.inputSchema, t?.name, "inputSchema");
    kay(t?.outputSchema, t?.name, "outputSchema");
  }
  if (typeof instructions === "string" && instructions.length > 4000) varoitukset.push(`instructions on ${instructions.length} merkkiä (yli 4000)`);
  return varoitukset;
}

// ---------- x-mcp-header (2026-07-28) ----------

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Kerää inputSchemasta x-mcp-header-merkinnät { polku: [avaimet], otsake, tyyppi }. Merkintä kelpaa vain, jos siihen
 * pääsee pelkillä properties-avaimilla ja kentän tyyppi on string, integer tai boolean. Virheellinen merkintä heittää,
 * koska asiakas jättäisi koko työkalun pois (Streamable HTTP, Schema Extension).
 */
function mcpOtsakkeet(nimi, skeema) {
  const kelvolliset = [];
  const kaikki = [];
  const etsi = (s, syvyys = 0) => {
    if (!s || typeof s !== "object" || syvyys > MAX_SYVYYS) return;
    if (!Array.isArray(s) && Object.hasOwn(s, "x-mcp-header")) kaikki.push(s);
    for (const v of Object.values(s)) etsi(v, syvyys + 1);
  };
  etsi(skeema);
  const kay = (s, polku) => {
    if (!s || typeof s !== "object" || !s.properties || typeof s.properties !== "object") return;
    for (const [k, v] of Object.entries(s.properties)) {
      if (v && typeof v === "object" && Object.hasOwn(v, "x-mcp-header")) kelvolliset.push({ polku: [...polku, k], otsake: v["x-mcp-header"], tyyppi: v.type, s: v });
      kay(v, [...polku, k]);
    }
  };
  kay(skeema, []);
  if (kaikki.length !== kelvolliset.length) throw new Error(`Työkalu ${nimi}: x-mcp-header vain properties-ketjun päässä.`);
  const nahdyt = new Set();
  for (const o of kelvolliset) {
    if (typeof o.otsake !== "string" || !TOKEN.test(o.otsake)) throw new Error(`Työkalu ${nimi}: x-mcp-header ${JSON.stringify(o.otsake)} ei ole kelvollinen otsakkeen nimi.`);
    if (!["string", "integer", "boolean"].includes(o.tyyppi)) throw new Error(`Työkalu ${nimi}: x-mcp-header vain string-, integer- tai boolean-kentälle.`);
    const pieni = o.otsake.toLowerCase();
    if (nahdyt.has(pieni)) throw new Error(`Työkalu ${nimi}: x-mcp-header ${o.otsake} kahdesti.`);
    nahdyt.add(pieni);
  }
  return kelvolliset.map(({ polku, otsake, tyyppi }) => ({ polku, otsake, tyyppi }));
}

/** Purkaa Base64-merkinnän =?base64?...?= (UTF-8). Rikkinäinen koodaus -> null. Muu arvo sellaisenaan. */
export function puraOtsake(arvo) {
  if (typeof arvo !== "string") return null;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(arvo);
  if (!m) return arvo.startsWith("=?base64?") && arvo.endsWith("?=") ? null : arvo;
  try {
    const tavut = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(tavut);
  } catch {
    return null;
  }
}

// ---------- työkalun määrittely ----------

const JOHDETUT = {
  luku: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  ehdotus: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  kirjoitus: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

const onOlio = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * Työkalun määrittely: logiikka on hae-funktiossa (kutsuttavissa ja testattavissa ilman MCP:tä), teksti muotoilee
 * luettavan vastauksen ja rakenteinen data annetaan structuredContentina. Palauttaa { nimi, oikeus, maarittely,
 * kasittele, hae, teksti, tulosSkeema, rakenteinen, ... }; luoPalvelin({ tyokalut: [...] }) kokoaa tools/listin.
 *
 * @param {object} t
 * @param {string} t.nimi
 * @param {string} t.kuvaus description
 * @param {object} [t.syote] inputSchema (oletus tyhjä olio)
 * @param {object} [t.tulosSkeema] outputSchema
 * @param {boolean} [t.rakenteinen] structuredContent mukaan (oletus true, jos tulosSkeema on)
 * @param {string[]} [t.poisRakenteesta] datan kentät, joita ei viedä structuredContentiin (esim. kuvat)
 * @param {"luku"|"ehdotus"|"kirjoitus"} t.oikeus
 * @param {string} [t.otsikko] title ja annotations.title
 * @param {boolean} [t.avoin] annotations.openWorldHint (oletus true)
 * @param {object} [t.annotations] liittimen omat arvot ohittavat johdetut (readOnlyHint: true vain luvulle)
 * @param {(args, env, ctx) => Promise<object>} t.hae
 * @param {(data, args) => string} t.teksti
 * @param {(data, args) => Array} [t.lisasisalto] sisältölohkot tekstin jälkeen (text, image, audio, resource_link)
 * @param {boolean} [t.jsonTekstina] rakenteinen data myös JSON-tekstilohkona (oletus false)
 * @param {boolean} [t.tarkistaSyote] argumentit tarkistetaan syote-skeemaa vasten ennen hae-kutsua (oletus false)
 */
export function tyokalu(t) {
  const {
    nimi, kuvaus, syote, tulosSkeema, poisRakenteesta = [], oikeus, otsikko, avoin = true, annotations = {},
    hae, teksti: tekstiksi, lisasisalto, jsonTekstina = false, tarkistaSyote = false,
  } = t ?? {};
  if (typeof nimi !== "string" || !nimi) throw new Error("tyokalu: nimi puuttuu.");
  if (!OIKEUDET.includes(oikeus)) throw new Error(`tyokalu ${nimi}: oikeus on ${OIKEUDET.join(", ")}.`);
  if (typeof hae !== "function" || typeof tekstiksi !== "function") throw new Error(`tyokalu ${nimi}: hae ja teksti ovat funktioita.`);
  if (lisasisalto !== undefined && typeof lisasisalto !== "function") throw new Error(`tyokalu ${nimi}: lisasisalto on funktio.`);
  if (annotations.readOnlyHint === true && oikeus !== "luku") throw new Error(`tyokalu ${nimi}: readOnlyHint true vain oikeudelle luku.`);
  const rakenteinen = t.rakenteinen ?? Boolean(tulosSkeema);
  const inputSchema = syote ?? { type: "object", properties: {} };
  const maarittely = { name: nimi };
  if (otsikko) maarittely.title = otsikko;
  maarittely.description = kuvaus ?? "";
  maarittely.inputSchema = inputSchema;
  if (tulosSkeema) maarittely.outputSchema = tulosSkeema;
  maarittely.annotations = {
    ...(otsikko ? { title: otsikko } : {}),
    ...JOHDETUT[oikeus],
    openWorldHint: Boolean(avoin),
    ...annotations,
  };
  const otsakkeet = mcpOtsakkeet(nimi, inputSchema);
  // Virheen structuredContent: aina ilman tulosSkeemaa; skeeman kanssa vain, jos { virhe } on skeeman mukainen
  // (outputSchema-vaatimus voi koskea myös isError-tuloksia, ks. README).
  // Jos skeemassa on avainsanoja, joita tarkistin ei tarkista (allOf, $ref, exclusiveMinimum, lista-items ym.), virheen
  // kelpaavuutta ei voi todeta, joten virhe annetaan vain tekstinä. format on 2020-12:ssa oletuksena vain selite.
  const rajoittavatTarkistamattomat = tulosSkeema ? [...tarkistamattomatAvainsanat(tulosSkeema)].filter((k) => k !== "format") : [];
  const virheRakenteena = (rakenne) => !tulosSkeema
    || (!rajoittavatTarkistamattomat.length && tarkistaSkeema(tulosSkeema, rakenne).virheet.length === 0);

  function rakenne(data) {
    if (!poisRakenteesta.length) return data;
    const kopio = { ...data };
    for (const k of poisRakenteesta) delete kopio[k];
    return kopio;
  }

  async function kasittele(args, env, ctx) {
    if (tarkistaSyote) {
      const { virheet } = tarkistaSkeema(inputSchema, args);
      if (virheet.length) throw new NaytettavaVirhe(`Syöte ei kelpaa: ${virheet.slice(0, 3).map((v) => v.replace(/^\$\.?/, "")).join("; ")}`, "syote");
    }
    const data = await hae(args, env, ctx);
    const content = [{ type: "text", text: String(tekstiksi(data, args)) }];
    if (lisasisalto) {
      const lisa = await lisasisalto(data, args);
      if (!Array.isArray(lisa) || lisa.some((l) => !onOlio(l) || typeof l.type !== "string")) {
        throw new TypeError(`tyokalu ${nimi}: lisasisalto palauttaa listan sisältölohkoja (type).`);
      }
      content.push(...lisa);
    }
    const tulos = { content };
    if (rakenteinen || jsonTekstina) {
      if (!onOlio(data)) throw new TypeError(`tyokalu ${nimi}: rakenteinen tulos on olio.`);
      const r = rakenne(data);
      if (jsonTekstina) content.push({ type: "text", text: JSON.stringify(r) });
      if (rakenteinen) tulos.structuredContent = r;
    }
    return tulos;
  }

  return {
    nimi, oikeus, maarittely, kasittele, hae, teksti: tekstiksi, tulosSkeema, rakenteinen, virheRakenteena, otsakkeet,
  };
}

/** isError-tulos; rakenteinen virhe { virhe: { koodi, viesti, lahteen_koodi? } }, jos työkalun skeema sallii sen. */
function virheTulos(t, teksti, koodi, lahteen_koodi) {
  const tulos = { isError: true, content: [{ type: "text", text: teksti }] };
  const virhe = { koodi, viesti: teksti };
  if (lahteen_koodi !== undefined) virhe.lahteen_koodi = lahteen_koodi;
  if (t.virheRakenteena({ virhe })) tulos.structuredContent = { virhe };
  return tulos;
}

// ---------- palvelin ----------

const PV = "io.modelcontextprotocol/protocolVersion";
const CC = "io.modelcontextprotocol/clientCapabilities";
const SI = "io.modelcontextprotocol/serverInfo";

/**
 * Luo MCP-palvelimen.
 * @param {object} a
 * @param {{name:string, version:string}} a.serverInfo
 * @param {string} a.instructions
 * @param {Array} [a.tools] vanhat määrittelyt (käsittelijä kasittelijat- tai callTool-kentässä)
 * @param {(nimi, args, env, ctx) => Promise<object>} [a.callTool] liittimen oma kutsu (tai kasittelijat)
 * @param {Record<string, (args, env, ctx) => Promise<object>>} [a.kasittelijat] työkalun nimi -> käsittelijä
 * @param {Array} [a.tyokalut] 1.1.0: tyokalu()-määrittelyt; voi olla samassa palvelimessa vanhojen kanssa
 * @param {(ctx) => Promise<string[]>} [a.sallitut] 1.1.0: sallitut oikeudet pyynnölle (oletus kaikki); vanhat
 *   työkalut ilman oikeutta ovat silloin kirjoittavia (fail closed)
 * @param {boolean} [a.tarkistaTulokset] 1.1.0 testitila: structuredContent tulosSkeemaa vasten, lahde.nimi ja varoitukset
 * @param {(viesti) => void} [a.varoita] testitilan varoitukset (oletus console.warn)
 * @param {{ttlMs?: number, cacheScope?: "public"|"private"}} [a.listaValimuisti] 2026-07-28: listojen ja
 *   server/discoverin välimuistivihje (oletus 300000 ms ja private; public vain liittimen pyynnöstä)
 * @param {{salaisuudet?: (env) => Array, julkinen?: boolean}} a.polku salainen polku tai julkinen /mcp
 * @param {(ctx, tyokalu) => Promise<boolean>} [a.rajat] käyttörajat; false = raja täynnä
 * @param {string} [a.juuriteksti] juuren GET-vastaus
 * @param {(request, env, execCtx) => Promise<Response|null>} [a.lisareitit] omat reitit ennen MCP-polkua
 * @param {string[]} [a.originit] sallitut Origin-arvot (oletus SALLITUT_ORIGINIT)
 */
export function luoPalvelin(a) {
  const { serverInfo, instructions, polku = {}, juuriteksti } = a;
  const tools = a.tools ?? [];
  const tyokalut = a.tyokalut ?? [];
  const originit = a.originit ?? SALLITUT_ORIGINIT;
  const varoita = a.varoita ?? ((v) => console.warn("mcp-runko:", v));

  // Uudet työkalut nimen mukaan; sama nimi kahdesti (myös vanhojen kanssa) on käynnistysvirhe.
  const uudet = new Map();
  const vanhatNimet = new Set([...tools.map((t) => t?.name), ...Object.keys(a.kasittelijat ?? {})]);
  for (const t of tyokalut) {
    if (!t || typeof t.kasittele !== "function" || !t.maarittely) throw new Error("luoPalvelin: tyokalut-listassa on vain tyokalu()-määrittelyjä.");
    if (uudet.has(t.nimi) || vanhatNimet.has(t.nimi)) throw new Error(`luoPalvelin: työkalu ${t.nimi} kahdesti.`);
    uudet.set(t.nimi, t);
  }
  const vanhatMaarittelyt = new Set(tools.map((t) => t?.name));
  const kaikkiMaarittelyt = tyokalut.length ? [...tools, ...tyokalut.map((t) => t.maarittely)] : tools;
  const vanhatOtsakkeet = new Map();
  for (const t of tools) if (t?.inputSchema) vanhatOtsakkeet.set(t.name, mcpOtsakkeet(t.name, t.inputSchema));

  if (a.tarkistaTulokset) {
    for (const t of tools) {
      const an = t?.annotations ?? {};
      if (an.readOnlyHint === undefined || an.destructiveHint === undefined) {
        varoita(`työkalu ${t?.name}: annotations ilman readOnlyHintia tai destructiveHintia (ChatGPT kohtelee kirjoittavana)`);
      }
    }
    for (const t of tyokalut) {
      if (t.rakenteinen && !t.tulosSkeema) varoita(`työkalu ${t.nimi}: rakenteinen tulos ilman tulosSkeemaa`);
      const tm = [...tarkistamattomatAvainsanat(t.tulosSkeema)];
      if (tm.length) varoita(`työkalu ${t.nimi}: tulosSkeeman avainsanoja ei tarkisteta: ${tm.join(", ")}`);
    }
    for (const v of yhteensopivuusVaroitukset(kaikkiMaarittelyt, instructions)) varoita(`yhteensopivuus: ${v}`);
  }

  const valimuisti = {
    ttlMs: Math.max(0, kokonais(a.listaValimuisti?.ttlMs, 300000)),
    // Oletus private: useimmat liittimet ovat salaisen polun tai kirjautumisen takana, eikä jaettu välimuisti saa
    // tarjota niiden listaa muille. Julkinen liitin (esim. /mcp ilman tunnistusta) voi antaa cacheScope: "public".
    cacheScope: a.listaValimuisti?.cacheScope === "public" ? "public" : "private",
  };

  const SALLITUT = Symbol("sallitut");
  /** Sallitut oikeudet; sallitut(ctx) kutsutaan kerran pyyntöä kohden (tulos talteen ctx:iin). */
  function sallitutOikeudet(ctx) {
    if (!a.sallitut) return Promise.resolve(null);
    if (!ctx[SALLITUT]) {
      ctx[SALLITUT] = (async () => {
        try {
          const s = await a.sallitut(ctx);
          return Array.isArray(s) ? s : [];
        } catch {
          return [];
        }
      })();
    }
    return ctx[SALLITUT];
  }

  /** Näkyykö työkalu näillä oikeuksilla. Vanha työkalu ilman oikeutta on kirjoittava (fail closed). */
  function nakyy(nimi, oikeudet) {
    if (oikeudet === null) return true;
    const t = uudet.get(nimi);
    return oikeudet.includes(t ? t.oikeus : "kirjoitus");
  }

  async function tyokaluLista(ctx) {
    const oikeudet = await sallitutOikeudet(ctx);
    if (oikeudet === null) return kaikkiMaarittelyt;
    return kaikkiMaarittelyt.filter((m) => nakyy(m?.name, oikeudet));
  }

  const tuntematon = (nimi) => ({ isError: true, content: [{ type: "text", text: `Tuntematon työkalu: ${nimi}` }] });

  async function kutsuUutta(t, args, ctx) {
    let tulos;
    try {
      tulos = await t.kasittele(args, ctx.env, ctx);
    } catch (e) {
      if (e instanceof NaytettavaVirhe || e?.name === "NaytettavaVirhe") {
        const koodi = VIRHEKOODIT.includes(e.koodi) ? e.koodi : "yleinen";
        return virheTulos(t, e.message, koodi, e.lahteen_koodi);
      }
      console.error("tyokalu:", t.nimi, e?.name ?? "virhe");
      return virheTulos(t, YLEINEN_VIRHE, "yleinen");
    }
    // Testitila: poikkeama heittää try-lohkon ulkopuolella, jotta testi kaatuu (tuotannossa ei ajeta).
    if (a.tarkistaTulokset && t.rakenteinen) {
      const sc = tulos.structuredContent;
      if (t.tulosSkeema) {
        const { virheet } = tarkistaSkeema(t.tulosSkeema, sc);
        if (virheet.length) throw new Error(`mcp-runko tarkistaTulokset: ${t.nimi}: ${virheet.join("; ")}`);
      }
      if (typeof sc?.lahde?.nimi !== "string" || !sc.lahde.nimi) {
        throw new Error(`mcp-runko tarkistaTulokset: ${t.nimi}: lahde.nimi puuttuu rakenteisesta tuloksesta`);
      }
    }
    return tulos;
  }

  async function kutsuTyokalua(nimi, args, ctx) {
    const argumentit = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const uusi = typeof nimi === "string" && uudet.has(nimi) ? uudet.get(nimi) : null;
    if (uusi) return kutsuUutta(uusi, argumentit, ctx);
    try {
      if (a.kasittelijat) {
        const k = typeof nimi === "string" && Object.hasOwn(a.kasittelijat, nimi) ? a.kasittelijat[nimi] : null;
        if (!k) return tuntematon(nimi);
        return await k(argumentit, ctx.env, ctx);
      }
      if (!a.callTool) return tuntematon(nimi);
      return await a.callTool(nimi, argumentit, ctx.env, ctx);
    } catch (e) {
      if (e instanceof NaytettavaVirhe || e?.name === "NaytettavaVirhe") {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
      // Sisäistä virhetekstiä ei näytetä eikä kirjata (voi sisältää kantojen tai rajapintojen tietoja).
      console.error("tyokalu:", nimi, e?.name ?? "virhe");
      return { isError: true, content: [{ type: "text", text: YLEINEN_VIRHE }] };
    }
  }

  async function tyokaluKutsu(params, ctx) {
    const nimi = params?.name;
    if (a.sallitut) {
      const oikeudet = await sallitutOikeudet(ctx);
      // Kielletty työkalu vastaa kuten tuntematon, jottei olemassaolo paljastu.
      if (typeof nimi !== "string" || !nakyy(nimi, oikeudet) || (!uudet.has(nimi) && !vanhatMaarittelyt.has(nimi))) {
        return tuntematon(nimi);
      }
    }
    if (a.rajat && !(await a.rajat(ctx, nimi))) {
      const uusi = typeof nimi === "string" ? uudet.get(nimi) : null;
      if (uusi) return virheTulos(uusi, RAJA_TEKSTI, "raja");
      return { isError: true, content: [{ type: "text", text: RAJA_TEKSTI }] };
    }
    return kutsuTyokalua(nimi, params?.arguments, ctx);
  }

  async function kasitteleViesti(msg, ctx = {}) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      // Asiakkaan vastaukset (result/error): ei vastausta.
      if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) return null;
      return rpcError(msg?.id ?? null, -32600, "Invalid Request");
    }
    const ilmoitus = msg.id === undefined || msg.id === null;
    const { method, params } = msg;
    switch (method) {
      case "initialize": {
        const pyydetty = params?.protocolVersion;
        return ok(msg.id, {
          protocolVersion: PROTOKOLLAT.includes(pyydetty) ? pyydetty : PROTOKOLLAT[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return ok(msg.id, {});
      case "tools/list":
        return ok(msg.id, { tools: await tyokaluLista(ctx) });
      case "tools/call":
        return ok(msg.id, await tyokaluKutsu(params, ctx));
      case "resources/list":
        return ok(msg.id, { resources: [] });
      case "prompts/list":
        return ok(msg.id, { prompts: [] });
      default:
        if (ilmoitus) return null;
        return rpcError(msg.id, -32601, `Method not found: ${method}`);
    }
  }

  // ---------- 2026-07-28: tilaton pyyntö ----------

  const valmis = (tulos) => ({ ...tulos, resultType: "complete", _meta: { ...(onOlio(tulos?._meta) ? tulos._meta : {}), [SI]: serverInfo } });
  const lista = (tulos) => valmis({ ...tulos, ttlMs: valimuisti.ttlMs, cacheScope: valimuisti.cacheScope });

  /** Tarkistaa otsakkeet (Mcp-Method, Mcp-Name, Mcp-Param-*) rungon kenttiä vasten. Palauttaa virhetekstin tai null. */
  async function otsakeVirhe(request, msg, ctx) {
    const metodi = request.headers.get("Mcp-Method");
    if (metodi === null) return "Mcp-Method header missing";
    if (metodi !== msg.method) return "Mcp-Method header does not match body";
    const nimellinen = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" }[msg.method];
    if (!nimellinen) return null;
    const nimiOtsake = request.headers.get("Mcp-Name");
    if (nimiOtsake === null) return "Mcp-Name header missing";
    if (puraOtsake(nimiOtsake) !== msg.params?.[nimellinen]) return "Mcp-Name header does not match body";
    if (msg.method !== "tools/call") return null;
    // x-mcp-header: arvo rungossa -> otsake pakollinen ja sama. Vain näkyvän työkalun määrittely ratkaisee.
    const nimi = msg.params?.name;
    const oikeudet = await sallitutOikeudet(ctx);
    if (typeof nimi !== "string" || !nakyy(nimi, oikeudet)) return null;
    const merkinnat = uudet.get(nimi)?.otsakkeet ?? vanhatOtsakkeet.get(nimi) ?? [];
    const args = msg.params?.arguments;
    for (const { polku: p, otsake, tyyppi } of merkinnat) {
      let arvo = args;
      for (const k of p) arvo = onOlio(arvo) && Object.hasOwn(arvo, k) ? arvo[k] : undefined;
      if (arvo === undefined || arvo === null) continue;
      const raaka = request.headers.get(`Mcp-Param-${otsake}`);
      if (raaka === null) return `Mcp-Param-${otsake} header missing`;
      const purettu = puraOtsake(raaka);
      const sama = tyyppi === "integer"
        ? purettu !== null && /^-?\d+(\.0+)?$/.test(purettu) && Number.isSafeInteger(Number(purettu)) && Number(purettu) === arvo
        : tyyppi === "boolean"
          ? purettu === String(arvo)
          : purettu === arvo;
      if (!sama) return `Mcp-Param-${otsake} header does not match body`;
    }
    return null;
  }

  async function modernipyynto(request, body, ctx, versioOtsake) {
    const virhe = (status, id, code, message, data) => json(rpcError(id ?? null, code, message, data), status);
    if (Array.isArray(body)) return json(virheIlmanId(-32600, "Invalid Request: batch is not supported in 2026-07-28"), 400);
    if (!onOlio(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      if (onOlio(body) && body.id !== undefined && (body.result !== undefined || body.error !== undefined)) return new Response(null, { status: 202 });
      return virhe(400, body?.id, -32600, "Invalid Request");
    }
    const id = body.id;
    if (id === undefined || id === null) return new Response(null, { status: 202 });
    const meta = onOlio(body.params?._meta) ? body.params._meta : {};
    const pv = meta[PV];
    if (typeof pv !== "string") return virhe(400, id, -32602, `Invalid params: _meta ${PV} missing`);
    if (!MODERNIT_PROTOKOLLAT.includes(pv)) {
      return virhe(400, id, -32022, "Unsupported protocol version", { supported: TUETUT_PROTOKOLLAT, requested: pv.slice(0, 40) });
    }
    if (versioOtsake === null) return virhe(400, id, -32020, "Header mismatch: MCP-Protocol-Version header missing");
    if (versioOtsake !== pv) return virhe(400, id, -32020, "Header mismatch: MCP-Protocol-Version header does not match body");
    if (!onOlio(meta[CC])) return virhe(400, id, -32602, `Invalid params: _meta ${CC} missing`);
    ctx.protokolla = pv;
    const ov = await otsakeVirhe(request, body, ctx);
    if (ov) return virhe(400, id, -32020, `Header mismatch: ${ov}`);
    switch (body.method) {
      case "server/discover":
        return json(ok(id, lista({
          supportedVersions: TUETUT_PROTOKOLLAT,
          capabilities: { tools: {} },
          ...(instructions ? { instructions } : {}),
        })));
      case "tools/list":
        return json(ok(id, lista({ tools: await tyokaluLista(ctx) })));
      case "resources/list":
        return json(ok(id, lista({ resources: [] })));
      case "prompts/list":
        return json(ok(id, lista({ prompts: [] })));
      case "tools/call":
        return json(ok(id, valmis(await tyokaluKutsu(body.params, ctx))));
      default:
        // Ei ping- eikä initialize-metodia tässä versiossa.
        return virhe(404, id, -32601, `Method not found: ${body.method.slice(0, 80)}`);
    }
  }

  /** MCP-päätepisteen pyyntö, kun polku on jo hyväksytty (myös OAuth-liittimien apiHandler). */
  async function mcpPyynto(request, env, execCtx) {
    if (!originSallittu(request, originit)) {
      return json(virheIlmanId(-32600, "Forbidden origin"), 403);
    }
    if (request.method !== "POST") {
      // Tilaton palvelin: ei SSE-virtaa (GET) eikä istuntojen lopetusta (DELETE).
      return teksti("Method Not Allowed", 405, { Allow: "POST" });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }
    const viestit = Array.isArray(body) ? body : [body];
    const versio = request.headers.get("MCP-Protocol-Version");
    const ip = request.headers.get("CF-Connecting-IP") ?? "tuntematon";
    // 2026-07-28: versio otsakkeessa tai _meta-kentässä (ei initialize-pyyntöä eikä vanhaa versiota).
    const metaVersio = viestit.map((m) => (onOlio(m?.params?._meta) ? m.params._meta[PV] : undefined)).find((v) => v !== undefined);
    const moderni = (versio !== null && MODERNIT_PROTOKOLLAT.includes(versio))
      || (metaVersio !== undefined && !PROTOKOLLAT.includes(metaVersio) && !viestit.some((m) => m?.method === "initialize"));
    if (moderni) {
      // Istuntoja ei ole: Mcp-Session-Id ohitetaan eikä sitä anneta.
      return modernipyynto(request, body, { env, execCtx, session: null, ip }, versio);
    }
    // MCP-Protocol-Version lähetetään vasta initializen jälkeen; initialize-pyynnössä otsake ei ratkaise (versio neuvotellaan).
    const initialize = viestit.some((m) => m && m.method === "initialize");
    if (versio !== null && !initialize && !PROTOKOLLAT.includes(versio)) {
      return json(virheIlmanId(-32600, `Unsupported MCP-Protocol-Version: ${versio.slice(0, 40)}`), 400);
    }
    // Istuntotunnus on vain käyttörajoittimen avain; sitä ei tallenneta.
    const saapuva = request.headers.get("Mcp-Session-Id");
    const ctx = { env, execCtx, session: saapuva, ip, protokolla: versio };
    const otsakkeet = {};
    if (!saapuva && initialize) otsakkeet["Mcp-Session-Id"] = crypto.randomUUID();
    if (Array.isArray(body)) {
      const tulokset = (await Promise.all(body.map((m) => kasitteleViesti(m, ctx)))).filter(Boolean);
      return tulokset.length ? json(tulokset, 200, otsakkeet) : new Response(null, { status: 202, headers: otsakkeet });
    }
    const tulos = await kasitteleViesti(body, ctx);
    return tulos ? json(tulos, 200, otsakkeet) : new Response(null, { status: 202, headers: otsakkeet });
  }

  async function polkuKelpaa(pathname, env) {
    if (polku.julkinen) {
      if (pathname === "/mcp") return true;
      return oikeaPolku(pathname, env?.MCP_PATH_SECRET);
    }
    const salaisuudet = polku.salaisuudet ? polku.salaisuudet(env ?? {}) : [env?.MCP_PATH_SECRET];
    return oikeaPolku(pathname, salaisuudet);
  }

  async function fetch(request, env, execCtx) {
    const url = new URL(request.url);
    if (a.lisareitit) {
      const vastaus = await a.lisareitit(request, env, execCtx);
      if (vastaus) return vastaus;
    }
    if (url.pathname === "/" && request.method === "GET") {
      return teksti(juuriteksti ?? `${serverInfo.name} MCP -palvelin. Ei julkista sisältöä.\n`, 200, { "X-Robots-Tag": "noindex" });
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
    }
    if (!(await polkuKelpaa(url.pathname, env))) return new Response("Not found", { status: 404 });
    return mcpPyynto(request, env, execCtx);
  }

  return { fetch, mcpPyynto, kasitteleViesti };
}

/**
 * Tarkistaa liitinrepoon jaetun kopion: ensimmäinen rivi `// mcp-runko <versio> sha256:<tiiviste> ...`
 * ja tiiviste lasketaan muusta sisällöstä. Palauttaa { ok, versio, odotettu, laskettu }.
 */
export async function tarkistaKopio(tiedostonTeksti) {
  const rivinvaihto = tiedostonTeksti.indexOf("\n");
  const otsake = rivinvaihto < 0 ? tiedostonTeksti : tiedostonTeksti.slice(0, rivinvaihto);
  const loput = rivinvaihto < 0 ? "" : tiedostonTeksti.slice(rivinvaihto + 1);
  const m = /^\/\/ mcp-runko (\S+) sha256:([0-9a-f]{64})\b/.exec(otsake);
  const laskettu = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(loput)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { ok: !!m && m[2] === laskettu, versio: m?.[1] ?? null, odotettu: m?.[2] ?? null, laskettu };
}
