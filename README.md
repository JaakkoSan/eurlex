# eurlex-mcp

Claude-liitin (MCP-palvelin), joka hakee EU-säädösten (asetukset, direktiivit, päätökset) ja EU-tuomioistuimen ratkaisujen sanatarkan tekstin ja tiedot EU:n julkaisutoimiston avoimesta tietokannasta (Cellar). Aineisto on sama kuin EUR-Lexissä. Toimii Cloudflare Workerina, ei tallenna mitään eikä tarvitse API-avaimia tai rekisteröitymistä.

## Työkalut

| Työkalu | Mitä tekee |
|---|---|
| `hae_eu_saadoksia` | Haku säädöksen nimen sanoilla, tyypillä, vuosilla ja voimassaololla |
| `eu_saados_tiedot` | Nimi, CELEX- ja ELI-tunnus, antopäivä, voimaantulo- ja soveltamispäivät, voimassaolo, konsolidoidut versiot (myös tulevat), muuttavat ja kumoavat säädökset, sisällysluettelo |
| `hae_eu_artikla` | Artiklan, johdanto-osan perustelukappaleen tai liitteen sanatarkka teksti |
| `etsi_eu_saadoksesta` | Sanahaku yhden säädöksen tekstistä, palauttaa osumat artikloittain |
| `hae_eu_tuomioita` | Unionin tuomioistuimen ja unionin yleisen tuomioistuimen tuomiot ja määräykset, jotka tulkitsevat annettua säädöstä tai artiklaa, tai haku otsikon sanoilla |
| `eu_tuomio` | Tuomion perustiedot, tulkitut säännökset ja tuomiolauselma; lisäksi numeroidut kohdat tai sanahaku tuomion tekstistä |

Säädöksen voi antaa numerona (`2016/679`, `93/13/ETY`, `asetus (EY) N:o 1907/2006`), CELEX-numerona (`32016R0679`) tai ELI-osoitteena. Kieli: suomi (oletus), ruotsi tai englanti.

## Versiot

- Oletuksena käytetään uusinta jo voimassa olevaa konsolidoitua tekstiä. Jos tulossa on myöhempi konsolidoitu versio, vastaus kertoo sen päivämäärän.
- `versio: "alkuperainen"` hakee EU:n virallisessa lehdessä julkaistun alkuperäisen tekstin, ja päivämäärä (`versio: "2024-01-01"`) hakee konsolidoidun tekstin sellaisena kuin se oli voimassa tuona päivänä.
- Johdanto-osan perustelukappaleet ovat vain alkuperäisessä tekstissä, joten ne haetaan aina sieltä.
- Konsolidoitu teksti on EUR-Lexin dokumentointiväline eikä oikeudellisesti sitova. Konsolidoidun tekstin muutosmerkinnät (►M1 jne.) selitetään vastauksessa.

## Rajapinta

- Asiakirja: `https://publications.europa.eu/resource/celex/{CELEX}` sisältöneuvottelulla (`Accept: application/xhtml+xml`, vanhimmille `text/html`; `Accept-Language: fin|swe|eng`)
- Metatiedot ja haku: SPARQL `https://publications.europa.eu/webapi/rdf/sparql` (CDM-ontologia)
- Konsolidoidut versiot: `cdm:act_consolidated_based_on_resource_legal`
- Välimuisti: asiakirjan hakemisto 30 vrk (tietty CELEX-versio ei muutu), metatiedot 6 h (Cloudflaren Cache API). Asiakirja jäsennetään kerran ja tallennetaan osina (perustiedot ja kappaleosat), jotta kutsu pysyy Workersin ilmaistason CPU-rajan alla.

## Oikeuskäytäntö

- Tuomion voi antaa asianumerona (`C-311/18`, `T-604/18`), CELEX-numerona (`62018CJ0311`) tai ECLI-tunnuksena (`ECLI:EU:C:2020:559`).
- Tulkitut säännökset tulevat julkaisutoimiston luokittelusta (`cdm:case-law_interpretes_resource_legal` ja sen tarkennukset artiklaan, kohtaan ja alakohtaan). Luokittelu voi olla puutteellinen, etenkin uusimmissa ratkaisuissa.
- `eu_tuomio` palauttaa oletuksena perustiedot, tulkitut säännökset ja tuomiolauselman sekä tuomion rakenteen (väliotsikot ja kohtien numerot). Kohdat haetaan `kohdat`-parametrilla (enintään 60 kerralla).
- Rakenne tunnistetaan XHTML-luokista (`coj-count`, `coj-title-grseq-N`, vanhemmissa sama ilman `coj-`-etuliitettä). Vanhimmista HTML-tuomioista kohdat tunnistetaan tekstistä.
- Julkisasiamiehen ratkaisuehdotukset eivät ole mukana.

## Rakenteen tunnistus

- Uudet ja konsolidoidut tekstit: artiklat, johdanto-osan perustelukappaleet ja liitteet ELI-tunnisteista (`art_6`, `rct_47`, `anx_XVI`).
- Vanhemmat konsolidoidut tekstit: artiklan otsikko luokasta (`title-article-norm`).
- Vanhimmat alkuperäiset tekstit (HTML 4): artiklan otsikko tekstistä ("3 artikla").

## Käyttörajoitus ja merkinnät

- Työkalukutsuja rajoitetaan Cloudflaren Rate Limiting -sidonnoilla: 30 kutsua minuutissa per MCP-istunto ja 300 per IP-osoite.
- Kaikilla työkaluilla on MCP-merkinnät `readOnlyHint: true` ja `destructiveHint: false`.
- Yhden vastauksen enimmäispituus on 50 000 merkkiä.

## Kehitys

```
npm install
node test/smoke.mjs      # savutesti oikeaa rajapintaa vasten
npx wrangler dev         # paikallinen palvelin: http://localhost:8787/mcp
```

## Julkaisu

Cloudflare Workers Builds julkaisee automaattisesti pushista main-haaraan (`npx wrangler deploy`). Liittimen osoite on `https://eurlex-mcp.<alitunnus>.workers.dev/mcp`.

## Rajoitukset

- Haku kohdistuu säädösten nimiin, ei koko tekstiin. Yhden säädöksen sisällä toimii sanahaku.
- Osa vanhemmista alkuperäisistä teksteistä on julkaisutoimiston aineistossa vain PDF:nä. Niistä liitin ohjaa konsolidoituun tekstiin tai EUR-Lexiin.
- Tuomioiden haku kohdistuu otsikoihin ja julkaisutoimiston luokitteluun, ei koko tekstiin.
- Direktiivi velvoittaa jäsenvaltioita; yksityisiin sovelletaan yleensä kansallista täytäntöönpanolakia.

## Lisenssi ja lähde

Koodi: MIT, ks. [LICENSE](LICENSE). Data: © Euroopan unioni, https://eur-lex.europa.eu. Komission asiakirjojen uudelleenkäyttö on sallittua kaupallisiin ja ei-kaupallisiin tarkoituksiin maksutta (komission päätös 2011/833/EU); lähde on mainittava eikä alkuperäistä merkitystä saa vääristää. Vain EU:n virallisessa lehdessä julkaistut tekstit ovat todistusvoimaisia. Tämä ei ole EU:n julkaisutoimiston palvelu.
