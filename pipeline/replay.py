"""Storm replay packs for Warleigh Weir: real spills, samples, flow, rain and the river between them."""
from __future__ import annotations

import datetime as dt
from typing import Any

from . import bath, config, model, rivers
from .sources import LONDON, UTC

WINDOWS = {"2024-09-23": ("2024-09-19", "2024-09-27"), "2023-07-10": ("2023-07-08", "2023-07-13")}
REFERENCE_VELOCITIES = (0.25, 0.5, 1.0)


def _utc(d: str, end: bool = False) -> dt.datetime:
    day = dt.date.fromisoformat(d) + dt.timedelta(days=1 if end else 0)
    return dt.datetime.combine(day, dt.time(), LONDON).astimezone(UTC)


def iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def pack(b: bath.Bath, s: model.Site, paths: dict[str, list[int]], key: str) -> dict[str, Any]:
    d0, d1 = WINDOWS[key]
    w0, w1 = _utc(d0), _utc(d1, end=True)
    events: dict[str, list[dict[str, str]]] = {}
    for sp in b.spills:
        if sp.end > w0 and sp.start < w1:
            events.setdefault(model.overflow_key(sp.name), []).append(
                {"site_id": sp.site_id, "start_utc": iso(sp.start), "stop_utc": iso(sp.end),
                 "hours": round((sp.end - sp.start).total_seconds() / 3600, 2)})
    overflows = []
    for k, evs in events.items():
        o = s.overflows[k]
        overflows.append({
            "overflow": k, "name": o.name, "site_ids": o.site_ids, "lat": o.lat, "lon": o.lon,
            "receiving_water": (o.watercourse or "").strip() or None,
            "distance_to_weir_m": round(o.distance_m) if o.distance_m is not None else None,
            "snap_to_river_m": round(o.snap_m) if o.snap_m is not None else None,
            "travel_hours_by_velocity": {f"{v} m/s": round(o.distance_m / v / 3600, 2)
                                         for v in REFERENCE_VELOCITIES} if o.distance_m is not None else None,
            "events": sorted(evs, key=lambda e: e["start_utc"])})
    overflows.sort(key=lambda o: -(o["distance_to_weir_m"] or 0))
    samples = [{"time_utc": iso(x.t), "time_local": x.local, "ecoli_per_100ml": x.ecoli,
                "enterococci_per_100ml": x.enterococci, "over_900": x.over_900}
               for x in b.samples if w0 <= x.t < w1]
    days = [(dt.date.fromisoformat(d0) + dt.timedelta(days=i)).isoformat()
            for i in range((dt.date.fromisoformat(d1) - dt.date.fromisoformat(d0)).days + 1)]
    river = rivers.merge_paths(b.net, [paths[o["overflow"]] for o in overflows if o["overflow"] in paths])
    return {
        "window_local": [d0, d1], "window_utc": [iso(w0), iso(w1)],
        "site": {"name": "Warleigh Weir, River Avon", "lat": config.WARLEIGH[0], "lon": config.WARLEIGH[1]},
        "overflows_spilling": len(overflows), "overflows": overflows, "samples": samples,
        "flow_daily": [{"date": d, "gauge": "Bradford-on-Avon", "m3_per_s": b.flow[d].value if d in b.flow else None,
                        "quality": b.flow[d].quality if d in b.flow else "missing"} for d in days],
        "rain_daily": [{"date": d, "gauge": "Bath Claverton", "mm": b.rain[d].value if d in b.rain else None,
                        "quality": b.rain[d].quality if d in b.rain else "missing"} for d in days],
        "daily_note": "Environment Agency daily values run 09:00 to 09:00 GMT and carry the start date.",
        "river": river,
        "sources": {
            "spills": "Wessex Water Event Duration Monitoring, CC BY 4.0 (times in UTC)",
            "samples": "Wessex Water Environmental Water Quality, CC BY 4.0",
            "flow_rain": "Environment Agency Hydrology API, Open Government Licence v3.0",
            "river": rivers.ATTRIBUTION,
        },
        "note_900": "Over 900 E. coli per 100 ml is a single-sample flag; the EU applies 900 to a 90th percentile.",
    }
