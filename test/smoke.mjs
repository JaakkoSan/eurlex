// Savutesti: kutsuu Workerin fetch-käsittelijää suoraan Nodessa oikeaa julkaisutoimiston rajapintaa vasten.
// Ajo: node test/smoke.mjs   (vaatii Node 22+)
// Palvelin rungon testitilassa (tarkistaTulokset): rakenteinen tulos tarkistetaan tulosSkeemaa vasten ja lahde.nimi
// vaaditaan jokaisessa onnistuneessa kutsussa; poikkeama kaataa kutsun ja näkyy FAIL-rivinä.

import { luoEurlex } from "../src/index.js";

const varoitukset = [];
const worker = luoEurlex({ tarkistaTulokset: true, varoita: (v) => varoitukset.push(v) });

const env = {};
let id = 0;

async function rpc(method, params) {
  const req = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const res = await worker.fetch(req, env);
  return res.json();
}

async function tool(name, args) {
  let r;
  try {
    r = await rpc("tools/call", { name, arguments: args });
  } catch (e) {
    // Testitilan skeemapoikkeama (mcp-runko tarkistaTulokset) tai muu kaatuminen.
    return { isError: true, text: `POIKKEUS: ${e.message}`, sc: undefined };
  }
  const text = r.result.content.map((c) => c.text).join("\n");
  return { isError: !!r.result.isError, text, sc: r.result.structuredContent };
}

function check(cond, label) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
check(init.result?.serverInfo?.name === "eurlex", "initialize");
const list = await rpc("tools/list", {});
check(list.result?.tools?.length === 10, "tools/list (10 työkalua)");

