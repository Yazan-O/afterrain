"""Open-Meteo ensemble precipitation forecast (7 days, hourly) for every OneAquaHealth site."""
from __future__ import annotations

import urllib.parse
from typing import Any

import numpy as np

from . import config
from .fetch import Fetcher


def city_forecast(f: Fetcher, cid: str, sites: list[dict[str, Any]]) -> dict[str, Any]:
    q = {"latitude": ",".join(f"{s['latitude']:.5f}" for s in sites),
         "longitude": ",".join(f"{s['longitude']:.5f}" for s in sites),
         "hourly": "precipitation", "models": config.ENSEMBLE_MODEL, "forecast_days": 7, "timezone": "GMT"}
    name = f"openmeteo_ensemble_{cid}.json"
    data = f.json(name, config.OPEN_METEO_ENSEMBLE + "?" + urllib.parse.urlencode(q), config.OPEN_METEO)
    data = data if isinstance(data, list) else [data]
    if len(data) != len(sites):
        raise RuntimeError(f"{name}: {len(data)} forecast locations for {len(sites)} sites")
    out = []
    for s, d in zip(sites, data):
        h = d["hourly"]
        keys = sorted(k for k in h if k.startswith("precipitation"))
        m = np.array([[np.nan if v is None else v for v in h[k]] for k in keys], float)
        days = sorted({t[:10] for t in h["time"]})
        idx = {day: [i for i, t in enumerate(h["time"]) if t.startswith(day)] for day in days}
        daily = np.array([[np.nansum(row[idx[day]]) for day in days] for row in m])
        out.append({
            "code": s["code"], "name": s["name"], "grid_lat": d["latitude"], "grid_lon": d["longitude"],
            "members": len(keys),
            "hourly_members_mm": [[None if np.isnan(v) else round(float(v), 2) for v in row] for row in m],
            "hourly_p10_p50_p90_mm": [[round(float(x), 2) for x in np.nanpercentile(m, p, axis=0)]
                                      for p in (10, 50, 90)] if m.size else [],
            "daily_dates": days,
            "daily_member_totals_mm": [[round(float(v), 1) for v in row] for row in daily],
            "daily_prob_ge_5mm": [round(float((daily[:, j] >= 5).mean()), 3) for j in range(len(days))],
            "daily_prob_ge_10mm": [round(float((daily[:, j] >= 10).mean()), 3) for j in range(len(days))],
        })
    return {"city": cid, "fetched_utc": f.fetched_utc(name), "endpoint": config.OPEN_METEO_ENSEMBLE,
            "model": config.ENSEMBLE_MODEL, "timezone": "UTC", "hourly_times_utc": data[0]["hourly"]["time"],
            "licence": config.OPEN_METEO, "sites": out}
