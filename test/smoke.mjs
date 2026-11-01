// Savutesti: kutsuu Workerin fetch-käsittelijää suoraan Nodessa oikeaa julkaisutoimiston rajapintaa vasten.
// Ajo: node test/smoke.mjs   (vaatii Node 20+)

import worker from "../src/index.js";

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
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result.content.map((c) => c.text).join("\n");
  return { isError: !!r.result.isError, text };
}

function check(cond, label) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
check(init.result?.serverInfo?.name === "eurlex", "initialize");
const list = await rpc("tools/list", {});
check(list.result?.tools?.length === 8, "tools/list (8 työkalua)");

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