const show = process.argv.includes("-v");
const cases = [
  ["hae_eu_saadoksia", { hakusana: "tietosuoj", tyyppi: "asetus" }, (t) => t.includes("CELEX 3")],
  ["eu_saados_tiedot", { saados: "2016/679" }, (t) => t.includes("32016R0679") && t.includes("6 artikla Käsittelyn lainmukaisuus")],
  ["hae_eu_artikla", { saados: "asetus (EU) 2016/679", artikla: "6" }, (t) => t.includes("Käsittely on lainmukaista") && t.includes("KONSOLIDOITU")],
  ["hae_eu_artikla", { saados: "2016/679", johdanto_kappale: "47" }, (t) => t.includes("(47)") && t.includes("ALKUPERÄINEN")],
  ["hae_eu_artikla", { saados: "2017/745", liite: "XVI" }, (t) => t.includes("LIITE XVI")],
  ["hae_eu_artikla", { saados: "93/13/ETY", tyyppi: "direktiivi", artikla: "3" }, (t) => t.includes("kohtuuttomana")],
  ["hae_eu_artikla", { saados: "93/13/ETY", artikla: "3" }, (t) => t.includes("useita säädöksiä")],
  ["hae_eu_artikla", { saados: "2016/679", artikla: "999" }, (t) => t.includes("ei löytynyt")],
  ["etsi_eu_saadoksesta", { saados: "2024/1689", hakusana: "tunteentunnistus" }, (t) => t.includes("Osumat")],
  ["hae_eu_artikla", { saados: "2016/679", artikla: "6", kieli: "sv" }, (t) => t.includes("förordning")],
  ["hae_eu_tuomioita", { saados: "2016/679", artikla: "6" }, (t) => /\nC-\d+\/\d+ \(/.test(t) && t.includes("6 art. 1 kohta")],
  ["hae_eu_tuomioita", { hakusana: "Schrems" }, (t) => t.includes("C-311/18")],
  ["eu_tuomio", { tuomio: "C-311/18" }, (t) => t.includes("Tuomiolauselma") && t.includes("ECLI:EU:C:2020:559")],
  ["eu_tuomio", { tuomio: "ECLI:EU:C:2020:559", kohdat: "134" }, (t) => t.includes("\n134 Tältä osin")],
  ["eu_tuomio", { tuomio: "C-1/99" }, (t) => t.includes("Tuomiolauselma") && t.includes("Yhteisöjen")],
  ["eu_ehdotus", { ehdotus: "COM(2021) 206" }, (t) => t.includes("2021/0106(COD)") && t.includes("asetus 2024/1689") && t.includes("Vaiheet")],
  ["hae_eu_ehdotuksia", { hakusana: "lääkinnällis", tila: "vireilla" }, (t) => t.includes("COM(2025) 1023") && t.includes("vireillä")],
  ["hae_eu_artikla", { saados: "COM(2021) 206", artikla: "5" }, (t) => t.includes("KOMISSION EHDOTUS") && t.includes("1. Seuraavat tekoälyyn")],
  ["hae_eu_artikla", { saados: "COM(2021) 206", liite: "III" }, (t) => t.includes("LIITE III") && t.includes("SUURIRISKISET")],
  ["tuotevaroitukset", { kategoria: "kosmetiikka", viikkoja: 4 }, (t) => /\nSR\/\d+\/\d+ · /.test(t) && t.includes("Kosmetiikka") && t.includes("CC0")],
  ["tuotevaroitukset", { hakusana: "zzqxw-ei-ole", viikkoja: 1 }, (t) => t.includes("ei osumia")],
  ["eu_laiterekisteri", { valmistaja: "planmeca" }, (t) => t.includes("FI-MF-000006499") && t.includes("valmistaja")],
  ["eu_laiterekisteri", { srn: "FI-MF-000006499", laite: "compact" }, (t) => t.includes("UDI-DI") && t.includes("MDR")],
  ["eu_laiterekisteri", { udi_di: "00840682119696" }, (t) => t.includes("GE Healthcare Finland Oy") && t.includes("Riskiluokka: I luokka")],
];

for (const [name, args, pred] of cases) {
  const t0 = Date.now();
  const r = await tool(name, args);
  check(pred(r.text), `${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)`);
  if (show || !pred(r.text)) console.log(r.text.slice(0, 2500), "\n------");
}

// ---------- Rakenteinen tulos, sivutus ja oikeudet (runko 1.1.0, 22.11.2026) ----------

check(varoitukset.length === 0, `rungon testitilan varoitukset: ${varoitukset.length ? varoitukset.join(" | ") : "ei"}`);
{
  const tools = list.result.tools;
  check(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false), "kaikki työkalut vain lukevat (readOnlyHint, destructiveHint)");
  const os = tools.filter((t) => t.outputSchema).map((t) => t.name).sort();
  check(JSON.stringify(os) === JSON.stringify(["hae_eu_artikla", "hae_eu_ehdotuksia", "hae_eu_saadoksia", "hae_eu_tuomioita"]), `outputSchema: ${os.join(", ")}`);
  const sivu = tools.filter((t) => t.inputSchema.properties?.sivu?.type === "integer").map((t) => t.name).sort();
  check(JSON.stringify(sivu) === JSON.stringify(["hae_eu_ehdotuksia", "hae_eu_saadoksia", "hae_eu_tuomioita"]), `sivu-parametri: ${sivu.join(", ")}`);
}

