"""Turn Sayr's real outputs (sayr/data/out) into FSH instances on the OneAquaHealth profiles.

Every value comes from a file in data/out; a missing file or field stops the build with its name.
"""
from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from zoneinfo import ZoneInfo

from . import config as C

CITIES = ["BE", "CO", "GH", "OS", "TO"]
ANCHOR = "FRESHFORD STORM TANK"      # the storm tank the Warleigh model names (model_warleigh.json inputs)
LONDON = ZoneInfo("Europe/London")
SID = f"{C.CANONICAL}/sid"
# Sandre's identifier space for surface-water stations, as given by Hub'Eau's uri_station field.
SANDRE_STATION = "https://id.eaufrance.fr/StationMesureEauxSurface"
PECH_DAVID_DESCRIPTION = "River-quality monitoring station with E. coli samples in Naiades (Hub'Eau)."
LOINC_ECOLI_WATER = ("87317-4", "Escherichia coli [#/volume] in Water by Viability count")
COHORTS = [
    # id, name, activity code, activity display, age range (low, high) in years or None
    ("cohort-children-paddling", "Children paddling", "paddling", "Paddling", (0, 17)),
    ("cohort-adult-swimmers", "Adult swimmers", "swimming", "Swimming", (18, None)),
    ("cohort-dog-owners", "Dog owners", "dog-in-water", "Dog enters the water", None),
]
RULE_REASON = {"freshford": ("storm-tank-spill", "Named upstream storm tank spilled"),
               "any_upstream": ("upstream-overflow-spill", "Upstream overflow spilled"),
               "rain": ("heavy-rain", "Rain of 10 mm or more"),
               "flow": ("high-river-flow", "River flow of 15 m3/s or more")}


def load(name: str) -> dict:
    p = C.DATA_OUT / name
    if not p.exists():
        raise SystemExit(f"missing input {p}: run `python -m pipeline build` in {C.SAYR_DIR}")
    return json.loads(p.read_text(encoding="utf-8"))


def need(d: dict, key: str, where: str):
    if key not in d or d[key] is None:
        raise SystemExit(f"missing field '{key}' in {where}")
    return d[key]


# ---- FSH writing helpers -------------------------------------------------------------------------------

def s(text: str) -> str:
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"') + '"'


def dec(x: float | int) -> str:
    d = Decimal(repr(float(x)))
    if d == d.to_integral_value():
        return str(int(d))
    return format(d.normalize(), "f")


def utc(t: str) -> dt.datetime:
    return dt.datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def local_iso(t: dt.datetime) -> str:
    """FHIR dateTime in Europe/London wall time with its offset, as Wessex publishes it."""
    return t.astimezone(LONDON).isoformat(timespec="seconds")


def stamp(t: dt.datetime) -> str:
    return t.strftime("%Y%m%dT%H%MZ")


def instance(name: str, profile: str, title: str, description: str, rules: list[str]) -> str:
    head = [f"Instance: {name}", f"InstanceOf: {profile}", f"Title: {s(title)}", f"Description: {s(description)}",
            "Usage: #example"]
    return "\n".join(head + rules) + "\n"


# ---- Locations ------------------------------------------------------------------------------------------

