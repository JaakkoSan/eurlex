// Työkalujen määrittelyt yhteisen rungon tyokalu()-muodossa (koodiajo-valmius): logiikka on tools.js:n funktioissa,
// ja työkalu on ohut kuori niiden päällä. Kaikki työkalut vain lukevat (oikeus "luku").
//
// Hakulistat (hae_eu_saadoksia, hae_eu_tuomioita, hae_eu_ehdotuksia) antavat tekstin rinnalla rakenteisen tuloksen
// (structuredContent ja outputSchema) ja sivutuksen (sivu, sivuja, seuraava). hae_eu_artikla antaa sanatarkan tekstin
// tekstinä ja rakenteena vain tunnuksen, version ja Lähde-linkin. Muut työkalut antavat tekstin.

import { tyokalu, NaytettavaVirhe, LAHDE_SKEEMA, VIRHE_SKEEMA } from "./mcp-runko.js";
import {
  haeEuSaadoksia,
  haeEuSaadoksiaTeksti,
  euSaadosTiedot,
  haeEuArtikla,
  haeEuArtiklaTeksti,
  etsiEuSaadoksesta,
  haeEuTuomioita,
  haeEuTuomioitaTeksti,
  euTuomio,
  haeEuEhdotuksia,
  haeEuEhdotuksiaTeksti,
  euEhdotus,
  tuotevaroitukset,
  euLaiterekisteri,
  UserError,
  NotFoundError,
  SourceError,
  SOURCE_NAMES,
} from "./tools.js";

const common = {
  saados: {
    type: "string",
    description:
      "Säädös: numero (\"2016/679\", \"93/13/ETY\", \"asetus (EY) N:o 1907/2006\"), CELEX-numero (\"32016R0679\") tai ELI-osoite. Pelkällä numerolla anna myös tyyppi, jos sama numero on usealla säädöstyypillä.",
  },
  tyyppi: { type: "string", enum: ["asetus", "direktiivi", "paatos"], description: "Säädöstyyppi (valinnainen)." },
  kieli: { type: "string", enum: ["fi", "sv", "en"], description: "Kieliversio: fi (oletus), sv tai en." },
  versio: {
    type: "string",
    description:
      "Valinnainen. \"alkuperainen\" = EU:n virallisessa lehdessä julkaistu alkuperäinen teksti. Päivämäärä (VVVV-KK-PP) = konsolidoitu teksti sellaisena kuin se oli voimassa tuona päivänä. Oletus: uusin jo voimassa oleva konsolidoitu teksti.",
  },
};

// ---------- tulosskeemat ----------

const merkkijono = (description) => ({ type: "string", description });
const lista = (items, description) => ({ type: "array", items, description });

/** Sivutus: lähde ei kerro kokonaismäärää, joten sivuja on alaraja (sivu + 1, kun seuraava sivu on olemassa). */
const SIVUTUS = {
  sivu: { type: "integer", minimum: 1, description: "Tämän tuloksen sivu." },
  sivuja: { type: "integer", minimum: 1, description: "Vähintään näin monta sivua: sivu + 1, jos seuraava sivu on olemassa; tyhjällä liian suurella sivulla sivu - 1 (vähintään 1). Kokonaismäärää lähde ei kerro." },
  seuraava: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Seuraavan sivun numero (parametri sivu) tai null." },
};

/** Onnistunut tulos tai rakenteinen virhe { virhe }, jotta isError-tuloskin noudattaa outputSchemaa. */
const taiVirhe = (onnistunut) => ({
  type: "object",
  oneOf: [onnistunut, { type: "object", properties: { virhe: VIRHE_SKEEMA }, required: ["virhe"] }],
});

const SAADOS_RIVI = {
  type: "object",
  properties: {
    tunnus: merkkijono("Säädöksen tunnus, esim. \"asetus 2016/679\"."),
    celex: merkkijono("CELEX-numero."),
    paiva: merkkijono("Säädöksen päivä (VVVV-KK-PP)."),
    voimassa: { type: "boolean", description: "Onko säädös voimassa (puuttuu, jos tieto puuttuu lähteestä)." },
    nimi: merkkijono("Säädöksen nimi (enintään 400 merkkiä)."),
    linkki: merkkijono("Lähde-linkki EUR-Lexiin."),
  },
  required: ["tunnus", "celex", "nimi", "linkki"],
};

