"""OneAquaHealth city packs (read-only public API), the dry-weather finding, and Toulouse's wet-weather series."""
from __future__ import annotations

import datetime as dt
import urllib.parse
from typing import Any

import numpy as np

from . import config, rivers
from .fetch import Fetcher

CITY_MARGIN_DEG = 0.02       # waterway box margin around a city's sites
CITIZEN_MARGIN_DEG = 0.05    # citizen sites counted "in the city" inside this margin
WATERWAYS = "river|stream|canal|brook|tidal_channel"
HUBEAU_LICENCE = ("Licence Ouverte / Etalab 2.0 (stated by Naiades, the source database of Hub'Eau river "
                  "quality, and by the eaufrance.fr legal notice)")
PECH_DAVID = {"code": "BF000002", "name": "PECH DAVID", "river": "Garonne", "lat": 43.6093, "lon": 1.4195}
PORTET_FLOW = {"code": "O200001001", "name": "La Garonne a Portet-sur-Garonne"}
TOULOUSE_RAIN_POINT = (43.5966, 1.4331)
WET_MM_2D = 5.0              # Toulouse split: wet = at least this much rain over the 2 days before the sample day


def api(f: Fetcher, path: str, name: str, **q: str) -> Any:
    url = config.OAH_BASE + path + ("?" + urllib.parse.urlencode(q) if q else "")
    return f.json(name, url, config.OAH_API, headers=config.OAH_HEADERS)


def core(f: Fetcher) -> dict[str, Any]:
    return {"cities": api(f, "/cities/all", "oah_cities.json"),
            "sites": api(f, "/sites/all", "oah_sites.json"),
            "citizen_sites": api(f, "/sites/user-generated", "oah_citizen_sites.json"),
            "health_risks": api(f, "/resilience-map/health-risks", "oah_health_risks.json"),
            "urban": api(f, "/resilience-map/urban-parameters", "oah_urban_parameters.json")}


def weather(f: Fetcher, code: str, d0: str, d1: str) -> list[dict[str, Any]]:
    return api(f, "/resilience-map/weather", f"oah_weather_{code}_{d0}_{d1}.json",
               siteCode=code, start=d0 + "T00:00:00Z", end=d1 + "T23:59:59Z")


def dry_weather(f: Fetcher, c: dict[str, Any]) -> dict[str, Any]:
    """Rain in the 3 days before each health-risk sampling date (the sampling day excluded)."""
    city_of = {s["code"]: s["city"]["id"] for s in c["sites"]}
    rows = []
    for r in c["health_risks"]:
        if not r["samplingDate"]:
            continue
        sd = dt.date.fromisoformat(r["samplingDate"][:10])
        w = weather(f, r["researchSiteCode"], (sd - dt.timedelta(days=14)).isoformat(), sd.isoformat())
        rain = {x["date"]: x["precipTotalMm"] for x in w if x.get("precipTotalMm") is not None}
        r3 = sum(v for k, v in rain.items() if (sd - dt.timedelta(days=3)).isoformat() <= k < sd.isoformat())
        rows.append({"site": r["researchSiteCode"], "city": city_of[r["researchSiteCode"]],
                     "date": sd.isoformat(), "rain_3d_mm": round(r3, 2)})
    per_city = {}
    for cid in config.OAH_CITIES:
        cr = [x for x in rows if x["city"] == cid]
        per_city[cid] = {"samples": len(cr), "dry": sum(x["rain_3d_mm"] < 1 for x in cr),
                         "wet_5mm": sum(x["rain_3d_mm"] >= 5 for x in cr)}
    return {"samples": len(rows), "dry": sum(x["rain_3d_mm"] < 1 for x in rows),
            "wet_5mm": sum(x["rain_3d_mm"] >= 5 for x in rows), "per_city": per_city, "rows": rows,
            "definition": "dry = less than 1 mm of rain (OneAquaHealth daily weather) summed over the 3 days "
                          "before the sampling date"}


def _bbox(points: list[tuple[float, float]], m: float) -> tuple[float, float, float, float]:
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    return min(lats) - m, min(lons) - m, max(lats) + m, max(lons) + m


# OneAquaHealth raw API responses are not redistributed (no licence stated). A city pack
# publishes only what the app draws: site code, name and coordinates, the city's name and centre, and Sayr's own
# derived numbers. The health-risk and urban payloads, site polygons and altitudes, and the citizen-created sites stay
# in the unpublished raw cache (data/raw/oah_*.json). The withheld keys stay present as null / [] because the app's
# schema and tests still name them.
WITHHELD = ("altitude", "polygon", "health_risk", "urban", "citizen_sites")


