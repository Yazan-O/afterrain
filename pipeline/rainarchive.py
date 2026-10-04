"""Open-Meteo historical rain at a point: ERA5 hourly (the model's training rain) and best-match daily (dark hours)."""
from __future__ import annotations

import datetime as dt
import math
import urllib.parse
from typing import Sequence

from . import config
from .fetch import Fetcher

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
# ERA5 (0.25 degree, IFS family) is the training rain: the same grid spacing as the ECMWF IFS 0.25 ensemble the
# forecast uses, one model for the whole 2016-2025 record ("best_match" switches to IFS HRES 9 km from 2017).
TRAIN_MODEL = "era5"
WINDOW_H = 48

WARLEIGH_POINT = (51.37705, -2.300635)
PECH_DAVID_POINT = (43.6093, 1.4195)


def hourly(f: Fetcher, name: str, point: tuple[float, float], start: str, end: str) -> dict[dt.datetime, float]:
    """UTC hour stamp -> mm in the hour ending at the stamp (Open-Meteo: 'sum of the preceding hour')."""
    q = {"latitude": f"{point[0]:.5f}", "longitude": f"{point[1]:.5f}", "start_date": start, "end_date": end,
         "hourly": "precipitation", "models": TRAIN_MODEL, "timezone": "GMT"}
    d = f.json(name, ARCHIVE + "?" + urllib.parse.urlencode(q), config.OPEN_METEO)
    h = d["hourly"]
    key = next(k for k in h if k.startswith("precipitation"))
    out = {}
    for t, v in zip(h["time"], h[key]):
        if v is not None:
            out[dt.datetime.fromisoformat(t).replace(tzinfo=dt.timezone.utc)] = float(v)
    if not out:
        raise RuntimeError(f"{name}: no hourly precipitation values")
    return out


def daily_best_match(f: Fetcher, name: str, point: tuple[float, float], start: str, end: str,
                     tz: str) -> dict[str, float]:
    """Local day -> mm, the same request shape as the Toulouse daily file (Open-Meteo default model)."""
    q = {"latitude": f"{point[0]}", "longitude": f"{point[1]}", "start_date": start, "end_date": end,
         "daily": "precipitation_sum", "timezone": tz}
    d = f.json(name, ARCHIVE + "?" + urllib.parse.urlencode(q), config.OPEN_METEO)
    return {t: v for t, v in zip(d["daily"]["time"], d["daily"]["precipitation_sum"]) if v is not None}


def r48(series: dict[dt.datetime, float], t: dt.datetime) -> float:
    """Rain (mm) in the 48 hourly stamps ending at t floored to the UTC hour: the window (t_h - 48 h, t_h].
    A missing hour fails loudly."""
    th = t.astimezone(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    total = 0.0
    for k in range(WINDOW_H):
        s = th - dt.timedelta(hours=k)
        if s not in series:
            raise KeyError(f"no archive rain at {s.isoformat()}")
        total += series[s]
    return total


def x_of(r48_mm: float) -> float:
    """The model's rain input: ln(1 + r48)."""
    return math.log1p(max(r48_mm, 0.0))


def rolling_r48(values: Sequence[float | None]) -> list[float | None]:
    """r48 at every index i >= 47 of an hourly series (None when any of the 48 values is missing)."""
    out: list[float | None] = [None] * len(values)
    for i in range(WINDOW_H - 1, len(values)):
        w = values[i - WINDOW_H + 1:i + 1]
        out[i] = None if any(v is None for v in w) else float(sum(w))  # type: ignore[arg-type]
    return out
