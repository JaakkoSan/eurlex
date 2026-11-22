# Jono: eurlex-mcp

Liittimen jono (työtapa: keskusrepon docs/liittimien-tyotapa-2026-11-22.md). Valmis kohta poistetaan ja kirjataan MUUTOSLOKI.md:hen samassa commitissa.

## Työn alla

1. **1.3.1: odottamattoman virheen teksti piiloon (PR #2, haara virheteksti-piiloon-2; korvaa PR #1).**
   Lähde: https://github.com/JaakkoSan/eurlex/pull/2 ja issue JaakkoSan/liittimet#11 (pääsessio 22.11.2026: "Koodi kunnossa"; repon historia on oikein ja tunnus on `eurlex-mcp <noreply@eurlex-mcp.invalid>`). Linjaus: sisäinen virheteksti voi sisältää rajapintojen tai salaisuuksien tietoja, joten käyttäjälle näytetään vain "Haku epäonnistui. Yritä hetken päästä uudelleen."
   Valmis, kun: pääsessio on yhdistänyt ja julkaissut (push mainiin, Workers Builds), `node savutesti.mjs eurlex` keskusreposta antaa 0 virhettä, PR #1 on suljettu viittauksella #2:een ja issue liittimet#11 on suljettu.

## Seuraavaksi

2. **Koodiajo-valmius: eurlex yhteiseen runkoon, hakulistat rakenteisiksi.**
   Lähde: keskusrepon TILANNE.md, Jono, kohta 15 ("Aloitetaan, kun ajanvaraus, allekirjoitus ja soklo.online ovat myyntikunnossa."); keskusrepon CLAUDE.md, Koodiajo-valmius; kysymys issue JaakkoSan/liittimet#22 on avoin. Suunnitelma: suunnitelmat/2026-11-22-koodiajo-tila-liittimittain.md luku 4 (eurlex ennen finlexiä; hakulistat rakenteisiksi, sanatarkka teksti pysyy tekstinä; sivutus `sivu` kolmessa hakutyökalussa).
   Valmis, kun: pääsessio on vastannut issueen #22 ja sallinut aloituksen; sen jälkeen eurlexin siirto runkoon on yhdistetty ja julkaistu ja savutesti antaa 0 virhettä.

## Myöhemmin

- **Anthropicin liitinhakemiston hakemus (finlex, eurlex, Aluetieto).** Lähde: keskusrepon TILANNE.md, Jono, kohta 9, ja CLAUDE.md, Liitinten tuotteistus ("Hakemistot (finlex, eurlex, Aluetieto) ovat Jaakon päätös, avoin."). Suunnitelma suunnitelmat/liitinhakemisto.md. Jaakon päätös.

## Hylätty

(tyhjä)