def locations() -> tuple[list[str], dict]:
    out, facts = [], {"oah_sites": 0, "cities": 0}
    for cid in CITIES:
        pack = load(f"city_{cid}.json")
        city = need(pack, "city", f"city_{cid}.json")
        cname = need(city, "name", f"city_{cid}.json city")
        out.append(instance(
            f"oah-city-{cid}", "LocationOah", f"Location - {cname} (OneAquaHealth city)",
            f"OneAquaHealth research city {cname}; parent of its research sites.",
            [f"* identifier[0].system = {s(SID + '/oah-city')}", f"* identifier[0].value = {s(cid)}",
             f"* name = {s(cname)}", "* mode = #instance", '* type = $sct#288520005 "City environment"',
             f"* position.latitude = {dec(need(city, 'latitude', cid))}",
             f"* position.longitude = {dec(need(city, 'longitude', cid))}"]))
        facts["cities"] += 1
        for site in need(pack, "sites", f"city_{cid}.json"):
            code = need(site, "code", f"city_{cid}.json site")
            name = need(site, "name", code).strip()
            desc = f"OneAquaHealth research site {code} in {cname}."
            if not name:   # LocationOah requires a name; the API gives none for a few sites
                name, desc = f"OneAquaHealth site {code}", desc + " The OneAquaHealth API gives no name for this site."
                facts.setdefault("unnamed_sites", []).append(code)
            rules = [f"* identifier[0].system = {s(SID + '/oah-site-code')}", f"* identifier[0].value = {s(code)}",
                     '* identifier[0].assigner.display = "OneAquaHealth"',
                     f"* name = {s(name)}", f"* description = {s(desc)}",
                     "* mode = #instance", '* type = $sct#420531007 "River"',
                     f"* position.latitude = {dec(need(site, 'lat', code))}",
                     f"* position.longitude = {dec(need(site, 'lon', code))}"]
            if site.get("altitude") is not None:
                rules.append(f"* position.altitude = {dec(site['altitude'])}")
            rules.append(f"* partOf = Reference(oah-city-{cid})")
            out.append(instance(f"oah-site-{code}", "LocationOah", f"Location - OneAquaHealth site {code}",
                                f"OneAquaHealth research site {code} ({name}), {cname}.", rules))
            facts["oah_sites"] += 1
        if cid == "TO":
            st = need(need(pack, "wet_weather_evidence", "city_TO.json"), "station", "wet_weather_evidence")
            code = need(st, "code", "Pech David station")
            out.append(instance(
                f"hubeau-station-{code}", "LocationOah", f"Location - {st['name'].title()} on the {st['river']}",
                f"Hub'Eau river-quality station {code} ({st['name'].title()}) on the {st['river']} in Toulouse.",
                [f"* identifier[0].system = {s(SANDRE_STATION)}", f"* identifier[0].value = {s(code)}",
                 '* identifier[0].assigner.display = "Sandre / Hub\'Eau (eaufrance)"',
                 f"* name = {s(st['name'].title() + ', ' + st['river'])}",
                 f"* description = {s(PECH_DAVID_DESCRIPTION)}",
                 "* mode = #instance", '* type = $sct#420531007 "River"',
                 f"* position.latitude = {dec(need(st, 'lat', code))}", f"* position.longitude = {dec(need(st, 'lon', code))}",
                 f"* partOf = Reference(oah-city-{cid})"]))
            facts["pech_david"] = f"hubeau-station-{code}"
    replay = load("replay_2024-09-23.json")
    site = need(replay, "site", "replay_2024-09-23.json")
    out.append(instance(
        "warleigh-weir", "LocationOah", "Location - Warleigh Weir, River Avon",
        "Wessex Water's E. coli sampling point at Warleigh Weir on the River Avon near Bath: Sayr's proof river.",
        [f"* identifier[0].system = {s(SID + '/site')}", '* identifier[0].value = "warleigh-weir"',
         f"* name = {s(need(site, 'name', 'replay site'))}",
         '* description = "E. coli sampling point on the River Avon near Bath (Wessex Water, CC BY 4.0)."',
         "* mode = #instance", '* type = $sct#420531007 "River"',
         f"* position.latitude = {dec(need(site, 'lat', 'replay site'))}",
         f"* position.longitude = {dec(need(site, 'lon', 'replay site'))}"]))
    return out, facts


# ---- Warleigh samples, cohorts, risk estimates, dataset, alert -----------------------------------------------

def sample_ids(samples: list[dict]) -> list[str]:
    """One id per sample; replicate samples taken in the same minute get -1, -2."""
    stamps = [stamp(utc(x["time_utc"])) for x in samples]
    seen: dict[str, int] = {}
    ids = []
    for st in stamps:
        if stamps.count(st) > 1:
            seen[st] = seen.get(st, 0) + 1
            ids.append(f"{st}-{seen[st]}")
        else:
            ids.append(st)
    return ids


def organisations() -> list[str]:
    return [
        instance("wessex-water", "Organization", "Organization - Wessex Water",
                 "The water company that samples Warleigh Weir and publishes the results and the overflow spill log.",
                 ['* name = "Wessex Water"', "* telecom[0].system = #url",
                  '* telecom[0].value = "https://www.wessexwater.co.uk"']),
        instance("wessex-water-sampler", "PractitionerRole", "PractitionerRole - Wessex Water sampler",
                 "The Wessex Water role that collects the river water samples (the individual is not published).",
                 ["* organization = Reference(wessex-water)", '* code[0].text = "Environmental water quality sampler"']),
    ]


