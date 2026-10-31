// Pieni, riippuvuukseton XML-jäsennin Finlexin Akoma Ntoso -dokumenteille.
// Ei validoi. Riittää hyvinmuodostetulle XML:lle: elementit, attribuutit,
// teksti, kommentit, CDATA ja merkkientiteetit.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const ATTR_RE = /([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(src) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/**
 * Jäsentää XML-merkkijonon puuksi.
 * Solmu: { name, attrs, children: Array<Solmu|string>, parent }
 * Palauttaa juurisolmun nimeltä "#document".
 */
export function parseXml(xml) {
  const root = { name: "#document", attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      pushText(cur, xml.slice(i));
      break;
    }
    if (lt > i) pushText(cur, xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const text = xml.slice(lt + 9, end === -1 ? n : end);
      if (text) cur.children.push(text);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    if (gt === -1) break;
    if (xml[lt + 1] === "/") {
      const name = xml.slice(lt + 2, gt).trim();
      // Nouse kunnes löytyy vastaava avaava elementti (sietää pieniä virheitä).
      let node = cur;
      while (node && node.name !== name) node = node.parent;
      if (node && node.parent) cur = node.parent;
      i = gt + 1;
      continue;
    }
    const selfClosing = xml[gt - 1] === "/";
    const inner = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const sp = inner.search(/[\s]/);
    const name = sp === -1 ? inner : inner.slice(0, sp);
    const attrs = sp === -1 ? {} : parseAttrs(inner.slice(sp));
    const el = { name, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!selfClosing) cur = el;
    i = gt + 1;
  }
  return root;
}

function findTagEnd(xml, start) {
  let q = null;
  for (let j = start + 1; j < xml.length; j++) {
    const c = xml[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === ">") {
      return j;
    }
  }
  return -1;
}

function pushText(node, raw) {
  if (!raw) return;
  node.children.push(decodeEntities(raw));
}

// --- Apufunktiot puun läpikäyntiin ---

export function elements(node) {
  return node.children.filter((c) => typeof c !== "string");
}

export function child(node, name) {
  return node.children.find((c) => typeof c !== "string" && c.name === name) ?? null;
}

export function childrenNamed(node, name) {
  return node.children.filter((c) => typeof c !== "string" && c.name === name);
}

/** Ensimmäinen jälkeläinen (syvyyshaku), jonka nimi täsmää. */
export function find(node, name) {
  for (const c of node.children) {
    if (typeof c === "string") continue;
    if (c.name === name) return c;
    const r = find(c, name);
    if (r) return r;
  }
  return null;
}

/** Kaikki jälkeläiset, joiden nimi täsmää (ei laskeudu löydettyjen sisään, jos stopInside). */
export function findAll(node, name, out = [], stopInside = false) {
  for (const c of node.children) {
    if (typeof c === "string") continue;
    if (c.name === name) {
      out.push(c);
      if (stopInside) continue;
    }
    findAll(c, name, out, stopInside);
  }
  return out;
}

/** Elementin koko tekstisisältö, välilyönnit normalisoituna. */
export function textOf(node) {
  if (!node) return "";
  if (typeof node === "string") return node.replace(/\s+/g, " ").trim();
  let s = "";
  const walk = (n) => {
    for (const c of n.children) {
      if (typeof c === "string") s += c;
      else if (c.name === "img") s += " [kuva] ";
      else if (c.name === "br") s += " ";
      else walk(c);
    }
  };
  walk(node);
  return s.replace(/\s+/g, " ").trim();
}
