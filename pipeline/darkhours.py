"""data/out/dark_hours.json (W2): every sample on one rain axis. OneAquaHealth's 96, the Garonne, Warleigh Weir."""
from __future__ import annotations

import datetime as dt
from typing import Any

from . import config, oah, rainarchive
from .fetch import Fetcher
from .sources import DailySeries, complete_day

DRY_MM = 1.0   # dry = under 1 mm in the 3 days before the sampling day (the definition behind 80 of 96)


def _prior(rain: dict[str, float | None], day: dt.date, n: int) -> float | None:
    vals = [rain.get((day - dt.timedelta(days=k)).isoformat()) for k in range(1, n + 1)]
    return None if any(v is None for v in vals) else round(sum(vals), 2)  # type: ignore[arg-type]


def _row(rain: dict[str, float | None], day: dt.date) -> dict[str, Any]:
    r1, r3, r7 = (_prior(rain, day, n) for n in (1, 3, 7))
    return {"rain_1d_mm": r1, "rain_3d_mm": r3, "rain_7d_mm": r7,
            "dry": None if r3 is None else r3 < DRY_MM}


def _gauge_row(gauge: DailySeries, t: dt.datetime) -> dict[str, Any]:
    """Gauge days run 09:00-09:00 GMT: the n latest that finished at or before the sample time t."""
    def prior(n: int) -> float | None:
        vals = [gauge[k].value if k in gauge else None for k in (complete_day(gauge, t, i) for i in range(1, n + 1))]
        return None if any(v is None for v in vals) else round(sum(vals), 2)  # type: ignore[arg-type]
    return {"rain_1d_mm": prior(1), "rain_3d_mm": prior(3), "rain_7d_mm": prior(7)}


def run(f: Fetcher, core: dict[str, Any], cm: dict[str, Any]) -> dict[str, Any]:
    name = {s["code"]: s["name"] for s in core["sites"]}
    city = {s["code"]: s["city"]["id"] for s in core["sites"]}
    oah_rows = []
    for r in core["health_risks"]:
        if not r["samplingDate"]:
            continue
        sd = dt.date.fromisoformat(r["samplingDate"][:10])
        w = oah.weather(f, r["researchSiteCode"], (sd - dt.timedelta(days=14)).isoformat(), sd.isoformat())
        rain = {x["date"]: x.get("precipTotalMm") for x in w}
        oah_rows.append({"site": r["researchSiteCode"], "site_name": name[r["researchSiteCode"]],
                         "city": city[r["researchSiteCode"]], "date": sd.isoformat(), **_row(rain, sd),
                         # OneAquaHealth health-risk values are not redistributed (licence pending); the keys stay
                         # null because the app's schema names them.
                         "scaled_fecal_risk": None, "health_risk_score": None})
    tou_rain = oah.toulouse_daily_rain(f)
    r48_t = {o.local[:10]: o.r48 for o in cm["obs"]["toulouse"]}
    # rain_2d_mm is the row's own value from pipeline.oah.toulouse, the definition behind 6 of 30.
    tou_rows = [{"site": "BF000002", "site_name": "Garonne at Pech David", "city": "TO", "date": r["date"],
                 **_row(tou_rain, dt.date.fromisoformat(r["date"])), "rain_2d_mm": r["rain_2d_mm"],
                 "ecoli_per_100ml": r["ecoli_per_100ml"],
                 "over_900": r["over_900"], "r48_era5_mm": round(r48_t[r["date"]], 2)}
                for r in cm["toulouse_pack"]["rows"]]
    bath_rain = rainarchive.daily_best_match(f, "openmeteo_archive_warleigh_daily.json", rainarchive.WARLEIGH_POINT,
                                             "2020-12-20", "2025-12-31", "Europe/London")
    gauge = cm["bath_pack"].rain
    bath_rows = []
    for o in cm["obs"]["bath"]:
        day = dt.date.fromisoformat(o.local[:10])
        g = _gauge_row(gauge, o.t_utc)
        bath_rows.append({"site": "WARLEIGH", "site_name": "Warleigh Weir, River Avon", "city": "Bath",
                          "date": o.local[:10], "time_local": o.local, **_row(bath_rain, day),
                          "gauge_rain_1d_mm": g["rain_1d_mm"], "gauge_rain_3d_mm": g["rain_3d_mm"],
                          "gauge_rain_7d_mm": g["rain_7d_mm"], "ecoli_per_100ml": o.ecoli,
                          "over_900": bool(o.y), "r48_era5_mm": round(o.r48, 2)})

    def summ(rows: list[dict[str, Any]]) -> dict[str, Any]:
        dry = [r for r in rows if r["dry"]]
        wet = [r for r in rows if r["dry"] is False]
        out: dict[str, Any] = {"n": len(rows), "dry": len(dry), "not_dry": len(wet),
                               "rain_missing": sum(r["dry"] is None for r in rows)}
        if rows and "over_900" in rows[0]:
            out.update({"dry_over_900": sum(r["over_900"] for r in dry),
                        "not_dry_over_900": sum(r["over_900"] for r in wet)})
        return out

    return {
        "definition": "dry = less than 1 mm of rain summed over the 3 days before the sampling day (the sampling "
                      "day excluded); 1 d = the day before; 7 d = the 7 days before",
        "rain_sources": {"oneaquahealth": "OneAquaHealth API daily weather per site (precipTotalMm)",
                         "toulouse": "Open-Meteo historical archive, default model, daily sum at 43.5966, 1.4331 "
                                     "(Europe/Paris days), the file behind the 6 of 30 finding; rain_2d_mm = the 2 "
                                     "days before the sample day, wet when >= 5 mm (thresholds.wet_mm_2d)",
                         "bath": "Open-Meteo historical archive, default model, daily sum at Warleigh Weir "
                                 "(Europe/London days); gauge_* = Environment Agency Bath Claverton, gauge days "
                                 "09:00-09:00 GMT, only those finished at or before the sample time",
                         "r48_era5_mm": "the model's input: Open-Meteo ERA5 hourly rain in the 48 h before the "
                                        "sample time"},
        "note_900": "over_900 is a single-sample flag; the EU applies 900 to a 90th percentile",
        "summary": {"oneaquahealth": summ(oah_rows), "toulouse_garonne": summ(tou_rows), "bath_warleigh": summ(bath_rows),
                    "oneaquahealth_by_city": {c: summ([r for r in oah_rows if r["city"] == c])
                                              for c in config.OAH_CITIES}},
        "oneaquahealth": oah_rows, "toulouse_garonne": tou_rows, "bath_warleigh": bath_rows,
    }