const TUOMIO_RIVI = {
  type: "object",
  properties: {
    asia: merkkijono("Asianumero, esim. \"C-311/18\"."),
    celex: merkkijono("CELEX-numero."),
    paiva: merkkijono("Ratkaisun päivä (VVVV-KK-PP)."),
    ecli: merkkijono("ECLI-tunnus."),
    otsikko: merkkijono("Tuomioistuin, päivä ja asianosaiset."),
    kuvaus: merkkijono("Asiasanat (enintään 300 merkkiä)."),
    tulkitut_kohdat: lista({ type: "string" }, "Tulkitut kohdat, esim. \"6 art. 1 kohta\" (julkaisutoimiston luokittelu; vain säädöshaussa)."),
    linkki: merkkijono("Lähde-linkki EUR-Lexiin."),
  },
  required: ["asia", "celex", "otsikko", "linkki"],
};

const EHDOTUS_RIVI = {
  type: "object",
  properties: {
    tunnus: merkkijono("COM-tunnus, esim. \"COM(2021) 206\"."),
    celex: merkkijono("CELEX-numero."),
    paiva: merkkijono("Ehdotuksen päivä (VVVV-KK-PP)."),
    menettelyt: lista({ type: "string" }, "Menettelytunnukset, esim. \"2021/0106(COD)\"."),
    tila: merkkijono("Menettelyn tila suomeksi."),
    tilakoodi: merkkijono("Julkaisutoimiston tilakoodi, esim. PROP_PENDING."),
    hyvaksytyt: lista(
      { type: "object", properties: { tunnus: { type: "string" }, celex: { type: "string" } }, required: ["tunnus", "celex"] },
      "Hyväksytyt säädökset.",
    ),
    nimi: merkkijono("Ehdotuksen nimi (enintään 400 merkkiä)."),
    linkki: merkkijono("Lähde-linkki EUR-Lexiin."),
  },
  required: ["tunnus", "celex", "menettelyt", "hyvaksytyt", "nimi", "linkki"],
};

// ---------- virheet ----------

/**
 * Liittimen virheet rungon NaytettavaVirhe-muotoon: syötteen virhe (syote), puuttuva tunnus tai osa (ei_loydy) ja lähteen
 * virhe tiloineen (lahde). Muut poikkeukset menevät rungolle, joka näyttää yleisen tekstin eikä kirjaa sisäistä tekstiä.
 */
function virheet(nimi, hae) {
  return async (args, env, ctx) => {
    try {
      return await hae(args ?? {}, env, ctx);
    } catch (e) {
      if (e instanceof NotFoundError) throw new NaytettavaVirhe(e.message, "ei_loydy");
      if (e instanceof UserError) throw new NaytettavaVirhe(e.message, "syote");
      if (e instanceof SourceError) {
        const lahdeNimi = SOURCE_NAMES[nimi] ?? "EU:n julkaisutoimiston rajapinta";
        throw new NaytettavaVirhe(`${lahdeNimi} ei vastannut (${e.message}). Yritä hetken päästä uudelleen.`, "lahde", {
          lahteen_koodi: e.status ? String(e.status) : undefined,
        });
      }
      throw e;
    }
  };
}

/** Lukeva työkalu; hae ja teksti erikseen. Ilman tulosSkeemaa tulos on pelkkä teksti. */
const luku = ({ nimi, hae, teksti = (t) => t, ...muut }) =>
  tyokalu({ nimi, oikeus: "luku", avoin: true, hae: virheet(nimi, hae), teksti, ...muut });

// ---------- työkalut ----------

