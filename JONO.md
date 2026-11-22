# Jono: eurlex-mcp

Liittimen jono (työtapa: keskusrepon docs/liittimien-tyotapa-2026-11-22.md). Valmis kohta poistetaan ja kirjataan MUUTOSLOKI.md:hen samassa commitissa.

## Työn alla

1. **1.3.1: odottamattoman virheen teksti piiloon (PR #2, haara virheteksti-piiloon-2; korvaa PR #1).**
   Lähde: https://github.com/JaakkoSan/eurlex/pull/2 (korvaa PR #1:n). Linjaus: sisäinen virheteksti voi sisältää rajapintojen tai salaisuuksien tietoja, joten käyttäjälle näytetään vain "Haku epäonnistui. Yritä hetken päästä uudelleen."
   Valmis, kun: PR #2 on yhdistetty ja julkaistu (push mainiin, Workers Builds), `node savutesti.mjs eurlex` keskusreposta antaa 0 virhettä ja PR #1 on suljettu viittauksella #2:een.

## Seuraavaksi

2. **Koodiajo-valmius: eurlex yhteiseen runkoon, hakulistat rakenteisiksi.**
   Eurlex ennen finlexiä; hakulistat rakenteisiksi, sanatarkka teksti pysyy tekstinä; sivutus `sivu` kolmessa hakutyökalussa. Perustelut ja aloitusehto keskusrepon JONO.md:ssä.
   Valmis, kun: aloitus on sallittu ja eurlexin siirto yhteiseen runkoon on yhdistetty ja julkaistu ja savutesti antaa 0 virhettä.

## Myöhemmin

- **Anthropicin liitinhakemiston hakemus (finlex, eurlex, Aluetieto).** Perustelut keskusrepon JONO.md:ssä.

## Hylätty

(tyhjä)