const rakenne = [
  ["hae_eu_saadoksia", { hakusana: "kalastus" }, (r) =>
    r.sc?.saadokset?.length === 10 && r.sc.sivu === 1 && r.sc.seuraava === 2 && r.sc.saadokset.every((x) => /^3\d{4}[RLD]/.test(x.celex) && x.linkki.includes(x.celex))
    && r.text.includes(`${r.sc.saadokset[0].tunnus} (CELEX ${r.sc.saadokset[0].celex})`) && r.text.includes("Lisää tuloksia: hae sivu 2.")],
  ["hae_eu_saadoksia", { hakusana: "kalastus", sivu: 2 }, (r) => r.sc?.sivu === 2 && r.sc.saadokset.length > 0 && r.text.includes("(sivu 2,")],
  ["hae_eu_saadoksia", { hakusana: "tietosuoj", tyyppi: "asetus", sivu: 500 }, (r) => !r.isError && r.sc?.saadokset?.length === 0 && r.sc.seuraava === null && r.text === "Ei enempää tuloksia."],
  ["hae_eu_tuomioita", { hakusana: "Schrems" }, (r) => r.sc?.haku?.hakusana === "Schrems" && r.sc.tuomiot.some((x) => x.asia === "C-311/18" && x.ecli === "ECLI:EU:C:2020:559") && r.sc.seuraava === null],
  ["hae_eu_tuomioita", { saados: "2016/679", artikla: "6", sivu: 2 }, (r) =>
    r.sc?.haku?.celex === "32016R0679" && r.sc.haku.artikla === "6" && r.sc.sivu === 2 && r.sc.tuomiot.length > 0 && r.sc.tuomiot.every((x) => x.tulkitut_kohdat?.length)],
  ["hae_eu_ehdotuksia", { hakusana: "lääkinnällis", tila: "vireilla" }, (r) =>
    r.sc?.ehdotukset?.some((x) => x.tunnus === "COM(2025) 1023" && x.tilakoodi === "PROP_PENDING" && Array.isArray(x.menettelyt)) && r.sc.sivu === 1],
  ["hae_eu_ehdotuksia", { alkaen_vuosi: 2024, sivu: 2 }, (r) => r.sc?.sivu === 2 && r.sc.ehdotukset.length === 10 && r.text.includes("(sivu 2,")],
  ["hae_eu_artikla", { saados: "2016/679", artikla: "6" }, (r) =>
    r.sc?.saados?.celex === "32016R0679" && r.sc.versio.laji === "konsolidoitu" && /^\d{4}-\d{2}-\d{2}$/.test(r.sc.versio.paiva) && r.sc.osa.laji === "artikla" && r.sc.osa.numero === "6"
    && r.sc.teksti === undefined && r.sc.lahde.linkki.includes(r.sc.versio.celex) && r.text.includes("Käsittely on lainmukaista")],
  ["hae_eu_artikla", { saados: "COM(2021) 206", artikla: "5" }, (r) => r.sc?.versio?.laji === "ehdotus" && r.sc.saados.tunnus === "COM(2021) 206"],
  ["hae_eu_artikla", { saados: "2016/679", artikla: "999" }, (r) => r.isError && r.sc?.virhe?.koodi === "ei_loydy" && r.text.includes("ei löytynyt")],
  ["hae_eu_saadoksia", { hakusana: "x", tyyppi: "huono" }, (r) => r.isError && r.sc?.virhe?.koodi === "syote"],
  ["eu_tuomio", { tuomio: "C-9999/99" }, (r) => r.isError && r.sc?.virhe?.koodi === "ei_loydy"],
  ["eu_saados_tiedot", { saados: "2016/679" }, (r) => !r.isError && r.sc === undefined],
];
for (const [name, args, pred] of rakenne) {
  const r = await tool(name, args);
  const okk = (() => { try { return !!pred(r); } catch { return false; } })();
  check(okk, `rakenne ${name} ${JSON.stringify(args)}`);
  if (show || !okk) console.log(r.text.slice(0, 1500), "\n", JSON.stringify(r.sc)?.slice(0, 1500), "\n------");
}

// Protokolla 2026-07-28 (tilaton, ei initializea): tools/call _meta-kentällä ja otsakkeilla.
{
  const body = { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "hae_eu_tuomioita", arguments: { hakusana: "Schrems" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } };
  const res = await worker.fetch(new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "hae_eu_tuomioita" },
    body: JSON.stringify(body),
  }), env);
  const j = await res.json();
  check(res.status === 200 && j.result?.resultType === "complete" && j.result.structuredContent?.tuomiot?.length > 0, "protokolla 2026-07-28: tools/call");
}