def samples_fsh(backtest: dict, threshold_900: float) -> tuple[list[str], dict[str, str]]:
    out, obs_by_time = [], {}
    rows = need(backtest, "samples", "warleigh_backtest.json")
    for sid, row in zip(sample_ids(rows), rows):
        t = utc(row["time_utc"])
        if local_iso(t)[:19] != row["time_local"]:
            raise SystemExit(f"local time mismatch for sample {row['time_utc']}: {local_iso(t)} vs {row['time_local']}")
        value = need(row, "ecoli", f"sample {row['time_utc']}")
        spec, obs = f"warleigh-water-{sid}", f"warleigh-ecoli-{sid}"
        when = local_iso(t)
        out.append(instance(spec, "SpecimenOah", f"Specimen - Warleigh Weir water, {when}",
                            f"River water sample taken by Wessex Water at Warleigh Weir at {when}.",
                            ['* type = $sct#11713004 "Water"', "* subject = Reference(warleigh-weir)",
                             "* collection.collector = Reference(wessex-water-sampler)",
                             f"* collection.collectedDateTime = {s(when)}"]))
        flag = value > threshold_900
        rules = ["* status = #final", '* category[0] = $obs-category#laboratory "Laboratory"',
                 '* code.coding[0] = $oah#coliforms "Coliforms"',
                 f"* code.coding[1] = $loinc#{LOINC_ECOLI_WATER[0]} {s(LOINC_ECOLI_WATER[1])}",
                 '* code.text = "E. coli per 100 mL"',
                 "* subject = Reference(warleigh-weir)", f"* specimen = Reference({spec})",
                 f"* effectiveDateTime = {s(when)}", "* performer[0] = Reference(wessex-water)",
                 f"* valueQuantity = {dec(value)} '/(100.mL)' \"per 100 mL\"",
                 ('* interpretation[0] = $v3-interpretation#H "High"' if flag else
                  '* interpretation[0] = $v3-interpretation#N "Normal"'),
                 f"* referenceRange[0].high = {dec(threshold_900)} '/(100.mL)' \"per 100 mL\"",
                 f"* referenceRange[0].text = {s(f'Over {dec(threshold_900)} per 100 mL is a single-sample flag; the EU Bathing Water Directive applies {dec(threshold_900)} to the 90th percentile of a season' + chr(39) + 's samples.')}"]
        out.append(instance(obs, "ObservationIndicatorsOah", f"Observation - Warleigh Weir E. coli, {when}",
                            f"E. coli count in the Wessex Water sample taken at Warleigh Weir at {when}.", rules))
        obs_by_time.setdefault(row["time_utc"], obs)
    return out, obs_by_time


def cohorts_fsh() -> list[str]:
    out = []
    for gid, name, act, act_display, age in COHORTS:
        rules = ["* type = #person", "* actual = false", f"* name = {s(name)}"]
        i = 0
        if age:
            rules.append(f'* characteristic[{i}].code = $loinc#30525-0 "Age"')
            if age[0] is not None:
                rules.append(f"* characteristic[{i}].valueRange.low = {age[0]} 'a' \"years\"")
            if age[1] is not None:
                rules.append(f"* characteristic[{i}].valueRange.high = {age[1]} 'a' \"years\"")
            rules.append(f"* characteristic[{i}].exclude = false")
            i += 1
        rules += [f'* characteristic[{i}].code = SayrCs#water-contact-activity "Water contact activity"',
                  f"* characteristic[{i}].valueCodeableConcept = SayrCs#{act} {s(act_display)}",
                  f"* characteristic[{i}].exclude = false"]
        out.append(instance(gid, "GroupOah", f"Group - {name}", f"Sayr cohort: {name.lower()}.", rules))
    return out


def fold_of(kind: str, t: dt.datetime, fitted_on: str) -> tuple[str, str]:
    """The model a backtest probability came from: (device id, version text)."""
    years = fitted_on.split(" ")[0]
    a, b = (int(x) for x in years.split("-"))
    if kind == "leave-one-year-out":
        rest = [y for y in range(a, b + 1) if y != t.year]
        return (f"sayr-model-warleigh-without-{t.year}",
                f"Fitted on the {', '.join(map(str, rest))} samples; {t.year} held out")
    if kind == "held-out 2025 test":
        return "sayr-model-warleigh", f"Fitted on the {a}-{b} samples; 2025 held out as the test year"
    raise SystemExit(f"unknown probability_kind '{kind}' in warleigh_backtest.json")