def citizens_in_box(c: dict[str, Any], sites: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[float]]:
    """Citizen-created sites inside the city's sites box plus CITIZEN_MARGIN_DEG (counted, never published)."""
    s, w, n, e = _bbox([(x["latitude"], x["longitude"]) for x in sites], CITIZEN_MARGIN_DEG)
    return [u for u in c["citizen_sites"] if u.get("latitude") is not None
            and s <= u["latitude"] <= n and w <= u["longitude"] <= e], [s, w, n, e]


def city_pack(f: Fetcher, c: dict[str, Any], cid: str, dry: dict[str, Any]) -> dict[str, Any]:
    city = next(x for x in c["cities"] if x["id"] == cid)
    sites = [s for s in c["sites"] if s["city"]["id"] == cid]
    rain3 = {x["site"]: x["rain_3d_mm"] for x in dry["rows"]}
    citizens, cbox = citizens_in_box(c, sites)
    box = _bbox([(x["latitude"], x["longitude"]) for x in sites], CITY_MARGIN_DEG)
    osm = rivers.overpass_waterways(f, f"osm_waterways_{cid}.json", box, WATERWAYS)
    return {
        "city": {k: city[k] for k in ("id", "name", "longitude", "latitude")},
        "sites": [{
            "code": x["code"], "name": x["name"], "lat": x["latitude"], "lon": x["longitude"],
            "altitude": None, "polygon": None, "health_risk": None,
            "rain_3d_before_sampling_mm": rain3.get(x["code"]),
            "urban": None} for x in sites],
        "citizen_sites": [], "citizen_sites_in_box": len(citizens), "citizen_box": cbox,
        "dry_weather": dry["per_city"][cid],
        "waterways": {"bbox": list(box), "kinds": WATERWAYS.split("|"), "attribution": rivers.ATTRIBUTION,
                      "features": rivers.waterway_features(osm)},
        "withheld": {"fields": list(WITHHELD),
                     "why": "OneAquaHealth API content is not redistributed until its licence is settled; these "
                            "fields are null or empty here"},
        "source": "Site codes, names and coordinates: OneAquaHealth public API (api.enora-oah.eu), read-only. "
                  "rain_3d_before_sampling_mm and dry_weather: Sayr, derived from that API's daily weather.",
    }


# ---- Toulouse: Hub'Eau river E. coli at Pech David, Garonne -----------------------------------------------
def _auc(pos: list[float], neg: list[float]) -> float | None:
    if not pos or not neg:
        return None
    p, q = np.array(pos)[:, None], np.array(neg)[None, :]
    return float(((p > q).sum() + 0.5 * (p == q).sum()) / (len(pos) * len(neg)))


def toulouse_daily_rain(f: Fetcher) -> dict[str, float]:
    """Open-Meteo archive daily rain at the Toulouse point, 2016-2025 (Europe/Paris days)."""
    lat, lon = TOULOUSE_RAIN_POINT
    om = f.json("openmeteo_archive_toulouse_daily.json",
                f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}"
                "&start_date=2016-01-01&end_date=2025-12-31&daily=precipitation_sum&timezone=Europe%2FParis",
                config.OPEN_METEO)
    return {d: v for d, v in zip(om["daily"]["time"], om["daily"]["precipitation_sum"]) if v is not None}


# Hub'Eau code_remarque -> the qualifier it puts on `resultat` and the record field that holds its bound, for the
# codes the Pech David series uses (their mnemo_remarque: 1 "Résultat > seuil de quantification et < au seuil de
# saturation", 2 "Résultat < seuil de détection"). Any other code stops the build.
HUBEAU_REMARQUE = {"1": ("", None), "2": ("<", "limite_detection")}


def hubeau_qualifier(rows: list[dict[str, Any]]) -> list[tuple[str, float | None, str | None]]:
    """Per Hub'Eau analysis: (qualifier, bound, where the bound comes from). A "<" result records 0 in `resultat`; its
    bound is the record's own limit when it states a positive one, else the series' smallest quantified result
    ("inferred": a laboratory cannot quantify below its detection limit, and the Pech David series moves in the
    steps 15, 30, 46, 61, 77, 94, 110, so 15 is the smallest count it reports)."""
    floor = min((x["resultat"] for x in rows if str(x["code_remarque"]) == "1" and x["resultat"] > 0), default=None)
    out = []
    for x in rows:
        code = str(x["code_remarque"])
        if code not in HUBEAU_REMARQUE:
            raise RuntimeError(f"Hub'Eau {x['date_prelevement']}: code_remarque {code} has no rule")
        op, field = HUBEAU_REMARQUE[code]
        if not op:
            out.append(("", None, None))
        elif field and (x.get(field) or 0) > 0:
            out.append((op, float(x[field]), field))
        elif op == "<" and floor is not None:
            out.append((op, float(floor), "inferred"))
        else:
            raise RuntimeError(f"Hub'Eau {x['date_prelevement']}: qualifier {op} with no bound")
    return out


