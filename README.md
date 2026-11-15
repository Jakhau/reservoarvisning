# Reservoarvisning

3D-visning av ferdige reservoarmodeller rett i nettleseren. Ingen installasjon, ingen
opplasting: filene leses lokalt i nettleseren din og sendes ikke noe sted.

**Prøv den:** https://jakhau.github.io/reservoarvisning/ – trykk «Åpne Norne-feltet» for å
hente en ekte modell fra OPMs åpne datasett.

## Hva den kan

- **Lese modeller** i Eclipse/OPM-formatene: GRDECL og DATA med INCLUDE-filer, eller binære
  EGRID, INIT, UNRST, SMSPEC/UNSMRY og RFT. FIELD- og LAB-enheter regnes om til SI.
- **3D-celler, tverrsnitt og kart** (lagsnitt, sum og tykkelse) med utsnitt i I, J og K.
- **Tid:** tidslinje med avspilling, og endring mellom to tidssteg.
- **Filtre og kalkulator:** flere egenskapsfiltre samtidig, og egne egenskaper som
  `1 - SWAT - SGAS` eller `hvis(PORO > 0.2, PERMX * DZ, 0)`.
- **Volum:** bulk, porevolum og HCPV (olje og gass) for utsnittet, fordelt på lag eller region.
- **Brønner og forkastninger:** brønnbaner, perforasjoner (åpne/stengte over tid), importerte
  baner, forkastningsflater farget etter sprang.
- **Produksjonskurver** per brønn eller felt, simulert mot historisk, koblet til tidslinjen.
  Egne vektorer, sammenligning av to brønner og RFT-trykk mot dyp.
- **Sammenligning:** to modeller side om side med låst kamera, og differansen mellom dem.
- **Deling:** lagrede visninger, delbar lenke, bildeeksport og tastatursnarveier (trykk `?`).

## Kjøre lokalt

Appen er en statisk side uten byggesteg. Start en lokal nettjener i mappen og åpne siden:

```bash
python -m http.server 8770
```

Åpne deretter http://localhost:8770/.

## Tester

Regnekjernen (lesing, geometri, volum, snitt, kalkulator) testes med Node:

```bash
cd src && node tests.js
```

Det som bare kan prøves i en nettleser, har egne røyktester. Start nettjeneren og åpne
http://localhost:8770/src/nettlesertest.html.

Noen tester bruker åpne datasett fra OPM og hoppes over når filene ikke ligger i `data/`
(mappen er ikke med i repoet).

## Oppbygning

| Fil | Innhold |
|---|---|
| `index.html` | Siden, stiler og fargetokens for lyst og mørkt tema |
| `src/app.js` | Grensesnitt og 3D-tegning (three.js) |
| `src/kurver.js` | Kurvepanelet |
| `src/worker.js` | Bakgrunnstråd som holder modellen og gjør alt tungt arbeid |
| `src/grid.js` | Regnekjernen: hjørnepunktgeometri, synlige flater, volum, snitt, kalkulator |
| `src/grdecl.js` | Leser tekstformatene (GRDECL/DATA) |
| `src/eclbin.js` | Leser de binære resultatformatene |
| `src/vendor/` | three.js r128 og OrbitControls |

## Data og kilder

- Norne-modellen og de andre testdatasettene kommer fra
  [OPM/opm-tests](https://github.com/OPM/opm-tests) og
  [OPM/opm-data](https://github.com/OPM/opm-data), publisert under Open Database License.
- Prosjektet bruker bare åpne data og publisert litteratur. Formler i koden har kildehenvisning
  eller en test.

## Lisens

Koden er lisensiert under [MIT-lisensen](LICENSE). three.js i `src/vendor/` har sin egen
MIT-lisens, og datasettene fra OPM har Open Database License.