def risk_fsh(replay: dict, backtest: dict, model: dict, build_utc: str) -> tuple[list[str], dict]:
    rows = {r["time_utc"]: r for r in backtest["samples"]}
    threshold = need(model, "threshold", "model_warleigh.json")
    fitted_on = need(model, "fitted_on", "model_warleigh.json")
    out, devices, risk_ids, device_by_time = [], {}, {}, {}
    for smp in need(replay, "samples", "replay_2024-09-23.json"):
        row = rows.get(smp["time_utc"])
        if row is None:
            raise SystemExit(f"replay sample {smp['time_utc']} is not in warleigh_backtest.json")
        t = utc(smp["time_utc"])
        dev, version = fold_of(need(row, "probability_kind", smp["time_utc"]), t, fitted_on)
        devices[dev] = version
        device_by_time[smp["time_utc"]] = dev
        p = need(row, "model_probability", smp["time_utc"])
        when = local_iso(t)
        for gid, name, *_ in COHORTS:
            rid = f"warleigh-risk-{gid.removeprefix('cohort-')}-{stamp(t)}"
            risk_ids[(smp["time_utc"], gid)] = rid
            out.append(instance(
                rid, "ObservationHealthMeasureOah", f"Observation - risk for {name.lower()} at Warleigh Weir, {when}",
                f"Sayr's estimate, for {name.lower()}, of the chance that the water at Warleigh Weir is over 900 E. coli per 100 mL at {when}.",
                ["* status = #final",
                 '* code = SayrCs#ecoli-exceedance-probability "Probability of E. coli over 900 per 100 mL"',
                 "* subject = Reference(warleigh-weir)", f"* focus = Reference({gid})",
                 f"* effectiveDateTime = {s(when)}", "* performer[0] = Reference(sayr-team)",
                 f"* device = Reference({dev})",
                 f"* method.text = {s('Logistic regression on upstream storm-overflow spills, river flow, rain and season (model_warleigh.json). ' + version + '.')}",
                 f"* valueQuantity = {dec(p)} '1' \"probability\"",
                 ('* interpretation[0] = $v3-interpretation#H "High"' if p >= threshold else
                  '* interpretation[0] = $v3-interpretation#N "Normal"'),
                 f"* referenceRange[0].high = {dec(threshold)} '1' \"probability\"",
                 '* referenceRange[0].text = "Warning cut fixed on the training years: it maximises the hit rate minus the false-alarm rate."',
                 f"* extension[0].url = {s('http://hl7.org/fhir/StructureDefinition/workflow-supportingInfo')}",
                 "* extension[0].valueReference = Reference(warleigh-backtest)",
                 '* note[0].text = "The estimate is for the water at this place; the cohort is the group it is addressed to. The model has no cohort-specific term."']))
    for dev, version in devices.items():
        out.append(instance(dev, "Device", "Device - Sayr Warleigh Weir risk model",
                            "Software: Sayr's logistic model of the chance that Warleigh Weir is over 900 E. coli per 100 mL.",
                            ["* status = #active", '* deviceName[0].name = "Sayr Warleigh Weir risk model"',
                             "* deviceName[0].type = #user-friendly-name", '* type.text = "Statistical risk model (software)"',
                             f"* version[0].value = {s(version + '; build ' + build_utc)}",
                             "* owner = Reference(sayr-team)"]))
    out.append(instance("sayr-team", "Organization", "Organization - Sayr team",
                        "The student team that builds Sayr for the OneAquaHealth IEEE Global Hackathon 2026.",
                        ['* name = "Sayr team"']))
    return out, {"risk_ids": risk_ids, "threshold": threshold, "devices": devices, "device_by_time": device_by_time}


def local_dt(t_utc: str, tz: str) -> str:
    """A nowcast hour ('2026-09-26T06:00Z') as a FHIR dateTime in the city's wall time with its offset."""
    return utc(t_utc).astimezone(ZoneInfo(tz)).isoformat(timespec="seconds")