def toulouse(f: Fetcher) -> dict[str, Any]:
    q = f.json("hubeau_pech_david_ecoli.json",
               "https://hubeau.eaufrance.fr/api/v2/qualite_rivieres/analyse_pc?code_station=BF000002"
               "&code_parametre=1449&size=200", HUBEAU_LICENCE)
    lat, lon = TOULOUSE_RAIN_POINT
    fl = f.json("hubeau_garonne_portet_flow_daily.json",
                "https://hubeau.eaufrance.fr/api/v2/hydrometrie/obs_elab?code_entite=O200001001"
                "&grandeur_hydro_elab=QmnJ&date_debut_obs_elab=2015-12-25&date_fin_obs_elab=2025-12-31&size=20000",
                HUBEAU_LICENCE)
    if q.get("count") != len(q["data"]) or fl.get("next"):
        raise RuntimeError("Hub'Eau response is paged; raise `size` so the whole series is cached")
    rain = toulouse_daily_rain(f)
    flow = {x["date_obs_elab"]: x["resultat_obs_elab"] / 1000.0 for x in fl["data"]}  # l/s -> m3/s
    rows = []
    for x, (op, bound, bsrc) in zip(q["data"], hubeau_qualifier(q["data"])):
        d = dt.date.fromisoformat(x["date_prelevement"])
        prior = [(d - dt.timedelta(days=k)).isoformat() for k in (1, 2, 3)]
        lab = config.label(bound if op else x["resultat"], op)
        if lab is None:
            continue   # the qualifier leaves the label undecided against 900
        rows.append({"date": x["date_prelevement"], "time": x.get("heure_prelevement"),
                     "ecoli_per_100ml": x["resultat"], "over_900": lab, "qualifier": op, "bound_per_100ml": bound,
                     "bound_source": bsrc,
                     "rain_2d_mm": round(sum(rain.get(p, 0.0) for p in prior[:2]), 2),
                     "rain_3d_mm": round(sum(rain.get(p, 0.0) for p in prior), 2),
                     "flow_prev_day_m3s": flow.get(prior[0]), "flow_day_m3s": flow.get(x["date_prelevement"])})
    rows.sort(key=lambda r: r["date"])
    wet = [r for r in rows if r["rain_2d_mm"] >= WET_MM_2D]
    other = [r for r in rows if r["rain_2d_mm"] < WET_MM_2D]
    dry3 = [r for r in rows if r["rain_3d_mm"] < 1]
    ex = [r for r in rows if r["over_900"]]
    no = [r for r in rows if not r["over_900"]]

    def auc(key: str) -> float | None:
        return _auc([r[key] for r in ex if r[key] is not None], [r[key] for r in no if r[key] is not None])

    return {
        "station": PECH_DAVID, "samples": len(rows), "first": rows[0]["date"], "last": rows[-1]["date"],
        "exceed": len(ex),
        "wet_2d_5mm": {"n": len(wet), "exceed": sum(r["over_900"] for r in wet)},
        "otherwise": {"n": len(other), "exceed": sum(r["over_900"] for r in other)},
        "dry_3d_1mm": {"n": len(dry3), "exceed": sum(r["over_900"] for r in dry3)},
        "separation_auc": {"rain_2d": auc("rain_2d_mm"), "rain_3d": auc("rain_3d_mm"),
                           "flow_prev_day": auc("flow_prev_day_m3s"), "flow_day": auc("flow_day_m3s")},
        "flow_days_missing": sum(r["flow_prev_day_m3s"] is None for r in rows),
        "definitions": {
            "wet": "5 mm or more of Open-Meteo archive rain summed over the 2 days before the sample day "
                   "(the sample day excluded)",
            "dry": "less than 1 mm over the 3 days before the sample day",
            "separation_auc": "chance that a sample over 900 has a higher value than a sample at or under 900 "
                              "(0.5 = no separation); reported only, no split tuned on it"},
        "sources": {"ecoli": "Hub'Eau qualite_rivieres (Naiades), " + HUBEAU_LICENCE,
                    "flow": f"Hub'Eau hydrometrie, daily mean flow, {PORTET_FLOW['name']} ({PORTET_FLOW['code']})",
                    "rain": f"Open-Meteo historical archive at {lat}, {lon}, {config.OPEN_METEO}"},
        "rows": rows,
    }
