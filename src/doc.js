// EUR-Lex-asiakirjan (Cellarin XHTML tai vanha HTML) jäsennys kappaleiksi ja
// hakemistoksi: artiklat, johdanto-osan perustelukappaleet, liitteet ja sisällysluettelo.
//
// Asiakirjoja on kolmea muotoa:
// 1. ELI-tunnisteellinen XHTML (uudet alkuperäiset ja konsolidoidut tekstit):
//    artiklat, perustelukappaleet ja liitteet ovat elementeissä, joiden id on
//    art_N, rct_N tai anx_X.
// 2. Vanhempi konsolidoitu XHTML ilman tunnisteita: artiklan otsikko tunnistetaan
//    luokasta (title-article-norm, ti-art).
// 3. Vanha HTML 4 (vanhimmat alkuperäiset tekstit): artiklan otsikko tunnistetaan
//    tekstistä ("3 artikla").
//
// Hakemisto tallennetaan välimuistiin osina (ks. tools.js), joten tässä tuotetaan
// pelkkää dataa: { base, paras }.

import { parseXml, find, elements, textOf, decodeEntities } from "./xml.js";

export const DOC_INDEX_VERSION = 3;

const BLOCK = new Set([
  "p", "div", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "ul", "ol", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "article", "hr", "center", "caption",
]);
const SKIP = new Set(["script", "style", "head", "col", "colgroup", "img", "hr"]);

const norm = (s) => s.replace(/\s+/g, " ").trim();
const cls = (el) => el.attrs?.class ?? "";
const hasBlock = (el) => el.children.some((c) => typeof c !== "string" && (BLOCK.has(c.name) || hasBlock(c)));

// Elementin tunnisteesta asiakirjan osa: art_6 -> "art_6", art_6.tit_1 -> "art_6", anx_I -> "anx_I".
const ELI_ID = /^(art|rct|anx)_([^.]+)/;

function inlineText(el) {
  return typeof el === "string" ? el : textOf(el);
}

/**
 * Muuntaa XHTML-puun kappaleiksi. Kappale: { t, c (luokka), z (art_/rct_/anx_-tunniste tai "") }.
 * Rivien (tr) ja ruudukkolistojen (grid-container) ensimmäinen sarake ("a)", "(1)", "1.")
 * yhdistetään seuraavan sarakkeen ensimmäiseen kappaleeseen.
 */
function toParas(body) {
  const out = [];
  let sig = 0;

  const push = (t, c, z) => {
    t = norm(t);
    if (t) out.push({ t, c: sig ? "coj-signature" : c, z });
  };

  // Etuliite (esim. "1." tai "a)") lisätään ensimmäiseen kappaleeseen, joka syntyy tämän jälkeen.
  const withPrefix = (prefix, fn, z) => {
    const before = out.length;
    fn();
    const p = norm(prefix);
    if (!p) return;
    if (out.length > before) out[before].t = `${p} ${out[before].t}`;
    else out.push({ t: p, c: "", z });
  };

  const walk = (node, z) => {
    let pending = "";
    for (const ch of node.children) {
      if (typeof ch === "string") {
        pending += ch;
        continue;
      }
      if (SKIP.has(ch.name)) continue;
      if (!BLOCK.has(ch.name) && !hasBlock(ch)) {
        pending += inlineText(ch);
        continue;
      }
      const prefix = pending;
      pending = "";
      withPrefix(prefix, () => block(ch, z), z);
    }
    if (norm(pending)) push(pending, cls(node), z);
  };

  const block = (el, z) => {
    const id = el.attrs?.id ?? "";
    const m = id.match(ELI_ID);
    if (m) z = `${m[1]}_${m[2]}`;
    // Tuomion allekirjoituslohkon kappaleet merkitään, jotta tuomiolauselma päättyy niihin.
    const isSig = /(^|\s)(coj-)?signaturecase(\s|$)/.test(cls(el));
    if (isSig) sig++;
    try {
      blockInner(el, z);
    } finally {
      if (isSig) sig--;
    }
  };

  const blockInner = (el, z) => {
    const c = sig ? "coj-signature" : cls(el);

    if (el.name === "tr") {
      const cells = elements(el).filter((x) => x.name === "td" || x.name === "th");
      const first = cells[0] ? norm(textOf(cells[0])) : "";
      if (cells.length === 2 && first.length <= 8) {
        withPrefix(first, () => walk(cells[1], z), z);
      } else {
        push(cells.map((x) => norm(textOf(x))).filter(Boolean).join(" | "), c, z);
      }
      return;
    }
    if (/\bgrid-container\b/.test(c)) {
      const cols = elements(el);
      const c1 = cols.find((x) => /grid-list-column-1/.test(cls(x)));
      const c2 = cols.find((x) => /grid-list-column-2/.test(cls(x)));
      if (c1 && c2) {
        withPrefix(textOf(c1), () => walk(c2, z), z);
        return;
      }
    }
    if (hasBlock(el)) {
      walk(el, z);
      return;
    }
    push(textOf(el), c, z);
  };

  walk(body, "");
  return out;
}