def site_risk_fsh() -> tuple[list[str], dict]:
    """One ObservationHealthMeasureOah per OneAquaHealth site, for dog owners, from data/out/nowcast_<city>.json:
    the site's highest median chance of over 900 over the forecast hours, at the hour it occurs."""
    out, ids, versions, fetched = [], {}, set(), {}
    gid, cname = "cohort-dog-owners", "dog owners"
    cm = load("city_model.json")
    if need(cm, "chosen", "city_model.json") != "pooled":
        raise SystemExit("city_model.json: the method text below describes the pooled model")
    train_n = need(cm, "train_n", "city_model.json")
    for cid in CITIES:
        pk = load(f"nowcast_{cid}.json")
        version, tz = need(pk, "model_version", cid), need(pk, "timezone", cid)
        fetched[cid] = need(pk, "forecast_fetched_utc", cid)
        hours = need(pk, "hours_utc", cid)
        versions.add(version)
        for site in need(pk, "sites", f"nowcast_{cid}.json"):
            code = need(site, "code", f"nowcast_{cid}.json site")
            p50 = need(site, "p50", code)
            ok = [i for i, x in enumerate(p50) if x is not None]
            if not ok:
                raise SystemExit(f"nowcast_{cid}.json: site {code} has no forecast hour")
            i = max(ok, key=lambda k: (p50[k], -k))            # the first hour of the highest median
            fog, state = site["fog"][i], site["state"][i]
            when = local_dt(hours[i], tz)
            rid = f"oah-risk-dog-owners-{code}"
            ids[code] = rid
            out.append(instance(
                rid, "ObservationHealthMeasureOah", f"Observation - risk for {cname} at OneAquaHealth site {code}",
                f"Sayr's estimate, for {cname}, of the highest chance over the forecast that the water at OneAquaHealth "
                f"site {code} is over 900 E. coli per 100 mL, and the hour it occurs.",
                ["* status = #final",
                 '* code = SayrCs#ecoli-exceedance-probability "Probability of E. coli over 900 per 100 mL"',
                 f"* subject = Reference(oah-site-{code})", f"* focus = Reference({gid})",
                 f"* effectiveDateTime = {s(when)}", "* performer[0] = Reference(sayr-team)",
                 "* device = Reference(sayr-model-city)",
                 f"* method.text = {s(f'City model: logistic regression of the chance that one sample is over 900 E. coli per 100 mL on ln(1 + the rain of the 48 hours before), fitted on {train_n} Bath and Toulouse samples with a shared rain slope (city_model.json). At this site it runs at the mean of the two site intercepts plus the site' + chr(39) + f's own offset,which is still at its prior because the OneAquaHealth API holds no E. coli counts for the site. Rain from the Open-Meteo ECMWF IFS 0.25 ensemble. The value is the highest, over the forecast hours, of the median over the ensemble members. Model version {version}.')}",
                 f"* valueQuantity = {dec(p50[i])} '1' \"probability\"",
                 '* component[0].code = SayrCs#fog "Fog (uncertainty of the exceedance probability)"',
                 f"* component[0].valueQuantity = {dec(fog)} '1' \"fog\"",
                 '* note[0].text = "The estimate is for the water at this place; the cohort is the group it is addressed to. The model has no cohort-specific term."',
                 f"* note[1].text = {s(f'Forecast fetched {fetched[cid]}; forecast hours {hours[0]} to {hours[-1]}. Sayr state at the peak hour: {state} (fog {dec(fog)}; unknown at 0.5 or more).')}"]))
    if len(versions) != 1:
        raise SystemExit(f"the five nowcasts carry different model versions: {sorted(versions)}")
    version = versions.pop()
    dev = instance("sayr-model-city", "Device", "Device - Sayr city risk model",
                   "Software: Sayr's city model of the chance that a OneAquaHealth site is over 900 E. coli per 100 mL.",
                   ["* status = #active", '* deviceName[0].name = "Sayr city risk model"',
                    "* deviceName[0].type = #user-friendly-name", '* type.text = "Statistical risk model (software)"',
                    f"* version[0].value = {s(version)}", "* owner = Reference(sayr-team)"])
    return out + [dev], {"ids": ids, "model_version": version, "forecast_fetched_utc": fetched}


