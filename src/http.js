// HTTP-apu: Cloudflaren Cache API, uudelleenyritykset ja isolaatin muistivälimuisti.

const USER_AGENT = "eurlex-mcp/1.0 (Claude-liitin; Cloudflare Worker)";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class SourceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hakee URL:n tekstinä (GET). 404 palauttaa null. ttl sekunteina, 0 = ei välimuistia.
 * Välimuistiavaimeen lisätään otsakkeet, joilla sisältöneuvottelu tehdään.
 */
export async function fetchText(url, { ttl = 3600, headers = {}, allow300 = false } = {}) {
  const cache = cacheApi();
  const keyParts = Object.entries(headers)
    .sort()
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const cacheKey = new Request(url + (url.includes("?") ? "&" : "?") + "_h=" + encodeURIComponent(keyParts));
  if (cache && ttl > 0) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.status === 404 ? null : await hit.text();
  }
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
    } catch (e) {
      lastErr = e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 404 || res.status === 406) {
      if (cache && ttl > 0) await cache.put(cacheKey, new Response("", { status: 404, headers: { "Cache-Control": "max-age=600" } }));
      return null;
    }
    // 300 Multiple Choices: Cellar palauttaa luettelon, kun kieliversiossa on useita tiedostoja (esim. ehdotus ja liitteet).
    if (res.ok || (allow300 && res.status === 300)) {
      const body = await res.text();
      if (cache && ttl > 0) {
        await cache.put(cacheKey, new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": `max-age=${ttl}` } }));
      }
      return body;
    }
    lastErr = new SourceError(`Lähde vastasi ${res.status}`, res.status);
    if (!RETRY_STATUS.has(res.status)) break;
    await sleep(500 * 2 ** attempt);
  }
  throw lastErr instanceof SourceError ? lastErr : new SourceError(`Lähteeseen ei saatu yhteyttä: ${lastErr?.message ?? lastErr}`, 0);
}

export async function cacheGetJson(key) {
  const cache = cacheApi();
  if (!cache) return undefined;
  const hit = await cache.match(new Request(key));
  if (!hit) return undefined;
  try {
    return await hit.json();
  } catch {
    return undefined;
  }
}

export async function cachePutJson(key, value, ttl) {
  const cache = cacheApi();
  if (!cache || !(ttl > 0)) return;
  await cache.put(new Request(key), new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } }));
}

// ---------- Isolaatin muisti ----------

const MEMO_MAX = 64;
const memo = new Map();

export function memoGet(key) {
  const e = memo.get(key);
  if (!e) return undefined;
  memo.delete(key);
  if (e.exp < Date.now()) return undefined;
  memo.set(key, e);
  return e.value;
}

export function memoSet(key, value, ttl) {
  memo.delete(key);
  memo.set(key, { value, exp: Date.now() + ttl * 1000 });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
}

/** Johdettu tieto ensin muistista, sitten välimuistista. */
export async function getDerived(key, ttl) {
  let v = memoGet(key);
  if (v !== undefined) return v;
  v = await cacheGetJson(key);
  if (v !== undefined) memoSet(key, v, ttl);
  return v;
}

/** Tallentaa useamman johdetun osan rinnakkain (jokainen tallennus on alipyyntö). */
export async function putDerived(entries, ttl) {
  await Promise.all(
    entries.map(([key, v]) => {
      memoSet(key, v, ttl);
      return cachePutJson(key, v, ttl);
    }),
  );
}