// HTML 4:n nimetyt merkit (Latin-1 ja yleisimmät typografiset), joita XML-entiteetit eivät kata.
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const HTML_ENT = Object.fromEntries(LATIN1.map((n, i) => [n, String.fromCharCode(160 + i)]));
Object.assign(HTML_ENT, { ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bdquo: "„", hellip: "…", euro: "€", bull: "•", Scaron: "Š", scaron: "š", Zcaron: "Ž", zcaron: "ž", OElig: "Œ", oelig: "œ" });
function decodeHtml(s) {
  return decodeEntities(s).replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => HTML_ENT[n] ?? m);
}

/** Vanha HTML 4: kappaleet lohkotagien kohdalta. Rakenteen tunnistus tekstistä. */
function legacyParas(html) {
  const bodyStart = html.search(/<body[^>]*>/i);
  let s = bodyStart >= 0 ? html.slice(bodyStart) : html;
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<\/?(p|div|br|tr|li|h[1-6]|table|blockquote)[^>]*>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, " ");
  s = s.replace(/<[^>]+>/g, "");
  return decodeHtml(s)
    .split("\n")
    .map((t) => norm(t))
    .filter(Boolean)
    .map((t) => ({ t, c: "", z: "" }));
}

// Artiklan otsikko eri kielillä: "6 artikla", "Artikel 6", "Article 6".
const ART_TEXT = /^(?:(\d+\s*[a-z]?)\s+artikla|artikel\s+(\d+\s*[a-z]?)|article\s+(\d+\s*[a-z]?))$/i;
const ART_CLASS = /(^|\s)(oj-)?ti-art(\s|$)|title-article-norm/;
const SUBTITLE_CLASS = /(^|\s)(oj-)?sti-art(\s|$)|stitle-article-norm/;
const CHAPTER_CLASS = /(oj-)?ti-section-[12]|title-division-[12]|title-gr-seq-level-[12]/;
const ANNEX_TEXT = /^(LIITE|BILAGA|ANNEX|LIITTEET|BILAGOR|ANNEXES)(\s+[IVXLC\d]+[A-Z]?)?$/;
const DOC_TITLE_CLASS = /(oj-)?doc-ti|title-annex|title-doc-first/;

function artNumber(t) {
  const m = t.match(ART_TEXT);
  return m ? (m[1] ?? m[2] ?? m[3]).replace(/\s+/g, "") : null;
}

// Komission ehdotukset (COM): artiklan numero ja nimi samassa kappaleessa ("1 artikla Kohde"),
// johdanto-osan perustelukappaleet luokalla ManualConsidrant ("(1) …").
const PROP_ART_CLASS = /(^|\s)Titrearticle(\s|$)/;
const PROP_ART_TEXT = /^(?:(\d+\s*[a-z]?)\s+artikla|artikel\s+(\d+\s*[a-z]?)|article\s+(\d+\s*[a-z]?))\b\s*(.*)$/i;
const PROP_RECITAL_CLASS = /(^|\s)ManualConsidrant(\s|$)/;
const PROP_ANNEX_CLASS = /(^|\s)Annexetitre(\s|$)/;
const PROP_ANNEX_TEXT = /^(?:LIITE|BILAGA|ANNEX)\s+([IVXLC]+[A-Z]?|\d+[a-z]?)\b\s*(.*)$/;
// Ehdotusten luettelokappaleissa numero ja teksti ovat eri span-elementeissä ilman väliä ("1.Seuraavat").
const PROP_LIST_CLASS = /(^|\s)li(\s|$)/;

/**
 * Muodostaa hakemiston asiakirjan merkkijonosta.
 * Palauttaa { base, paras } tai null, jos asiakirjassa ei ole tekstiä.
 */