def library_fsh(backtest: dict, obs_by_time: dict[str, str], build_utc: str) -> str:
    path = C.DATA_OUT / "warleigh_backtest.json"
    rows = backtest["samples"]
    first, last = rows[0]["time_utc"][:10], rows[-1]["time_utc"][:10]
    obs_ids = [f"warleigh-ecoli-{sid}" for sid in sample_ids(rows)]
    rules = [f"* url = {s(C.CANONICAL + '/Library/warleigh-backtest')}",
             f"* identifier[0].system = {s(SID + '/dataset')}", '* identifier[0].value = "warleigh-backtest"',
             f"* version = {s(build_utc)}", '* name = "WarleighWeirBacktest"',
             f"* title = {s(f'Warleigh Weir E. coli and storm-overflow backtest ({first[:4]}-{last[:4]})')}",
             "* status = #active", '* type = $library-type#asset-collection "Asset Collection"',
             f"* date = {s(build_utc[:10])}", '* publisher = "Sayr team"', '* author[0].name = "Sayr team"',
             f"* description = {s(f'Warleigh Weir, River Avon: {len(rows)} E. coli samples ({first} to {last}) with the storm-overflow spills of the 48 hours before each, the gauge rain and flow of the days finished before it, the warning rules that fired, and the model probability.')}",
             f"* copyright = {s('Contains Wessex Water data (CC BY 4.0) and Environment Agency data (Open Government Licence v3.0). Derived values keep these licences; attribute Wessex Water and the Environment Agency.')}",
             f"* extension[size].valueQuantity = {path.stat().st_size} 'By' \"bytes\"",
             f"* extension[numberOfRecords].valueInteger = {len(rows)}",
             '* extension[$copyright-label].valueString = "CC BY 4.0 (Wessex Water) and OGL v3.0 (Environment Agency)"',
             "* relatedArtifact[0].type = #derived-from",
             '* relatedArtifact[0].display = "Wessex Water, Environmental Water Quality (CC BY 4.0)"',
             '* relatedArtifact[0].url = "https://services.arcgis.com/3SZ6e0uCvPROr4mS/arcgis/rest/services/Wessex_Water_Environmental_Water_Quality_view/FeatureServer/0"',
             "* relatedArtifact[1].type = #derived-from",
             '* relatedArtifact[1].display = "Wessex Water, Event Duration Monitoring (storm overflow spill log, CC BY 4.0)"',
             '* relatedArtifact[1].url = "https://services.arcgis.com/3SZ6e0uCvPROr4mS/arcgis/rest/services/Wessex_Water_Event_Duration_Monitoring_2024_view/FeatureServer/0"',
             "* relatedArtifact[2].type = #derived-from",
             '* relatedArtifact[2].display = "Environment Agency Hydrology API: Bath Claverton rain, Bradford-on-Avon flow (OGL v3.0)"',
             '* relatedArtifact[2].url = "https://environment.data.gov.uk/hydrology/"',
             "* content[0].contentType = #application/json", '* content[0].url = "Binary/warleigh-backtest-data"',
             f"* content[0].size = {path.stat().st_size}", '* content[0].title = "warleigh_backtest.json"']
    for oid in obs_ids:
        rules += ["* content[+].contentType = #application/fhir+json", f"* content[=].url = {s('Observation/' + oid)}"]
    return instance("warleigh-backtest", "LibraryOah", "Library - Warleigh Weir backtest dataset",
                    "The Warleigh Weir backtest dataset as an OAH asset collection.", rules)


