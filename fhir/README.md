# AfterRain on the OneAquaHealth FHIR Implementation Guide

Every AfterRain number (a river sample, a site, a cohort's risk, the dataset, an alert) is stored as a FHIR R4 resource on the profiles of the OneAquaHealth FHIR Implementation Guide (`hl7.eu.fhir.oah`, source `github.com/hl7-eu/oah`). The HL7 validator checks every resource against that guide on each build, and a build with any validation error fails.

One command rebuilds everything from `sayr/data/out`:

```
npm ci            # SUSHI 3.20.1, pinned
npm run fhir      # builds, validates, then exports AfterRain resources to served/
npm run fhir:test # pytest: re-runs the validator and checks the values against data/out
npm run fhir:serve            # read-only FHIR surface on http://127.0.0.1:8777/
npm run fhir:examples         # validate the guide's own examples against the guide
```

Requirements: Python 3.13, Node 22.12+, Java 17+ and `validator_cli.jar` ([releases](https://github.com/hapifhir/org.hl7.fhir.core/releases)). Point the build at Java and the validator with `FHIR_JAVA` and `FHIR_VALIDATOR_JAR`, or with a `tools.local.json` file (`{"java": "...", "validator": "..."}`). The build keeps its FHIR package cache in `build/fhir-home`, so it never touches `~/.fhir`.

## What the build does

1. Fetches `hl7-eu/oah` at commit `b907cf08` into `ig-src/` and builds it with SUSHI. The repository states no licence, so its content is fetched at build time and never committed here.
2. Packages the guide as `hl7.eu.fhir.oah#0.1.0-ci-build` (conformance resources, with its examples under `package/example`).
3. Generates AfterRain's instances in FSH from `sayr/data/out` (`sayr-ig/input/fsh/generated/`); a missing file or field stops the build.
4. Builds the AfterRain FSH project (`sayr-ig/`, which depends on the guide) with SUSHI, then adds a generated narrative to every resource.
5. Writes the static FHIR surface (`fhir-static/`) and the transaction Bundles.
6. Runs the HL7 validator on every AfterRain resource, the transaction Bundle and the CapabilityStatement, and fails on any error.

## Resource map

| AfterRain object | Profile | Built from |
|---|---|---|
| Warleigh Weir, the 106 OneAquaHealth research sites, the five cities, Pech David on the Garonne | `LocationOah` | `replay_2024-09-23.json`, `city_*.json` |
| Each Warleigh water sample | `SpecimenOah` (collector: a Wessex Water `PractitionerRole`) | `warleigh_backtest.json` |
| Each Warleigh E. coli result | `ObservationIndicatorsOah` | `warleigh_backtest.json` |
| Children paddling, adult swimmers, dog owners | `GroupOah` | cohort definitions |
| Risk for a cohort at Warleigh Weir at each replay sample | `ObservationHealthMeasureOah` (subject `LocationOah`, focus `GroupOah`) | `warleigh_backtest.json` model probabilities |
| Risk for dog owners at each of the 106 OneAquaHealth sites: the highest chance over the forecast, its hour and its fog (id `oah-risk-dog-owners-<site code>`) | `ObservationHealthMeasureOah` (subject `LocationOah` `oah-site-<site code>`, focus `GroupOah`), with the city model as a `Device` (`afterrain-model-city`) | `nowcast_<city>.json`, `city_model.json` |
| The Warleigh backtest dataset | `LibraryOah` (`size`, `numberOfRecords`), with the file as a `Binary` | `warleigh_backtest.json` |
| The alert | `AlertOah` (proposed, on `Communication`) and a `Subscription` | `replay_2024-09-23.json`, `warleigh_backtest.json` |

**Coding.**
- The guide's non-health indicator value set has no E. coli concept, only `#coliforms`; its `#escherichia-coli` code means "% of people with E. coli" (a health indicator). The binding is `preferred`, so each result carries both the guide's `#coliforms` and LOINC `87317-4` "Escherichia coli [#/volume] in Water by Viability count" (active in LOINC 2.82).
- The unit is UCUM `/(100.mL)`. The plain form `/100.mL` parses in UCUM as a hundredth of a millilitre.
- Over 900 per 100 mL is a single-sample flag. Each result's reference range says so, and says that the EU Bathing Water Directive applies 900 to the 90th percentile of a season's samples.

**Risk estimates.**
- Each value is the probability that a single sample is over 900 E. coli per 100 mL. At Warleigh Weir it comes from the Warleigh model.
- At a OneAquaHealth site it comes from the city model and the rain forecast: the highest, over the forecast hours, of the median over the ensemble members. `effectiveDateTime` is the first hour at that value, in the city's local time. A `component` coded `AfterRainCs#fog` carries the fog at that hour. The method text names the model version (also on the `Device`), and a note gives the forecast fetch time, the forecast hours and AfterRain's state at the peak hour. One resource per site, for dog owners, since the profile does not require a cohort. The resources are rebuilt from the nowcast on each `npm run fhir`.
- For a 2024 sample, the model was fitted on 2021-2023 with 2024 held out. `Observation.device` names that model and its version.
- The `workflow-supportingInfo` extension points each estimate at the dataset `Library` it came from.
- The model has no cohort-specific term. The cohort is the group the estimate is addressed to.

**AfterRain's own terms.** Concepts that no code system carries (the exceedance probability, water-contact activities, alert reasons) are in `AfterRainCs`. They are written as proposed additions to the guide's temporary code system.

## The alert: why Communication

1. DetectedIssue records a clinical problem with an action for one patient (`patient: Reference(Patient)`). It cannot address a cohort or a place, and it has no validity window.
2. Communication is FHIR's record of information sent. Its category code system has `alert`, and its subject accepts a Group, so a `GroupOah` cohort is the addressee.
3. `about` carries the `LocationOah`. `reasonReference` carries the `ObservationHealthMeasureOah` and the `ObservationIndicatorsOah` results that justify the alert, and `reasonCode` names the signal.
4. The one missing element is "until": a single extension, `AlertValidityPeriod`. Everything else is core R4.
5. Delivery is a `Subscription` on `Communication?category=alert&subject=Group/<cohort>`.

`AlertOah` is a proposal, flagged as such in its FSH, title and description (`sayr-ig/input/fsh/alert-oah.fsh`).

The instance is issued at the first Warleigh sample after the 31,000 peak that was taken while the Freshford storm tank was not spilling. Its "until" is the latest logged spill stop plus the backtest's 48-hour window, the rule behind "43 of 44 samples over 900 after a Freshford spill".

## The static FHIR surface

`fhir-static/` is a read-only FHIR REST surface that any static host can serve:

- `metadata` (and `metadata.json`): the CapabilityStatement. It lists every resource type, its profiles, `read`, and the search parameters with the values that are precomputed.
- `<Type>/<id>.json`: every resource. That is the guide's 504, including its 468 examples, and all of AfterRain's.
- `_search/index.json` maps each supported query to a precomputed searchset Bundle in `_search/<Type>/`. The queries are:
  - `Location?identifier=` for every Location identifier, with and without the system;
  - `Observation?subject=Location/<id>` for every location that has observations;
  - `Observation?focus=Group/<cohort>`;
  - `Library?description=Benevento`;
  - `Library?_id=Library-Benevento-All,warleigh-backtest` (a guide example next to AfterRain's dataset);
  - `Communication?category=alert` and `Communication?subject=Group/cohort-dog-owners`.
- Search results follow FHIR R4 semantics. For example, string search matches the start of the text, so `Library?description=Benevento` returns the 12 per-site libraries. `Library-Benevento-All` is not among them, because its description starts with "Consolidated".
- `_bundles/oah-transaction.json` and `_bundles/sayr-transaction.json` are the transaction Bundles (PUT by id) that load the same content into a real server.

`python -m sayr_fhir serve` serves the tree with FHIR paths (`/metadata`, `/Location/warleigh-weir`, `/Library?description=Benevento`). An unsupported query returns 404 with an OperationOutcome.

## Loading the same content into a real server (HAPI FHIR JPA starter, Java 17)

```
git clone --depth 1 --branch image/v8.12.0-1 https://github.com/hapifhir/hapi-fhir-jpaserver-starter
cd hapi-fhir-jpaserver-starter
mvn -B clean package spring-boot:repackage -DskipTests=true -Pboot
java -jar target/ROOT.war                      # FHIR R4 at http://localhost:8080/fhir (in-memory H2)

# in sayr/fhir, after `npm run fhir`:
curl -X POST -H "Content-Type: application/fhir+json" --data-binary @fhir-static/_bundles/oah-transaction.json  http://localhost:8080/fhir
curl -X POST -H "Content-Type: application/fhir+json" --data-binary @fhir-static/_bundles/sayr-transaction.json http://localhost:8080/fhir
curl "http://localhost:8080/fhir/Library?description=Benevento"
curl "http://localhost:8080/fhir/Observation?subject=Location/warleigh-weir&_count=5"
```

## Licences

- AfterRain's code: MIT.
- The generated resources keep the licences of their data (`../data/LICENSE-DATA.md`): Wessex Water CC BY 4.0, Environment Agency OGL v3.0, Hub'Eau Licence Ouverte 2.0.
- OneAquaHealth API site data carries no stated licence.
- The OneAquaHealth guide carries no stated licence. It is fetched at build time, and `fhir-static/` (which contains the guide's examples) is git-ignored.