export function buildDocIndex(text, { judgment = false } = {}) {
  const isXml = /^\s*(<\?xml|<!DOCTYPE html PUBLIC "-\/\/W3C\/\/DTD XHTML)/i.test(text) || /<html[^>]+xmlns=/.test(text.slice(0, 2000));
  let paras;
  let format;
  if (isXml) {
    const root = parseXml(text);
    const body = find(root, "body");
    if (!body) return null;
    paras = toParas(body);
    format = paras.some((p) => p.z) ? "eli" : "xhtml";
  } else {
    paras = legacyParas(text);
    format = "html";
  }
  if (!paras.length) return null;
  for (const p of paras) if (PROP_LIST_CLASS.test(p.c)) p.t = p.t.replace(/^(\(?[0-9]{1,3}[a-z]?[.)]|\(?[a-z]{1,4}\))(?=\S)/, "$1 ");

  const base = { v: DOC_INDEX_VERSION, format, nParas: paras.length, articles: [], recitals: [], annexes: [], toc: "" };

  if (format === "eli") {
    // Kappaleet ryhmitellään art_/rct_/anx_-tunnisteen mukaan. Saman osan kappaleet
    // ovat yleensä peräkkäin; jos osa katkeaa (esim. alaviite välissä), se jatkuu
    // uutena jaksona (parts).
    const lists = { art: base.articles, rct: base.recitals, anx: base.annexes };
    const byZ = new Map();
    let lastZ = null;
    paras.forEach((p, i) => {
      if (!p.z) {
        lastZ = null;
        return;
      }
      let item = byZ.get(p.z);
      if (!item) {
        const [kind, ...rest] = p.z.split("_");
        item = { z: p.z, n: rest.join("_"), parts: [] };
        byZ.set(p.z, item);
        lists[kind].push(item);
      }
      if (lastZ === p.z) item.parts.at(-1)[1] = i + 1;
      else item.parts.push([i, i + 1]);
      lastZ = p.z;
    });
  } else {
    // Otsikoiden perusteella: artikla jatkuu seuraavaan artiklaan, lukuun tai liitteeseen.
    let open = null;
    const close = (i) => {
      if (open) open.parts[0][1] = i;
      open = null;
    };
    paras.forEach((p, i) => {
      if (PROP_RECITAL_CLASS.test(p.c)) {
        const r = p.t.match(/^\((\d+)\)/);
        if (r && !base.recitals.some((x) => x.n === r[1])) {
          base.recitals.push({ z: `rct_${r[1]}`, n: r[1], parts: [[i, i + 1]] });
          return;
        }
      }
      if (PROP_ANNEX_CLASS.test(p.c)) {
        const am = p.t.match(PROP_ANNEX_TEXT);
        if (am) {
          close(i);
          open = { z: `anx_${am[1]}`, n: am[1], parts: [[i, i + 1]], title0: am[2].trim() };
          base.annexes.push(open);
          return;
        }
      }
      if (PROP_ART_CLASS.test(p.c)) {
        const pm = p.t.match(PROP_ART_TEXT);
        if (pm) {
          close(i);
          const n0 = (pm[1] ?? pm[2] ?? pm[3]).replace(/\s+/g, "");
          open = { z: `art_${n0}`, n: n0, parts: [[i, i + 1]], title0: pm[4].trim() };
          base.articles.push(open);
          return;
        }
      }
      const n = format === "html" || ART_CLASS.test(p.c) ? artNumber(p.t) : null;
      if (n) {
        close(i);
        open = { z: `art_${n}`, n, parts: [[i, i + 1]] };
        base.articles.push(open);
        return;
      }
      if (ANNEX_TEXT.test(p.t)) {
        close(i);
        const n2 = p.t.split(/\s+/)[1] ?? String(base.annexes.length + 1);
        open = { z: `anx_${n2}`, n: n2, parts: [[i, i + 1]] };
        base.annexes.push(open);
        return;
      }
      if (format === "xhtml" && CHAPTER_CLASS.test(p.c) && open?.z.startsWith("art_")) close(i);
    });
    close(paras.length);
  }

  // Artiklan otsikkorivi ("6 artikla") ja nimi (alaotsikko, jos on). Pelkät
  // muutosmerkinnät ("▼C2", "▼M3") ohitetaan.
  const isMark = (t) => /^[▼►◄]\s*[A-Z]?\d*\s*$/.test(t);
  for (const a of base.articles) {
    const [s, e] = a.parts[0];
    let i = s;
    while (i < e - 1 && isMark(paras[i].t)) i++;
    if (a.title0 !== undefined) {
      a.h = paras[i].t.slice(0, paras[i].t.length - a.title0.length).trim();
      a.title = a.title0;
      delete a.title0;
      continue;
    }
    a.h = paras[i].t;
    a.title = i + 1 < e && SUBTITLE_CLASS.test(paras[i + 1].c) ? paras[i + 1].t : "";
  }
  for (const x of base.annexes) {
    const [s, e] = x.parts[0];
    if (x.title0 !== undefined) {
      x.h = paras[s].t.slice(0, paras[s].t.length - x.title0.length).trim();
      x.title = x.title0.slice(0, 200);
      delete x.title0;
      continue;
    }
    let h = s;
    while (h < e - 1 && isMark(paras[h].t)) h++;
    x.h = paras[h].t;
    const next = [];
    for (let i = h + 1; i < Math.min(e, h + 3); i++) if (!isMark(paras[i].t)) next.push(paras[i].t);
    x.title = (next[0] ?? "").slice(0, 200);
  }

  // Sisällysluettelo: luvut ja jaksot sekä artiklat otsikoineen järjestyksessä.
  const lines = [];
  const inAnnex = new Set();
  for (const x of base.annexes) for (const [s, e] of x.parts) for (let i = s; i < e; i++) inAnnex.add(i);
  const artAt = new Map(base.articles.map((a) => [a.parts[0][0], a]));
  const anxAt = new Map(base.annexes.map((a) => [a.parts[0][0], a]));
  let inChapterHead = false;
  paras.forEach((p, i) => {
    const a = artAt.get(i);
    if (a) {
      lines.push(`  ${a.h}${a.title ? ` ${a.title}` : ""}`);
      inChapterHead = false;
      return;
    }
    const x = anxAt.get(i);
    if (x) {
      lines.push(`${x.h}${x.title ? ` ${x.title}` : ""}`);
      return;
    }
    if (CHAPTER_CLASS.test(p.c) && !inAnnex.has(i)) {
      // Luvun numero ja nimi ovat usein peräkkäisinä kappaleina: yhdistetään.
      if (inChapterHead && lines.length) lines[lines.length - 1] += ` ${p.t}`;
      else lines.push(p.t);
      inChapterHead = !inChapterHead;
      return;
    }
    inChapterHead = false;
  });
  base.toc = lines.join("\n").slice(0, 30000);

  // Konsolidoidun tekstin alku: huomautus ja muutosmerkintöjen selite (►M1 = muutossäädös).
  const startB = paras.findIndex((p) => p.t === "▼B");
  if (startB > 0 && startB < 400) {
    base.consolidatedNote = paras[1]?.t.startsWith("Tämä asiakirja") || /dokument|document/i.test(paras[1]?.t ?? "") ? paras[1].t : "";
    base.legend = {};
    for (let i = 0; i < startB; i++) {
      const m = paras[i].t.match(/^►([MACB]\d*)\s*\|?\s*(.*)$/);
      if (m) base.legend[m[1]] = m[2].replace(/\s*\|\s*/g, ", ").replace(/,\s*,/g, ",").slice(0, 250);
    }
  }
  base.title = paras.slice(0, 12).find((p) => DOC_TITLE_CLASS.test(p.c) || /hd-ti/.test(p.c))?.t ?? "";

  // Tuomio: numeroidut kappaleet, tuomiolauselma ja väliotsikot.
  if (judgment || paras.some((p) => /(^|\s)coj-/.test(p.c))) base.judgment = judgmentStructure(paras);
  return { base, paras: paras.map((p) => p.t) };
}

// ---------- Tuomiot ----------

const OPERATIVE_START = /^(Näillä perusteilla|Mot denna bakgrund|På dessa grunder|On those grounds)/;
const OPERATIVE_END = /^(Allekirjoitukset|Underskrifter|Signatures|Delivered in open court|Julistettu|Avkunnad|\( \*)/;

/**
 * Numeroidut kappaleet tunnistetaan järjestyksestä (1, 2, 3 …), jolloin esimerkiksi
 * päivämäärärivi "16 päivänä heinäkuuta 2020" ei sekoitu niihin.
 * Palauttaa { jp: kappaleen n indeksi = jp[n-1], op: [alku, loppu] | null, headings: [[indeksi, teksti]] }.
 */
function judgmentStructure(paras) {
  const jp = [];
  paras.forEach((p, i) => {
    const m = p.t.match(/^(\d+) \S/);
    if (m && +m[1] === jp.length + 1) jp.push(i);
  });
  const s = paras.findIndex((p) => OPERATIVE_START.test(p.t));
  let op = null;
  if (s >= 0) {
    let e = s + 1;
    while (e < paras.length && !OPERATIVE_END.test(paras[e].t) && paras[e].c !== "coj-signature") e++;
    op = [s, e];
  }
  const headings = [];
  paras.forEach((p, i) => {
    if (/(^|\s)(coj-)?(title-grseq-[234]|sum-title-1)(\s|$)/.test(p.c) && p.t.length < 300) headings.push([i, p.t]);
  });
  return { jp, op, headings };
}