export const TYOKALUT = [
  luku({
    nimi: "hae_eu_saadoksia",
    otsikko: "Hae EU-säädöksiä",
    kuvaus:
      "Hakee EU-säädöksiä (asetukset, direktiivit, päätökset) nimen sanoilla EU:n julkaisutoimiston tietokannasta (EUR-Lexin aineisto). Palauttaa tunnukset, CELEX-numerot, päivämäärät ja nimet uusimmasta vanhimpaan. Käytä sanan vartaloa, esim. \"tietosuoj\", \"lääkinnällis laittei\".",
    syote: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sanat, jotka säädöksen nimessä on oltava (kaikki). Vähintään 4 merkin sanat katkaistaan vartaloksi." },
        tyyppi: common.tyyppi,
        vain_voimassa: { type: "boolean", description: "Vain voimassa olevat (oletus true)." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        kieli: common.kieli,
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
      },
      required: ["hakusana"],
    },
    tulosSkeema: taiVirhe({
      type: "object",
      properties: { saadokset: lista(SAADOS_RIVI, "Säädökset uusimmasta vanhimpaan, enintään 10."), ...SIVUTUS, lahde: LAHDE_SKEEMA },
      required: ["saadokset", "sivu", "sivuja", "seuraava", "lahde"],
    }),
    hae: haeEuSaadoksia,
    teksti: haeEuSaadoksiaTeksti,
  }),
  luku({
    nimi: "eu_saados_tiedot",
    otsikko: "EU-säädöksen tiedot",
    kuvaus:
      "Palauttaa EU-säädöksen tiedot: nimi, CELEX- ja ELI-tunnus, antopäivä, voimaantulo- ja soveltamispäivät, voimassaolo, konsolidoidut versiot (myös tulevat), muuttavat ja kumoavat säädökset sekä sisällysluettelo (luvut, artiklat ja liitteet).",
    syote: {
      type: "object",
      properties: { saados: common.saados, tyyppi: common.tyyppi, versio: common.versio, kieli: common.kieli },
      required: ["saados"],
    },
    hae: euSaadosTiedot,
  }),
  luku({
    nimi: "hae_eu_artikla",
    otsikko: "Hae EU-säädöksen artikla",
    kuvaus:
      "Palauttaa EU-säädöksen artiklan, johdanto-osan perustelukappaleen tai liitteen sanatarkan tekstin. Oletuksena uusin voimassa oleva konsolidoitu teksti; johdanto-osan perustelukappaleet ovat vain alkuperäisessä tekstissä. Anna yksi: artikla, johdanto_kappale tai liite.",
    syote: {
      type: "object",
      properties: {
        saados: common.saados,
        tyyppi: common.tyyppi,
        artikla: { type: "string", description: "Artiklan numero, esim. \"6\" tai \"10 a\"." },
        johdanto_kappale: { type: "string", description: "Johdanto-osan perustelukappaleen numero, esim. \"47\"." },
        liite: { type: "string", description: "Liitteen numero, esim. \"I\" tai \"XVI\". Jos liitteitä on yksi, \"1\"." },
        versio: common.versio,
        kieli: common.kieli,
      },
      required: ["saados"],
    },
    // Sanatarkka teksti on vain tekstinä; rakenteessa tunnus, versio ja Lähde-linkki.
    tulosSkeema: taiVirhe({
      type: "object",
      properties: {
        saados: {
          type: "object",
          properties: {
            tunnus: merkkijono("Säädöksen tai ehdotuksen tunnus, esim. \"asetus 2016/679\" tai \"COM(2021) 206\"."),
            celex: merkkijono("Säädöksen CELEX-numero."),
            nimi: merkkijono("Säädöksen nimi (enintään 400 merkkiä)."),
            voimassa: { type: "boolean", description: "Onko säädös voimassa (puuttuu, jos tieto puuttuu lähteestä)." },
          },
          required: ["tunnus", "celex"],
        },
        versio: {
          type: "object",
          properties: {
            laji: { type: "string", enum: ["konsolidoitu", "alkuperainen", "ehdotus"], description: "Tekstin laji." },
            celex: merkkijono("Näytetyn tekstin CELEX-numero (konsolidoidulla versiolla oma)."),
            paiva: merkkijono("Konsolidoidun version päivä (VVVV-KK-PP)."),
            tulevat: lista({ type: "string" }, "Tulevien konsolidoitujen versioiden päivät (HUOM-merkintä tekstissä)."),
          },
          required: ["laji", "celex"],
        },
        osa: {
          type: "object",
          properties: {
            laji: { type: "string", enum: ["artikla", "johdanto_kappale", "liite"] },
            numero: { type: "string" },
          },
          required: ["laji", "numero"],
        },
        kieli: { type: "string", enum: ["fi", "sv", "en"] },
        lahde: LAHDE_SKEEMA,
      },
      required: ["saados", "versio", "osa", "kieli", "lahde"],
    }),
    poisRakenteesta: ["teksti"],
    hae: haeEuArtikla,
    teksti: haeEuArtiklaTeksti,
  }),
  luku({
    nimi: "etsi_eu_saadoksesta",
    otsikko: "Etsi EU-säädöksen tekstistä",
    kuvaus:
      "Etsii yhden EU-säädöksen tekstistä sanaa tai sanontaa ja palauttaa osumat artikloittain (sekä johdanto-osan perustelukappaleet ja liitteet) lyhyine otteineen. Haku on kirjaimellinen: käytä sanan vartaloa.",
    syote: {
      type: "object",
      properties: {
        saados: common.saados,
        tyyppi: common.tyyppi,
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä)." },
        versio: common.versio,
        kieli: common.kieli,
      },
      required: ["saados", "hakusana"],
    },
    hae: etsiEuSaadoksesta,
  }),
  luku({
    nimi: "hae_eu_tuomioita",
    otsikko: "Hae EU-tuomioita",
    kuvaus:
      "Hakee EU-tuomioistuimen ja unionin yleisen tuomioistuimen tuomioita: joko tuomiot, jotka tulkitsevat tiettyä säädöstä tai sen artiklaa (esim. tietosuoja-asetuksen 6 artikla), tai haku otsikon sanoilla (otsikossa ovat asianosaiset ja usein asiasanat). Palauttaa asianumerot, päivämäärät, ECLI-tunnukset ja tulkitut kohdat uusimmasta vanhimpaan.",
    syote: {
      type: "object",
      properties: {
        saados: { ...common.saados, description: "Säädös, jota tuomiot tulkitsevat (kuten muissa työkaluissa). Valinnainen, jos hakusana annetaan." },
        tyyppi: common.tyyppi,
        artikla: { type: "string", description: "Artikla, jota tuomiot tulkitsevat, esim. \"6\". Vaatii säädöksen." },
        hakusana: { type: "string", description: "Sanat tuomion otsikosta, esim. asianosainen (\"Schrems\") tai aihe (\"henkilötietojen\")." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        kieli: common.kieli,
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
      },
    },
    tulosSkeema: taiVirhe({
      type: "object",
      properties: {
        haku: {
          type: "object",
          description: "Haun peruste: säädös (ja artikla) tai hakusana.",
          properties: {
            saados: merkkijono("Tulkittavan säädöksen tunnus."),
            celex: merkkijono("Tulkittavan säädöksen CELEX-numero."),
            artikla: merkkijono("Tulkittava artikla."),
            hakusana: merkkijono("Hakusana."),
          },
        },
        tuomiot: lista(TUOMIO_RIVI, "Tuomiot uusimmasta vanhimpaan, enintään 10."),
        ...SIVUTUS,
        lahde: LAHDE_SKEEMA,
      },
      required: ["haku", "tuomiot", "sivu", "sivuja", "seuraava", "lahde"],
    }),
    hae: haeEuTuomioita,
    teksti: haeEuTuomioitaTeksti,
  }),
  luku({
    nimi: "eu_tuomio",
    otsikko: "EU-tuomio",
    kuvaus:
      "Palauttaa EU-tuomioistuimen tuomion: asianosaiset, päivämäärä, ECLI, tulkitut säännökset ja tuomiolauselma (ratkaisu). Parametrilla kohdat tuomion perustelujen numeroidut kohdat (esim. \"94-105\"), parametrilla hakusana osumat kohtineen.",
    syote: {
      type: "object",
      properties: {
        tuomio: { type: "string", description: "Asianumero (\"C-311/18\", \"T-604/18\"), CELEX-numero (\"62018CJ0311\") tai ECLI-tunnus." },
        kohdat: { type: "string", description: "Numeroidut kohdat, esim. \"94-105\" tai \"134, 168-170\". Enintään 60 kohtaa kerralla. Valinnainen." },
        hakusana: { type: "string", description: "Etsittävä merkkijono tuomion tekstistä. Valinnainen." },
        kieli: common.kieli,
      },
      required: ["tuomio"],
    },
    hae: euTuomio,
  }),
  luku({
    nimi: "tuotevaroitukset",
    otsikko: "EU:n tuotevaroitukset (Safety Gate)",
    kuvaus:
      "Hakee EU:n Safety Gate -järjestelmän hälytyksiä vaarallisista kulutustuotteista (ei elintarvikkeet eikä lääkkeet) viikkoraporteista suomeksi: tuote, merkki, malli, viivakoodi, vaara, riskitaso, toimenpiteet (myynnistä poisto, takaisinveto) ja ilmoittajamaa. Esim. kosmetiikka, lelut, sähkölaitteet. Uusin ensin.",
    syote: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana tai merkkijono, jota etsitään tuotteesta, merkistä, nimestä, mallista, kuvauksesta, vaarasta ja viivakoodista, esim. \"TPO\", \"geelilakka\", merkin nimi tai EAN-koodi. Valinnainen." },
        kategoria: { type: "string", description: "Tuoteluokka suomeksi tai sen osa, esim. \"kosmetiikka\", \"lelut\", \"sähkölaitteet\". Valinnainen." },
        maa: { type: "string", description: "Ilmoittajamaa suomeksi, esim. \"Suomi\", \"Ruotsi\". Valinnainen." },
        viikkoja: { type: "integer", description: "Montako viimeisintä viikkoraporttia käydään läpi (oletus 8, enintään 52)." },
      },
    },
    hae: tuotevaroitukset,
  }),
  luku({
    nimi: "eu_laiterekisteri",
    otsikko: "EU:n lääkinnällisten laitteiden rekisteri (EUDAMED)",
    kuvaus:
      "Hakee EU:n lääkinnällisten laitteiden tietokannasta (EUDAMED) laitteen tai toimijan tiedot: riskiluokka, sovellettava säädös (MDR, IVDR tai vanha direktiivi), markkinatila, valmistaja ja sen SRN-tunnus. Hakutavat: udi_di (pakkauksen UDI-DI), basic_udi, srn (toimijan tunnus, esim. FI-MF-000006499; antaa myös laitteet) tai valmistaja + maa (nimen osa). Laitteen nimellä ei voi hakea ilman toimijaa.",
    syote: {
      type: "object",
      properties: {
        udi_di: { type: "string", description: "Laitteen ensisijainen UDI-DI (esim. pakkauksen GTIN-koodi). Valinnainen." },
        basic_udi: { type: "string", description: "Basic UDI-DI. Valinnainen." },
        srn: { type: "string", description: "Toimijan yksilöllinen rekisterinumero (SRN), esim. FI-MF-000006499. Valinnainen." },
        laite: { type: "string", description: "Rajaa srn-haun laitteet nimen, mallin tai tuotenumeron osalla. Valinnainen." },
        valmistaja: { type: "string", description: "Toimijan nimen osa (valmistaja, maahantuoja tai valtuutettu edustaja). Käytä maa-parametrin kanssa." },
        maa: { type: "string", description: "Toimijan maa suomeksi tai ISO-koodina, esim. \"Suomi\", \"SE\" (oletus Suomi)." },
      },
    },
    hae: euLaiterekisteri,
  }),
  luku({
    nimi: "hae_eu_ehdotuksia",
    otsikko: "Hae komission säädösehdotuksia",
    kuvaus:
      "Hakee Euroopan komission säädösehdotuksia (COM-asiakirjat: ehdotukset asetuksiksi, direktiiveiksi ja päätöksiksi) nimen sanoilla, vuosilla ja tilalla (vireillä tai hyväksytty). Palauttaa COM-tunnuksen, päivän, menettelytunnuksen (esim. 2021/0106(COD)), tilan ja hyväksytyn säädöksen.",
    syote: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sanat, jotka ehdotuksen nimessä on oltava. Vähintään 4 merkin sanat katkaistaan vartaloksi, esim. \"kosmeettis\", \"lääkinnällis laittei\"." },
        tila: { type: "string", enum: ["vireilla", "hyvaksytty"], description: "vireilla = käsittely kesken, hyvaksytty = säädös annettu. Valinnainen." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        kieli: common.kieli,
        sivu: { type: "integer", description: "Tulossivu (10 ehdotusta sivulla)." },
      },
    },
    tulosSkeema: taiVirhe({
      type: "object",
      properties: { ehdotukset: lista(EHDOTUS_RIVI, "Ehdotukset uusimmasta vanhimpaan, enintään 10."), ...SIVUTUS, lahde: LAHDE_SKEEMA },
      required: ["ehdotukset", "sivu", "sivuja", "seuraava", "lahde"],
    }),
    hae: haeEuEhdotuksia,
    teksti: haeEuEhdotuksiaTeksti,
  }),
  luku({
    nimi: "eu_ehdotus",
    otsikko: "Komission säädösehdotus",
    kuvaus:
      "Palauttaa komission säädösehdotuksen tiedot: nimi, COM-tunnus, antopäivä, valmistellut pääosasto, menettely ja sen tyyppi, tila, hyväksytty säädös, säädökset joita ehdotus muuttaisi, sekä käsittelyn vaiheet päivämäärineen (komissio, Euroopan parlamentti, neuvosto, lausunnot). Ehdotuksen artiklat saa hae_eu_artikla-työkalulla COM-tunnuksella.",
    syote: {
      type: "object",
      properties: {
        ehdotus: { type: "string", description: "COM-tunnus (\"COM(2021) 206\") tai CELEX-numero (\"52021PC0206\")." },
        kaikki_vaiheet: { type: "boolean", description: "true = jokainen vaihe erikseen (oletus: peräkkäiset samanlaiset vaiheet tiivistetään)." },
        kieli: common.kieli,
      },
      required: ["ehdotus"],
    },
    hae: euEhdotus,
  }),
];