def alert_fsh(replay: dict, backtest: dict, obs_by_time: dict, risk: dict) -> tuple[str, dict]:
    window_h = need(backtest, "window_hours", "warleigh_backtest.json")
    rows = {r["time_utc"]: r for r in backtest["samples"]}
    anchor = next((o for o in replay["overflows"] if o["name"] == ANCHOR), None)
    if anchor is None:
        raise SystemExit(f"{ANCHOR} is not among the spilling overflows in replay_2024-09-23.json")
    events = sorted((utc(e["start_utc"]), utc(e["stop_utc"])) for e in anchor["events"])
    samples = sorted(replay["samples"], key=lambda x: x["time_utc"])
    peak = max(samples, key=lambda x: x["ecoli_per_100ml"])
    t_peak = utc(peak["time_utc"])
    spill_start = next(a for a, b in events if a <= t_peak <= b)
    # Issued at the first sample after the peak taken while the storm tank was not spilling.
    issue = next(x for x in samples if utc(x["time_utc"]) > t_peak
                 and not any(a <= utc(x["time_utc"]) < b for a, b in events))
    t_issue = utc(issue["time_utc"])
    last_stop = max(b for a, b in events if b <= t_issue)
    until = last_stop + dt.timedelta(hours=window_h)
    row = rows[issue["time_utc"]]
    reasons = [RULE_REASON[k] for k in RULE_REASON if row["rules"][k]]
    if not reasons:
        raise SystemExit("no warning rule fired at the alert sample; the alert would have no reason")
    evidence = [obs_by_time[x["time_utc"]] for x in samples
                if spill_start <= utc(x["time_utc"]) <= t_issue and x["over_900"]]
    risk_id = risk["risk_ids"][(issue["time_utc"], "cohort-dog-owners")]
    sender = risk["device_by_time"][issue["time_utc"]]
    until_local = until.astimezone(LONDON)
    hours = round(row["freshford_hours_48h"])
    text = (f"Warleigh Weir: keep your dog out of the water until {until_local:%A} {until_local:%H:%M}. "
            f"The Freshford storm tank upstream spilled for {hours} hours in the last two days.")
    rules = ["* status = #completed", "* priority = #urgent", "* subject = Reference(cohort-dog-owners)",
             "* recipient[0] = Reference(cohort-dog-owners)", "* about[0] = Reference(warleigh-weir)",
             f"* sent = {s(local_iso(t_issue))}", f"* sender = Reference({sender})",
             f"* extension[validity].valuePeriod.start = {s(local_iso(t_issue))}",
             f"* extension[validity].valuePeriod.end = {s(local_iso(until))}",
             f"* reasonReference[0] = Reference({risk_id})"]
    rules += [f"* reasonReference[{i + 1}] = Reference({e})" for i, e in enumerate(evidence)]
    rules += [f"* reasonCode[{i}] = SayrCs#{c} {s(d)}" for i, (c, d) in enumerate(reasons)]
    rules += [f"* payload[0].contentString = {s(text)}"]
    aid = f"alert-warleigh-dog-owners-{stamp(t_issue)}"
    fsh = instance(aid, "AlertOah", "Communication - alert for dog owners at Warleigh Weir (proposal)",
                   "An AlertOah (proposed profile) sent to dog owners following Warleigh Weir.", rules)
    sub = instance("subscription-dog-owner-alerts", "Subscription", "Subscription - alerts for dog owners",
                   "Pushes every alert addressed to the dog-owner cohort over a websocket.",
                   ["* status = #requested", '* reason = "Push Sayr alerts addressed to dog owners"',
                    '* criteria = "Communication?category=http://terminology.hl7.org/CodeSystem/communication-category|alert&subject=Group/cohort-dog-owners"',
                    "* channel.type = #websocket"])
    facts = {"id": aid, "sent_utc": t_issue.isoformat(), "until_utc": until.isoformat(), "text": text,
             "peak_utc": t_peak.isoformat(), "peak_ecoli": peak["ecoli_per_100ml"], "last_stop_utc": last_stop.isoformat(),
             "window_hours": window_h, "reasons": [c for c, _ in reasons], "evidence": evidence, "risk": risk_id}
    return fsh + "\n" + sub, facts


def write_all() -> dict:
    build = load("build_info.json")
    build_utc = need(build, "built_utc", "build_info.json")
    backtest = load("warleigh_backtest.json")
    replay = load("replay_2024-09-23.json")
    model = load("model_warleigh.json")
    threshold_900 = need(backtest, "threshold", "warleigh_backtest.json")

    loc, facts = locations()
    samp, obs_by_time = samples_fsh(backtest, threshold_900)
    risk, rfacts = risk_fsh(replay, backtest, model, build_utc)
    alert, afacts = alert_fsh(replay, backtest, obs_by_time, rfacts)
    site_risk, sfacts = site_risk_fsh()
    files = {"locations.fsh": loc, "warleigh-samples.fsh": organisations() + samp,
             "cohorts-and-risk.fsh": cohorts_fsh() + risk, "site-risk.fsh": site_risk,
             "dataset.fsh": [library_fsh(backtest, obs_by_time, build_utc)], "alert.fsh": [alert]}
    C.GENERATED_FSH.mkdir(parents=True, exist_ok=True)
    for old in C.GENERATED_FSH.glob("*.fsh"):
        old.unlink()
    header = "// GENERATED by `python -m sayr_fhir build` from sayr/data/out. Do not edit.\n\n"
    for name, parts in files.items():
        (C.GENERATED_FSH / name).write_text(header + "\n".join(parts), encoding="utf-8", newline="\n")
    facts.update({"build_utc": build_utc, "samples": len(backtest["samples"]),
                  "replay_samples": len(replay["samples"]), "risk_estimates": len(rfacts["risk_ids"]),
                  "alert": afacts, "threshold": rfacts["threshold"], "site_risk": sfacts})
    return facts
