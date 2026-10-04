"""One command: fetch (or read the cache), recompute every number, write data/out/."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import (bath, citymodel, config, darkhours, evidence, forecast, model, nowcast, oah, offsets,
               replay, transfer, updatespec)
from .fetch import Fetcher, MissingInput, utc_now
from .numbers import Numbers

EDM = [f"data/raw/wessex_edm_warleigh_{k}.json" for k in config.EDM_LAYERS]
WQ = ["data/raw/wessex_wq_warleigh.json"]
HYDRO = ["data/raw/ea_rain_claverton_daily.csv", "data/raw/ea_flow_bradford_on_avon_daily.csv"]
OSM_AVON = ["data/raw/osm_avon_frome_waterways.json"]


def write(name: str, obj: Any) -> Path:
    config.OUT.mkdir(parents=True, exist_ok=True)
    p = config.OUT / name
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_default), encoding="utf-8")
    return p


def _default(o: Any) -> Any:
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def rules_numbers(num: Numbers, prefix: str, table: dict[str, dict], sources: list[str], what: str) -> None:
    for k, r in table.items():
        base = f"{prefix}.{k}"
        num.add(f"{base}.warned_exceed", r["warned_exceed"], f"{what}: exceedances warned by '{r['label']}'",
                sources, "pipeline.evidence.rule_table")
        num.add(f"{base}.warned", r["warned"], f"{what}: samples warned by '{r['label']}'", sources,
                "pipeline.evidence.rule_table")
        num.add(f"{base}.false_warnings", r["false_warnings"], f"{what}: warned samples at or under 900",
                sources, "pipeline.evidence.rule_table")
        num.add(f"{base}.not_warned_exceed", r["not_warned_exceed"], f"{what}: exceedances not warned",
                sources, "pipeline.evidence.rule_table")
        num.add(f"{base}.not_warned", r["not_warned"], f"{what}: samples not warned", sources,
                "pipeline.evidence.rule_table")
        for m in ("pod", "far", "warned_median", "not_warned_median"):
            if r[m] is not None:
                num.add(f"{base}.{m}", r[m], f"{what}: {m.replace('_', ' ')} of '{r['label']}'", sources,
                        "pipeline.evidence.rule_table")


def metric_numbers(num: Numbers, prefix: str, m: dict[str, Any], what: str, sources: list[str], fn: str) -> None:
    for k, v in m.items():
        if v is not None:
            num.add(f"{prefix}.{k}", v, f"{what}: {k.replace('_', ' ')}", sources, fn)


def run(offline: bool = False, allow_cache: bool = False) -> dict[str, Any]:
    t0 = time.time()
    f = Fetcher(offline=offline, allow_cache=allow_cache)
    num = Numbers()
    src_all = EDM + WQ + HYDRO

    # ---- Warleigh Weir evidence ------------------------------------------------------------
    b = bath.load(f)
    rows = b.joined
    table = evidence.rule_table(rows)
    rules_numbers(num, "warleigh.rule", table, src_all, "Warleigh Weir 2021-2025, 48 h before each sample")
    num.add("warleigh.samples", len(rows), "E. coli samples at Warleigh Weir inside the spill-log period",
            WQ + EDM, "pipeline.evidence.join")
    num.add("warleigh.exceedances", table["combined"]["exceedances"], "samples over 900 E. coli per 100 ml",
            WQ, "pipeline.evidence.score")
    num.add("warleigh.unexplained", table["combined"]["not_warned_exceed"],
            "exceedances with no upstream spill, no flow >= 15 m3/s and no rain >= 10 mm in the 48 h before",
            src_all, "pipeline.evidence.rule_table")
    num.add("warleigh.spill_records", len(b.spills), "upstream overflow spill records used (2020-2026 logs)",
            EDM, "pipeline.sources.warleigh_spills")
    num.add("warleigh.overflow_names", len({s.name for s in b.spills}), "distinct overflow names in those records",
            EDM, "pipeline.sources.warleigh_spills")
    num.add("warleigh.samples_first", rows[0].sample.local[:10], "first sample date", WQ, "pipeline.evidence.join")
    num.add("warleigh.samples_last", rows[-1].sample.local[:10], "last sample date", WQ, "pipeline.evidence.join")
    num.add("warleigh.freshford_days", evidence.freshford_days(rows),
            "distinct sampling days among the Freshford-warned samples", src_all, "pipeline.evidence.freshford_days")
    for k, v in evidence.signal_adds(rows).items():
        num.add(f"warleigh.{k}", v, "Freshford-warned samples with prior-day flow under 15 m3/s"
                + (" that exceeded 900" if k.endswith("exceed") else ""), src_all, "pipeline.evidence.signal_adds")
    for y, r in evidence.by_year(rows, evidence.RULES["combined"][1]).items():
        num.add(f"warleigh.combined.{y}.pod", r["pod"], f"combined rule, share of {y} exceedances warned", src_all,
                "pipeline.evidence.by_year")
        num.add(f"warleigh.combined.{y}.far", r["far"], f"combined rule, share of {y} warnings at or under 900",
                src_all, "pipeline.evidence.by_year")
        num.add(f"warleigh.combined.{y}.n", r["n"], f"samples in {y}", src_all, "pipeline.evidence.by_year")

    # ---- the model -------------------------------------------------------------------------
    site, paths = bath.site(b)
    num.add("warleigh.overflows", len(site.overflows), "upstream overflows after merging spelling variants",
            EDM, "pipeline.model.group_overflows")
    fres = site.overflows[site.anchor]
    num.add("warleigh.freshford_distance_km", round(fres.distance_m / 1000, 2),
            "along-river distance, Freshford storm tank to Warleigh Weir (OpenStreetMap)", EDM + OSM_AVON,
            "pipeline.bath.locate")
    results = {}
    for spec in ("warleigh", "portable"):
        r = bath.fit_and_test(b, site, spec)
        m: model.Fitted = r["model"]
        results[spec] = r
        what = {"warleigh": "Warleigh model", "portable": "portable model (no named overflow)"}[spec]
        metric_numbers(num, f"model.{spec}.test2025", r["test"], f"{what}, 2025 held-out samples", src_all,
                       "pipeline.bath.fit_and_test")
        metric_numbers(num, f"model.{spec}.train_cv", r["train_oof"],
                       f"{what}, 2021-2024 leave-one-year-out", src_all, "pipeline.model.year_cv")
        num.add(f"model.{spec}.velocity_m_per_s", m.velocity,
                "travel-time velocity chosen by 2021-2024 cross-validated log loss (0 = no shift)", src_all,
                "pipeline.model.select_velocity")
        vec = bath.vectors(m, r["test_samples"], r["test_raws"], r["test_p"])
        write(f"model_{spec}.json", {**model.export(m, "Warleigh Weir, River Avon", bath.travel_table(site, m.velocity),
                                                    vec),
                                     "fitted_on": "2021-2024 samples", "tested_on": "2025 samples, held out",
                                     "train_n": r["train_n"], "train_exceedances": r["train_exceedances"],
                                     "velocity_cv_logloss": {str(k): v for k, v in r["velocity_cv_logloss"].items()},
                                     "test_2025": r["test"], "train_cv": r["train_oof"]})
    rules_numbers(num, "warleigh.rule2025", results["warleigh"]["test_rules"], src_all,
                  "Warleigh Weir 2025 samples only")
    write("warleigh_backtest.json", backtest_rows(rows, results["warleigh"], site))
    num.add("warleigh.window_hours", int(config.WINDOW_H) if float(config.WINDOW_H).is_integer() else config.WINDOW_H,
            "hours before each sample in which an upstream spill counts (the window of the 43-of-44 Freshford rule)",
            ["pipeline/config.py", "pipeline/evidence.py"], "pipeline.evidence.join (config.WINDOW_H)")

    # ---- storm replays -----------------------------------------------------------------------
    for key in replay.WINDOWS:
        p = replay.pack(b, site, paths, key)
        write(f"replay_{key}.json", p)
        num.add(f"replay.{key}.overflows_spilling", p["overflows_spilling"],
                f"upstream overflows with a spill overlapping the replay window {p['window_local']}", EDM,
                "pipeline.replay.pack")
        num.add(f"replay.{key}.samples", len(p["samples"]), "Warleigh samples inside the window", WQ,
                "pipeline.replay.pack")
        top = max(p["samples"], key=lambda s: s["ecoli_per_100ml"])
        num.add(f"replay.{key}.max_ecoli", top["ecoli_per_100ml"], f"highest sample in the window ({top['time_local']})",
                WQ, "pipeline.replay.pack")

    # ---- transfer rivers -------------------------------------------------------------------
    port = results["portable"]
    fr = transfer.farleigh(f, b, port["model"])
    fsrc = [f"data/raw/wessex_edm_farleigh_{k}.json" for k in config.EDM_LAYERS] + \
           ["data/raw/wessex_wq_farleigh.json", "data/raw/ea_flow_tellisford_daily.csv"] + HYDRO[:1]
    for k, v in fr["rule"].items():
        num.add(f"farleigh.rule.{k}", v, f"Farleigh Hungerford, any upstream spill in the prior 48 h: {k}", fsrc,
                "pipeline.transfer.spill_backtest")
    fm = model.metrics(fr["y"], fr["p"], port["model"].threshold, port["train_exceedances"] / port["train_n"])
    metric_numbers(num, "farleigh.portable_model", fm, "Farleigh Hungerford, portable Bath model, no refit",
                   fsrc + OSM_AVON, "pipeline.transfer.farleigh")
    num.add("farleigh.overflows", fr["overflows"], "upstream overflows in the Farleigh set", fsrc,
            "pipeline.transfer.farleigh")
    al = transfer.alewife(f)
    asrc = ["data/raw/restricted/massdep_alewife_incidents.xlsx", "data/raw/restricted/mwra_cso_table_export.csv",
            "data/raw/restricted/mwra_mystic_bacteria.xlsx"]
    for k, v in al.items():
        num.add(f"alewife.{k}", v, f"Alewife Brook, overflow start in the prior 48 h: {k}", asrc,
                "pipeline.transfer.alewife")
    write("transfer.json", {"farleigh": {"rule": fr["rule"], "portable_model_no_refit": fm,
                                         "overflows": fr["overflow_names"], "samples_first": fr["samples_first"],
                                         "samples_last": fr["samples_last"],
                                         "qualified_samples": fr["qualified"],
                                         "ambiguous_dropped": fr["ambiguous"],
                                         "label_rule": "a result published with '<' or '>' keeps its qualifier; it "
                                                       "is labelled only when the qualifier decides it against 900 "
                                                       "('> 10000' is over, '< 1000' is dropped)",
                                         "features": "upstream spills (Wessex logs), Bath Claverton rain, "
                                                     "Tellisford flow as a ratio to its 2021-2024 median"},
                            "alewife": {**al, "note": "local (US Eastern) times; source files are not "
                                                      "redistributed because their licences are not stated"}})

    # ---- OneAquaHealth ---------------------------------------------------------------------
    c = oah.core(f)
    osrc = ["data/raw/oah_sites.json", "data/raw/oah_health_risks.json"]
    for k in ("sites", "citizen_sites", "health_risks", "urban"):
        num.add(f"oah.{k}", len(c[k]), f"rows returned by the OneAquaHealth API ({k})",
                [f"data/raw/oah_{k if k != 'urban' else 'urban_parameters'}.json"], "pipeline.oah.core")
    dry = oah.dry_weather(f, c)
    num.add("oah.dry.samples", dry["samples"], "health-risk samplings with a date", osrc, "pipeline.oah.dry_weather")
    num.add("oah.dry.dry", dry["dry"], dry["definition"], osrc + ["data/raw/oah_weather_*.json"],
            "pipeline.oah.dry_weather")
    num.add("oah.dry.wet_5mm", dry["wet_5mm"], "samplings after 5 mm or more in 3 days",
            osrc + ["data/raw/oah_weather_*.json"], "pipeline.oah.dry_weather")
    tl = oah.toulouse(f)
    tsrc = ["data/raw/hubeau_pech_david_ecoli.json", "data/raw/openmeteo_archive_toulouse_daily.json",
            "data/raw/hubeau_garonne_portet_flow_daily.json"]
    for k in ("samples", "exceed"):
        num.add(f"toulouse.{k}", tl[k], f"Garonne at Pech David, E. coli samples 2016-2025: {k}", tsrc,
                "pipeline.oah.toulouse")
    num.add("toulouse.below_detection", sum(r["qualifier"] == "<" for r in tl["rows"]),
            "Pech David samples published below detection (code_remarque 2); labelled under 900, censored in the "
            "count fit", tsrc[:1], "pipeline.oah.hubeau_qualifier")
    for grp in ("wet_2d_5mm", "otherwise", "dry_3d_1mm"):
        for k, v in tl[grp].items():
            num.add(f"toulouse.{grp}.{k}", v, f"Garonne at Pech David, {grp.replace('_', ' ')}: {k}", tsrc,
                    "pipeline.oah.toulouse")
    for k, v in tl["separation_auc"].items():
        num.add(f"toulouse.auc.{k}", v, "chance an over-900 sample has a higher value than a sample at or under "
                "900 (0.5 = none)", tsrc, "pipeline.oah.toulouse")
    fc_times = {}
    for cid in config.OAH_CITIES:
        pack = oah.city_pack(f, c, cid, dry)
        if cid == "TO":
            pack["wet_weather_evidence"] = tl
        write(f"city_{cid}.json", pack)
        num.add(f"oah.{cid}.sites", len(pack["sites"]), "OneAquaHealth research sites in the city", osrc,
                "pipeline.oah.city_pack")
        num.add(f"oah.{cid}.citizen_sites", pack["citizen_sites_in_box"],
                "citizen-created sites inside the city box (sites + 0.05 degrees)", ["data/raw/oah_citizen_sites.json"],
                "pipeline.oah.city_pack")
        num.add(f"oah.{cid}.dry", dry["per_city"][cid]["dry"], "samplings after under 1 mm in 3 days",
                osrc, "pipeline.oah.dry_weather")
        num.add(f"oah.{cid}.samples", dry["per_city"][cid]["samples"], "dated health-risk samplings", osrc,
                "pipeline.oah.dry_weather")
        sites = [s for s in c["sites"] if s["city"]["id"] == cid]
        fc = forecast.city_forecast(f, cid, sites)
        write(f"forecast_{cid}.json", fc)
        fc_times[cid] = fc["fetched_utc"]

    city_model(f, b, tl, c, num)
    write("numbers.json", num.to_json())
    info = {"built_utc": utc_now(), "offline": offline, "seconds": round(time.time() - t0, 1),
            "numbers": len(num.rows), "forecast_fetched_utc": fc_times, "fetch_log": f.log}
    write("build_info.json", info)
    return info


def backtest_rows(rows: list[evidence.Joined], res: dict[str, Any], site: model.Site) -> dict[str, Any]:
    """Every Warleigh sample with its rule flags and model probability (out-of-fold for 2021-2024, test for 2025)."""
    m: model.Fitted = res["model"]
    train = [j for j in rows if j.sample.local[:4] in bath.TRAIN_YEARS]
    _, p_oof = model.year_cv(m.spec, [j.sample for j in train], site, m.velocity, bath.TRAIN_YEARS)
    prob = {id(j): float(p) for j, p in zip(train, p_oof)}
    test = [j for j in rows if j.sample.local[:4] == bath.TEST_YEAR]
    prob.update({id(j): float(p) for j, p in zip(test, res["test_p"])})
    out = []
    for j in rows:
        flags = {k: bool(rule(j)) for k, (_, rule) in evidence.RULES.items()}
        out.append({"time_utc": j.sample.t.isoformat().replace("+00:00", "Z"), "time_local": j.sample.local,
                    "ecoli": j.sample.ecoli, "ecoli_qualifier": j.sample.operator, "enterococci": j.sample.enterococci,
                    "enterococci_qualifier": j.sample.enterococci_operator, "over_900": j.exceed,
                    "freshford_hours_48h": round(j.hours_freshford, 2), "upstream_hours_48h": round(j.hours_all, 2),
                    "rain_2d_mm": round(j.rain_2d, 2), "flow_prev_day_m3s": j.flow_prev, "rules": flags,
                    "unexplained": j.exceed and not flags["combined"], "model_probability": prob[id(j)],
                    "probability_kind": "held-out 2025 test" if j.sample.local[:4] == bath.TEST_YEAR
                    else "leave-one-year-out"})
    return {"site": "Warleigh Weir, River Avon", "window_hours": config.WINDOW_H, "threshold": config.THRESHOLD,
            "rules": {k: v[0] for k, v in evidence.RULES.items()}, "samples": out}


def city_model(f: Fetcher, b: bath.Bath, tl: dict[str, Any], c: dict[str, Any], num: Numbers) -> None:
    """The city model: fit and cross-site test, the update spec, dark hours, and the nowcast."""
    cm = citymodel.run(f, b, tl)
    write("city_model.json", citymodel.public(cm))
    citymodel.numbers(num, cm)
    p = offsets.Params(cm["alpha"], cm["beta"], cm["tau_a"], cm["tau_b"], cm["count_scale_s"], cm["t_higher"],
                       cm["t_high"], cm["fog_unknown"])
    spec = updatespec.build(p, nowcast.model_version(p))
    write("update_spec.json", spec)
    dh = darkhours.run(f, c, cm)
    write("dark_hours.json", dh)
    dsrc = ["data/raw/oah_weather_*.json", "data/raw/openmeteo_archive_toulouse_daily.json",
            "data/raw/openmeteo_archive_warleigh_daily.json", "data/raw/ea_rain_claverton_daily.csv"]
    for grp, sm in dh["summary"].items():
        if grp == "oneaquahealth_by_city":
            continue
        for k, v in sm.items():
            num.add(f"darkhours.{grp}.{k}", v, f"{grp}: {k.replace('_', ' ')} (dry = under 1 mm in 3 days)", dsrc,
                    "pipeline.darkhours.run")
    defs = ["pipeline/config.py", "pipeline/darkhours.py", "pipeline/oah.py"]
    num.add("thresholds.ecoli_flag_per_100ml", config.THRESHOLD,
            "E. coli per 100 ml used as a single-sample flag (the EU inland 'sufficient' value, applied there to a 90th percentile)",
            defs, "pipeline.config.THRESHOLD")
    num.add("thresholds.dry_mm_3d", darkhours.DRY_MM, "rain under this many mm in the 3 days before a sample counts as dry",
            defs, "pipeline.darkhours.DRY_MM")
    num.add("thresholds.wet_mm_2d", oah.WET_MM_2D,
            "rain of at least this many mm over the 2 days before a sample counts as wet (Toulouse split)",
            defs, "pipeline.oah.WET_MM_2D")
    orows = dh["oneaquahealth"]
    num.add("darkhours.oah.wet_after_rain", sum(r["dry"] is False for r in orows),
            f"OneAquaHealth samplings after {darkhours.DRY_MM:g} mm or more of rain in the 3 days before", dsrc[:1],
            "pipeline.darkhours.run")
    num.add("darkhours.oah.wet_after_5mm", sum(r["rain_3d_mm"] is not None and r["rain_3d_mm"] >= 5 for r in orows),
            "OneAquaHealth samplings after 5 mm or more of rain in the 3 days before", dsrc[:1],
            "pipeline.darkhours.run")
    packs = nowcast.run(f, spec, c["sites"])
    for cid, pk in packs.items():
        write(f"nowcast_{cid}.json", pk)
    nowcast.numbers(num, packs)


def run_nowcast(offline: bool = False, allow_cache: bool = False) -> dict[str, Any]:
    """Daily refresh: the forecast only; the model comes from data/out/update_spec.json (written by build)."""
    t0 = time.time()
    spec_path, num_path = config.OUT / "update_spec.json", config.OUT / "numbers.json"
    for pth in (spec_path, num_path):
        if not pth.exists():
            raise MissingInput(f"{pth.name}: not built yet; run `python -m pipeline build` first")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    f = Fetcher(offline=offline, allow_cache=allow_cache)
    sites = oah.api(f, "/sites/all", "oah_sites.json")
    packs = nowcast.run(f, spec, sites)
    for cid, pk in packs.items():
        write(f"nowcast_{cid}.json", pk)
    rows = {k: v for k, v in json.loads(num_path.read_text(encoding="utf-8")).items()
            if not k.startswith("nowcast.")}
    num = Numbers()
    nowcast.numbers(num, packs)
    rows.update(num.rows)
    write("numbers.json", dict(sorted(rows.items())))
    return {"nowcast_utc": utc_now(), "offline": offline, "seconds": round(time.time() - t0, 1),
            "model_version": spec["model_version"],
            "forecast_fetched_utc": {c: p["forecast_fetched_utc"] for c, p in packs.items()},
            "quests": {c: [(q["code"], q["name"], q["window_start_local"], q["window_end_local"])
                           for q in p["quests"]] for c, p in packs.items()}, "fetch_log": f.log}
