# PROJECT.md: eurlex-mcp

Oma Claude-liitin EU-säädöksille. Tehty 31.10.2026 Finlex-liittimen mallilla.

## Päätökset

- Lähteenä EU:n julkaisutoimiston Cellar (sisältöneuvottelu CELEX-numerolla ja SPARQL), koska se ei vaadi rekisteröitymistä. EUR-Lexin verkkosivut vastaavat automaattisille pyynnöille botintorjunnan haasteella (202), joten niitä ei käytetä. EUR-Lexin SOAP-palvelu vaatisi rekisteröitymisen.
- Cloudflare Worker, tilaton MCP (Streamable HTTP, JSON-vastaukset). Ei ajonaikaisia riippuvuuksia.
- Ei tallennusta. Välimuisti vain Cloudflaren Cache API:ssa ja isolaatin muistissa.
- Oletuksena uusin jo voimassa oleva konsolidoitu teksti; tulevat versiot merkitään näkyvästi.
- Asiakirja jäsennetään kerran hakemistoksi ja tallennetaan osina (ilmaistason 10 ms CPU-raja). Osien määrä on rajattu, koska jokainen tallennus on alipyyntö (enintään 50).
- Uudelleenkäytön ehdot: komission päätös 2011/833/EU (luettu Cellarista 31.10.2026): uudelleenkäyttö sallittu kaupallisesti ja ei-kaupallisesti maksutta (4 ja 9 artikla), ehtoina lähteen mainitseminen ja merkityksen vääristämättä jättäminen (6 artikla).

## Rakenne

- `src/index.js`: MCP-protokolla ja käyttörajoitus
- `src/tools.js`: työkalujen määrittelyt ja toteutus, version valinta, hakemiston osat
- `src/cellar.js`: säädösviitteen tulkinta, SPARQL-kyselyt, asiakirjan haku
- `src/doc.js`: XHTML/HTML-asiakirjan jäsennys kappaleiksi ja hakemistoksi (artiklat, johdanto-osa, liitteet, sisällysluettelo, muutosmerkintöjen selite)
- `src/http.js`: HTTP, Cache API ja isolaatin muistivälimuisti
- `src/xml.js`: pieni XML-jäsennin (sama kuin Finlex-liittimessä)
- `test/smoke.mjs`: savutesti oikeaa rajapintaa vasten

## Muutokset

- 31.10.2026 v1.0: hae_eu_saadoksia, eu_saados_tiedot, hae_eu_artikla, etsi_eu_saadoksesta.
- 31.10.2026 v1.0.1: säädöksen tunnistus, perustiedot ja versiot yhtenä välimuistimerkintänä; sisällysluettelo omana osanaan (vähemmän välimuistilukuja kutsua kohden, tuotannossa artiklahaku oli 7–12 ms).
