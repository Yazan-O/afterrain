"""python -m pipeline nowcast [--offline]: hourly risk, fog, states and quests for every OneAquaHealth site.

PRE-REGISTERED CHANGE to the quest objective (2026-09-26, written before any quest was computed under it; the
text in pipeline/offsets.py and the tie-break amendment in pipeline/upstream.py are left as written)
------------------------------------------------------------------------------------------------------------
Why. The old score (expected drop in mean fog over the 72 h after the first hour) weighs every hour alike, so
  storm hours beyond 72 h do not count and a dry sampling day can win (Coimbra's quest fell on a dry Monday).
What changes. The sampling hour still lies in the first 72 h at local 08:00-19:00, and the count still enters
  through the member-median x at that hour. A site's score for a sampling hour is now the expected fog reduction
  SUMMED over its benefit hours: sum over h in B of (fog_h before - E[fog_h after one count]), same preposterior.
  B = every hour of the whole forecast (first hour to the last hour with >= MIN_MEMBERS members) whose best-guess
  state is higher or high, i.e. p50 >= T_higher at the site's current offset, ignoring the fog override to
  'unknown' (these are the hours where a warning would matter). If no site in the city has such an hour, B = all
  those forecast hours for every site. A site with an empty B in a city that has such hours scores nothing and
  posts no quest.
Unchanged. The window rule (contiguous same-day sampling hours scoring >= 0.8 of the best), the tie-break by
  upstream length, the spread across reaches, 3 quests per city, and the citizen update math.

SECOND DATED CHANGE: the sampling window is the whole forecast horizon (2026-09-27; the 2026-09-26 text above is
left as written)
------------------------------------------------------------------------------------------------------------
Why. Sayr's promise is "Sayr watches the storms". What no site has measured is its response to rain (the offset b
  on the rain input), and only a sample taken in or just after rain can inform it; a dry-day count mostly informs
  the dry-day level a. A citizen can plan a sample days ahead, so a 72 h cap on the sampling hour only pushed quests
  onto the dry days before the rain.
What changes. A sampling hour may be any forecast hour (first hour to the last hour with >= MIN_MEMBERS members,
  except the very last, whose window rain cannot be summed) at local 08:00-19:00. The objective (expected fog
  reduction summed over the benefit hours B), the window rule, the tie-break and the spread are unchanged.
  fog_72h_mean_before / _after_expected keep their meaning: the mean fog over the first 72 hours.
New quest fields.
  window_rain_mm_p50: member-median rain falling inside the window (the same number as rain_window_mm_p50).
  rain_48h_to_window_end_mm_p50: member-median r48 at the window's end, i.e. the rain over the 48 h ending there.
  after_rain: rain_48h_to_window_end_mm_p50 >= oah.WET_MM_2D (numbers.json thresholds.wet_mm_2d, 5 mm): the
    window lies in or just after rain.
  tied_with: codes of the city's other quests whose score equals this one's within upstream.TIE_EPS (1e-9).
  when_local: the window's local weekday and part of day, morning 08-11, afternoon 12-16, evening 17-19
    ("Wednesday afternoon"; "Wednesday morning to afternoon" when it spans parts; "Wednesday daytime" for all
    three).

THIRD DATED CHANGE: only hours after the result is back count (2026-10-02; the texts above are left as written)
------------------------------------------------------------------------------------------------------------
Why. The score summed the fog reduction over every benefit hour, including hours before the sample was taken
  (Ghent's quest was credited 44 hours, 26 of them before its sampling hour). A count cannot sharpen a warning
  for an hour that has passed before its result exists.
What changes. For a sampling hour t, the credited hours are the benefit hours at or after t + LAB_TURNAROUND_H
  (pipeline/config.py, 24 h for a culture-based E. coli count). Score = sum over credited h of (fog_h before -
  E[fog_h after one count]). A sampling hour with no credited hour is not a candidate. The objective's name is
  "expected fog reduction" (not an information gain). The window rule, the tie-break by upstream length and the
  spread are unchanged.
Fields. benefit_hours = the credited hours of the chosen sampling hour; benefit_hours_in_forecast = all benefit
  hours; fog_benefit_mean_* = means over the credited hours; lab_turnaround_h; result_ready_utc = best hour + it.

FOURTH DATED CHANGE: later requests from the remaining forecast hours (2026-10-03)
------------------------------------------------------------------------------------
Why. The forecast refreshes once a day, but its quests' windows can all close before the forecast ends (Ghent,
  Oslo and Toulouse's closed on the first afternoon of the 2 Oct forecast); the app then had a live forecast and no
  request to show.
What changes. `quests` is unchanged. `later_quests` adds one round per local midnight after the first forecast hour:
  the same scores, window rule, tie-break and spread, with the sampling hour restricted to hours at or after that
  midnight. The app shows the saved quests while one is open, then the round that starts latest at or before the
  clock, then later rounds.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import urllib.parse
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

from . import config, darkhours, oah, offsets, rainarchive, upstream
from .fetch import Fetcher, MissingInput

CITY_TZ = {"BE": "Europe/Rome", "CO": "Europe/Lisbon", "GH": "Europe/Brussels", "OS": "Europe/Oslo",
           "TO": "Europe/Paris"}
PAST_DAYS = 2        # 48 h of recent rain so the first hour has a full r48 window
FORECAST_DAYS = 7
MIN_MEMBERS = 26     # an hour needs a complete 48 h window in over half of the 51 members


def params_from_spec(spec: dict[str, Any]) -> offsets.Params:
    q = spec["params"]
    return offsets.Params(q["alpha"], q["beta"], q["tau_a"], q["tau_b"], q["s"], q["t_higher"], q["t_high"],
                          q["fog_unknown"])


# The algorithm behind a number, beside its parameters: a definition change gets a new model id (2026-10-02).
ALGORITHM = {"probability": "posterior predictive over the offset grid (pipeline/offsets.py, 2026-10-02)",
             "quest": "expected fog reduction over warning hours at or after sampling + lab turnaround",
             "lab_turnaround_h": config.LAB_TURNAROUND_H}


def model_version(p: offsets.Params) -> str:
    blob = json.dumps({"params": p.__dict__, "algorithm": ALGORITHM}, sort_keys=True).encode()
    return "sayr-city-2:" + hashlib.sha256(blob).hexdigest()[:10]


def fetch_city(f: Fetcher, cid: str, sites: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    q = {"latitude": ",".join(f"{s['latitude']:.5f}" for s in sites),
         "longitude": ",".join(f"{s['longitude']:.5f}" for s in sites),
         "hourly": "precipitation", "models": config.ENSEMBLE_MODEL, "past_days": PAST_DAYS,
         "forecast_days": FORECAST_DAYS, "timezone": "GMT"}
    name = f"openmeteo_nowcast_{cid}.json"
    data = f.json(name, config.OPEN_METEO_ENSEMBLE + "?" + urllib.parse.urlencode(q), config.OPEN_METEO)
    data = data if isinstance(data, list) else [data]
    if len(data) != len(sites):
        raise RuntimeError(f"{name}: {len(data)} forecast locations for {len(sites)} sites")
    fetched = f.fetched_utc(name)
    if not fetched:
        raise MissingInput(f"{name}: no fetch time in the manifest")
    return data, fetched


def member_x(d: dict[str, Any]) -> tuple[list[dt.datetime], np.ndarray, np.ndarray]:
    """Hour stamps (UTC), members' r48 (M, T) and x = ln(1 + r48) (NaN where the 48 h window is incomplete)."""
    h = d["hourly"]
    times = [dt.datetime.fromisoformat(t).replace(tzinfo=dt.timezone.utc) for t in h["time"]]
    keys = sorted(k for k in h if k.startswith("precipitation"))
    r = np.array([[np.nan if v is None else v for v in rainarchive.rolling_r48(h[k])] for k in keys], float)
    return times, r, np.log1p(r)


def member_rain(d: dict[str, Any]) -> np.ndarray:
    """Members' hourly rain (M, T) in mm, NaN where missing; same member order as member_x."""
    h = d["hourly"]
    keys = sorted(k for k in h if k.startswith("precipitation"))
    return np.array([[np.nan if v is None else v for v in h[k]] for k in keys], float)


def oah_sample_rain(dark: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Per site, its OneAquaHealth sampling date and 3-day prior rain, from the rows of dark_hours.json (the rows
    behind 80 of 96). After rain = rain_3d >= thresholds.dry_mm_3d, the complement of 'dry'."""
    out: dict[str, dict[str, Any]] = {}
    for r in dark["oneaquahealth"]:
        if r["site"] in out:
            raise RuntimeError(f"dark_hours.json: two OneAquaHealth samples at site {r['site']}")
        r3 = r["rain_3d_mm"]
        out[r["site"]] = {"oah_sample_date": r["date"], "oah_sample_rain_3d_mm": r3,
                          "oah_sampled_after_rain": None if r3 is None else r3 >= darkhours.DRY_MM}
    return out


def site_hours(p: offsets.Params, m: offsets.Moments, w: np.ndarray, X: np.ndarray, R: np.ndarray,
               idx: list[int]) -> dict[str, Any]:
    out: dict[str, list[Any]] = {k: [] for k in ("p10", "p50", "p90", "fog", "fog_rain", "fog_local", "state",
                                                 "r48_p50_mm", "r48_p90_mm", "members")}
    for i in idx:
        col = X[:, i]
        ok = ~np.isnan(col)
        if ok.sum() < MIN_MEMBERS:
            for k in out:
                out[k].append(None)
            continue
        s = offsets.hour_summary(p, m, col[ok], w)
        rr = np.sort(R[ok, i])
        for k in ("p10", "p50", "p90", "fog", "fog_rain", "fog_local"):
            out[k].append(round(s[k], 4))
        out["state"].append(s["state"])
        out["r48_p50_mm"].append(round(float(offsets.quantile_sorted(rr, 0.5)), 2))
        out["r48_p90_mm"].append(round(float(offsets.quantile_sorted(rr, 0.9)), 2))
        out["members"].append(int(ok.sum()))
    return out


def forecast_hours(X: np.ndarray, idx: list[int]) -> list[int]:
    """The whole forecast from the first hour: every hour with a complete 48 h window in >= MIN_MEMBERS members."""
    return [i for i in idx if (~np.isnan(X[:, i])).sum() >= MIN_MEMBERS]


def warning_hours(p: offsets.Params, m: offsets.Moments, w: np.ndarray, X: np.ndarray, hrs: list[int]) -> list[int]:
    """Hours whose best-guess state is higher or high: p50 >= T_higher, the fog override to 'unknown' ignored."""
    return [i for i in hrs if offsets.hour_summary(p, m, X[~np.isnan(X[:, i]), i], w)["p50"] >= p.t_higher]


PARTS = ((8, 11, "morning"), (12, 16, "afternoon"), (17, 19, "evening"))
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def when_local(t0: dt.datetime, t1: dt.datetime, tz: ZoneInfo) -> str:
    """The window [t0, t1) as local weekday + part of day (the 2026-09-27 text in this module's docstring)."""
    a, b = t0.astimezone(tz), (t1 - dt.timedelta(hours=1)).astimezone(tz)
    parts = [name for lo, hi, name in PARTS if a.hour <= hi and b.hour >= lo]
    if not parts:
        raise RuntimeError(f"quest window {a:%H:%M}-{b:%H:%M} lies outside the sampling hours")
    part = "daytime" if len(parts) == len(PARTS) else parts[0] if len(parts) == 1 else f"{parts[0]} to {parts[-1]}"
    return f"{WEEKDAYS[a.weekday()]} {part}"


def site_quest(p: offsets.Params, lw: np.ndarray, X: np.ndarray, R: np.ndarray, hours: list[dt.datetime],
               idx: list[int], tz: ZoneInfo, benefit: list[int], basis: str, rain: np.ndarray,
               wet_mm: float) -> dict[str, Any] | None:
    """Best sampling hour over the whole forecast at one site: the expected fog reduction summed over the benefit
    hours (the 2026-09-26 objective and the 2026-09-27 window in this module's docstring).
    R = members' r48 (M, T), rain = members' hourly rain (M, T), wet_mm = the in/after-rain threshold."""
    return site_quests(p, lw, X, R, hours, idx, tz, benefit, basis, rain, wet_mm, [None])[0]


def site_quests(p: offsets.Params, lw: np.ndarray, X: np.ndarray, R: np.ndarray, hours: list[dt.datetime],
                idx: list[int], tz: ZoneInfo, benefit: list[int], basis: str, rain: np.ndarray,
                wet_mm: float, cuts: list[dt.datetime | None]) -> list[dict[str, Any] | None]:
    """site_quest once per cut: the same scores, with the sampling hour restricted to hours at or after the cut
    (None = no restriction). The FOURTH DATED CHANGE in this module's docstring says why."""
    hz = [i for i in forecast_hours(X, idx) if i + 1 < len(hours)]
    h72 = [i for i in hz if i in set(idx[:offsets.HORIZON_H])]          # the first 72 h (fog_72h_* fields)
    if not hz or not h72 or not benefit:
        return [None] * len(cuts)
    # Members with a complete window at every sampling and benefit hour (sorted per hour for quantiles).
    full = ~np.isnan(X[:, sorted(set(hz) | set(benefit))]).any(axis=1)
    if full.sum() < MIN_MEMBERS:
        raise RuntimeError("fewer than 26 members cover the sampling hours and the benefit hours")
    Xh = np.sort(X[full][:, hz].T, axis=1)                                        # (H, M)
    xt = offsets.quantile_sorted(Xh, 0.5)
    X72 = np.sort(X[full][:, h72].T, axis=1)
    xt72 = offsets.quantile_sorted(X72, 0.5)
    Xb = np.sort(X[full][:, benefit].T, axis=1)                                   # (B, M)
    xtb = offsets.quantile_sorted(Xb, 0.5)
    m0 = offsets.moments(p, lw)
    W0, ms0 = offsets.moments_many(p, lw)
    before = float(offsets.mean_fog_many(p, W0, ms0, X72, xt72)[0])
    fog_b0 = offsets.fog_many(p, W0, ms0, Xb, xtb)[0]                             # (B,) fog before, per hour
    t_benefit = np.array([hours[j].timestamp() for j in benefit])
    scores = {}
    for h_pos, i in enumerate(hz):
        loc = hours[i].astimezone(tz)
        if not offsets.SAMPLE_HOURS[0] <= loc.hour <= offsets.SAMPLE_HOURS[1]:
            continue
        # Only benefit hours at or after the result is back (sample hour + lab turnaround) can use the count
        # (the 2026-10-02 change in this module's docstring).
        credited = t_benefit >= hours[i].timestamp() + config.LAB_TURNAROUND_H * 3600
        if not credited.any():
            continue
        pp = offsets.preposterior(p, lw, float(xt[h_pos]), X72, xt72)
        fog_b1 = pp["q"] @ offsets.fog_many(p, pp["post"], pp["ms"], Xb, xtb)       # (B,) expected fog after
        # expected fog at the sampled hour itself after the count
        at = offsets.mean_fog_many(p, pp["post"], pp["ms"], Xh[h_pos:h_pos + 1], xt[h_pos:h_pos + 1])
        scores[h_pos] = {"reduction": float((fog_b0 - fog_b1)[credited].sum()),
                         "credited": int(credited.sum()), "before_b": float(fog_b0[credited].mean()),
                         "after_b": float(fog_b1[credited].mean()),
                         "after": pp["expected_mean_fog_after"], "at_after": float(pp["q"] @ at)}
    return [_pick(p, m0, W0, hz, Xh, xt, R, hours, tz, rain, wet_mm, before, len(benefit), basis,
                  {k: v for k, v in scores.items() if c is None or hours[hz[k]] >= c}) for c in cuts]


def _pick(p: offsets.Params, m0: offsets.Moments, W0: np.ndarray, hz: list[int], Xh: np.ndarray, xt: np.ndarray,
          R: np.ndarray, hours: list[dt.datetime], tz: ZoneInfo, rain: np.ndarray, wet_mm: float, before: float,
          n_benefit: int, basis: str, scores: dict[int, dict[str, Any]]) -> dict[str, Any] | None:
    """The best sampling hour among `scores` (position in hz -> score), its window and the quest's fields."""
    if not scores:
        return None
    best = max(scores, key=lambda k: (scores[k]["reduction"], -k))
    top = scores[best]["reduction"]
    day = hours[hz[best]].astimezone(tz).date()
    lo = hi = best
    while lo - 1 in scores and hours[hz[lo - 1]].astimezone(tz).date() == day and \
            scores[lo - 1]["reduction"] >= offsets.WINDOW_FRAC * top:
        lo -= 1
    while hi + 1 in scores and hours[hz[hi + 1]].astimezone(tz).date() == day and \
            scores[hi + 1]["reduction"] >= offsets.WINDOW_FRAC * top:
        hi += 1
    s_best = offsets.hour_summary(p, m0, Xh[best], W0[0])
    t0, t1 = hours[hz[lo]], hours[hz[hi]] + dt.timedelta(hours=1)
    # Rain falling inside [t0, t1): each stamp holds the preceding hour's rain, so stamps hz[lo]+1 .. hz[hi]+1.
    win = rain[:, hz[lo] + 1:hz[hi] + 2]
    if win.shape[1] != hz[hi] - hz[lo] + 1:
        raise RuntimeError("the quest window runs past the forecast's last hour")
    win = np.sort(win[~np.isnan(win).any(axis=1)].sum(axis=1))
    if len(win) < MIN_MEMBERS:
        raise RuntimeError("fewer than 26 members cover the quest window's rain")
    # r48 at the window's end stamp = the rain over the 48 h ending at the window's end.
    r_end = R[:, hz[hi] + 1]
    r_end = np.sort(r_end[~np.isnan(r_end)])
    if len(r_end) < MIN_MEMBERS:
        raise RuntimeError("fewer than 26 members cover the 48 h before the quest window's end")
    r48_end = round(float(offsets.quantile_sorted(r_end, 0.5)), 2)
    rain_p50 = round(float(offsets.quantile_sorted(win, 0.5)), 2)
    return {"best_hour_utc": _z(hours[hz[best]]), "best_hour_local": _loc(hours[hz[best]], tz),
            "window_start_local": _loc(t0, tz), "window_end_local": _loc(t1, tz),
            "window_start_utc": _z(t0), "window_end_utc": _z(t1), "when_local": when_local(t0, t1, tz),
            "rain_window_mm_p50": rain_p50,
            "rain_window_mm_p90": round(float(offsets.quantile_sorted(win, 0.9)), 2),
            "window_rain_mm_p50": rain_p50, "rain_48h_to_window_end_mm_p50": r48_end,
            "after_rain": r48_end >= wet_mm,
            "fog_72h_mean_before": round(before, 4), "fog_72h_mean_after_expected": round(scores[best]["after"], 4),
            "benefit_hours": scores[best]["credited"], "benefit_hours_in_forecast": n_benefit,
            "benefit_basis": basis, "lab_turnaround_h": config.LAB_TURNAROUND_H,
            "result_ready_utc": _z(hours[hz[best]] + dt.timedelta(hours=config.LAB_TURNAROUND_H)),
            "fog_benefit_mean_before": round(scores[best]["before_b"], 4),
            "fog_benefit_mean_after_expected": round(scores[best]["after_b"], 4),
            "fog_reduction_expected": round(top, 4),
            "fog_at_hour_before": round(s_best["fog"], 4),
            "fog_at_hour_after_expected": round(scores[best]["at_after"], 4),
            "p50_at_hour": round(s_best["p50"], 4), "state_at_hour": s_best["state"],
            "r48_median_mm_at_hour": round(float(np.expm1(xt[best])), 2),
            "_score": top}


def _z(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _loc(t: dt.datetime, tz: ZoneInfo) -> str:
    return t.astimezone(tz).strftime("%Y-%m-%dT%H:%M%z")


def load_dark_hours() -> dict[str, Any]:
    pth = config.OUT / "dark_hours.json"
    if not pth.exists():
        raise MissingInput(f"{pth.name}: not built yet; run `python -m pipeline build` first")
    return json.loads(pth.read_text(encoding="utf-8"))


def city(f: Fetcher, p: offsets.Params, cid: str, sites: list[dict[str, Any]], version: str,
         waterways: list[dict[str, Any]], sampled: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    tz = ZoneInfo(CITY_TZ[cid])
    sampled = oah_sample_rain(load_dark_hours()) if sampled is None else sampled
    no_sample = {"oah_sample_date": None, "oah_sample_rain_3d_mm": None, "oah_sampled_after_rain": None}
    data, fetched = fetch_city(f, cid, sites)
    now = dt.datetime.fromisoformat(fetched.replace("Z", "+00:00")).replace(minute=0, second=0)
    lw = offsets.prior(p)          # no OneAquaHealth site has an E. coli count in the public API: all start at the prior
    m0 = offsets.moments(p, lw)
    w0 = offsets.weights(lw)
    out_sites, times_ref = [], None
    net = upstream.StreamNet(waterways)
    # Pass 1: hour stamps, the whole forecast, and each forecast cell's warning hours (the benefit hours).
    cells: dict[str, dict[str, Any]] = {}
    keys = []
    for d in data:
        times, R, X = member_x(d)
        idx = [i for i, t in enumerate(times) if t >= now]
        if times_ref is None:
            times_ref = [times[i] for i in idx]
        elif [times[i] for i in idx] != times_ref:
            raise RuntimeError(f"{cid}: hour stamps differ between sites")
        # Sites in the same forecast cell get identical rain; with the same (prior) offset their results are equal.
        key = json.dumps(d["hourly"], sort_keys=True)
        keys.append(key)
        if key not in cells:
            hrs = forecast_hours(X, idx)
            cells[key] = {"times": times, "R": R, "X": X, "idx": idx, "all": hrs, "warn": warning_hours(p, m0, w0, X, hrs),
                          "rain": member_rain(d)}
    basis = "higher or high" if any(c["warn"] for c in cells.values()) else "all forecast hours"
    assert times_ref is not None
    # Later rounds start at each local midnight after the first forecast hour (FOURTH DATED CHANGE).
    cuts: list[dt.datetime | None] = [None]
    day = times_ref[0].astimezone(tz).date() + dt.timedelta(days=1)
    while True:
        c = dt.datetime.combine(day, dt.time(), tz).astimezone(dt.timezone.utc)
        if c > times_ref[-1]:
            break
        cuts.append(c)
        day += dt.timedelta(days=1)
    rounds: list[list[dict[str, Any]]] = [[] for _ in cuts]
    cache: dict[str, tuple[dict[str, Any], list[dict[str, Any] | None]]] = {}
    for s, d, key in zip(sites, data, keys):
        if key not in cache:
            c = cells[key]
            benefit = c["warn"] if basis == "higher or high" else c["all"]
            cache[key] = (site_hours(p, m0, w0, c["X"], c["R"], c["idx"]),
                          site_quests(p, lw, c["X"], c["R"], c["times"], c["idx"], tz, benefit, basis, c["rain"],
                                      oah.WET_MM_2D, cuts))
        hrs, qs = cache[key]
        up = net.site(s["latitude"], s["longitude"])
        out_sites.append({"code": s["code"], "name": s["name"], "lat": s["latitude"], "lon": s["longitude"],
                          "grid_lat": d["latitude"], "grid_lon": d["longitude"], "offset": "prior (no local counts)",
                          **sampled.get(s["code"], no_sample), **up, **hrs})
        for k, q in enumerate(qs):
            if q:
                rounds[k].append({"code": s["code"], "name": s["name"], **q, **up})
    # Ties on fog reduction break by upstream stream length, then spread across reaches (pipeline/upstream.py).
    top, *later = [_select(r) for r in rounds]
    later_quests = [{"from_utc": _z(c), "from_local": _loc(c, tz), "quests": r} for c, r in zip(cuts[1:], later) if r]
    return {"city": cid, "timezone": CITY_TZ[cid], "model_version": version, "forecast_fetched_utc": fetched,
            "first_hour_utc": _z(times_ref[0]), "hours_utc": [_z(t) for t in times_ref],
            "hours_local": [_loc(t, tz) for t in times_ref],
            "quests": top, "later_quests": later_quests, "sites": out_sites, "grid_cells": upstream.grid_cells(out_sites),
            "states": ["usual", "higher", "high", "unknown"],
            "thresholds": {"higher": p.t_higher, "high": p.t_high, "unknown_fog": p.fog_unknown},
            "meaning": {"p50": "median over ensemble members of the chance one sample is over 900 E. coli per "
                               "100 ml (a single-sample flag; the EU applies 900 to a 90th percentile); the chance "
                               "is averaged over the site's offset posterior (posterior predictive)",
                        "p10_p90": "10th and 90th percentile of that chance across the 51 rain members",
                        "fog": "min(1, sqrt(fog_rain^2 + fog_local^2)); see update_spec.json",
                        "quest": "the site and hour anywhere in the forecast (local 08:00-19:00) with the largest "
                                 "expected fog reduction from one E. coli count, summed over the forecast hours "
                                 "whose best-guess state is higher or high (all forecast hours if the city has none; "
                                 "benefit_basis says which) that fall at or after the result is back (sampling hour "
                                 f"+ {config.LAB_TURNAROUND_H} h lab turnaround, result_ready_utc); equal scores "
                                 "break toward more upstream stream length, and tied quests go on different reaches "
                                 "where possible",
                        "fog_72h_mean": "mean fog over the first 72 forecast hours, before and expected after "
                                        "the quest's count",
                        "rain_window_mm": "rain forecast to fall inside the quest window, median (p50) and "
                                          "90th percentile (p90) over the ensemble members; window_rain_mm_p50 "
                                          "is the same median",
                        "after_rain": "the member-median rain over the 48 h ending at the quest window's end "
                                      f"(rain_48h_to_window_end_mm_p50) is {oah.WET_MM_2D:g} mm or more "
                                      "(thresholds.wet_mm_2d): the window lies in or just after rain",
                        "later_quests": "one round per local midnight after the first forecast hour: the quests "
                                        "chosen by the same rule from sampling hours at or after from_utc (the app "
                                        "uses them once every saved quest's window has closed)",
                        "tied_with": "the city's other quests with the same score (within 1e-9); tied_sites "
                                     "lists every tied candidate site",
                        "when_local": "the window's local weekday and part of day (morning 08-11, afternoon "
                                      "12-16, evening 17-19)",
                        "oah_sampled_after_rain": "the site's OneAquaHealth sample followed 1 mm or more of rain "
                                                  "in the 3 days before (dark_hours.json); null = no sample",
                        "upstream_km": "km of OpenStreetMap waterway draining to the site's snapped point "
                                       f"(within {upstream.SNAP_M:.0f} m; 0 and snapped=false otherwise), "
                                       "inside the city pack's waterway extract",
                        "grid_cells": "sites per 0.25 degree forecast cell: sites in one cell share one rain "
                                      "forecast"},
            "source": "Open-Meteo ECMWF IFS 0.25 ensemble (CC BY 4.0); OneAquaHealth sites (read-only API)"}


def _select(quests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The city's quests from its candidates: upstream.select, the tie fields, the private score dropped."""
    top = upstream.select(quests)
    for q in top:
        q["tied_sites"] = sorted(o["code"] for o in quests
                                 if o is not q and abs(o["_score"] - q["_score"]) < upstream.TIE_EPS)
        q["tied_with"] = [o["code"] for o in top if o is not q and abs(o["_score"] - q["_score"]) < upstream.TIE_EPS]
    return [{k: v for k, v in q.items() if k != "_score"} for q in top]


def run(f: Fetcher, spec: dict[str, Any], sites_all: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    p = params_from_spec(spec)
    version = model_version(p)
    sampled = oah_sample_rain(load_dark_hours())
    packs = {}
    for cid in config.OAH_CITIES:
        sites = [s for s in sites_all if s["city"]["id"] == cid]
        pack = config.OUT / f"city_{cid}.json"
        if not pack.exists():
            raise MissingInput(f"{pack.name}: not built yet; run `python -m pipeline build` first")
        ww = json.loads(pack.read_text(encoding="utf-8"))["waterways"]["features"]
        packs[cid] = city(f, p, cid, sites, version, ww, sampled)
    return packs


LABELS = {"fog_reduction_expected": "expected fog reduction (the quest objective), summed over the credited hours",
          "benefit_hours": "credited hours: higher-or-high hours at or after the result is back",
          "benefit_hours_in_forecast": "higher-or-high hours in the whole forecast",
          "fog_benefit_mean_before": "mean fog over the credited hours before the count",
          "fog_benefit_mean_after_expected": "expected mean fog over the credited hours after the count",
          "lab_turnaround_h": "hours from sampling to the E. coli result (pipeline/config.py)",
          "result_ready_utc": "best sampling hour + lab turnaround (UTC)"}


def numbers(num: Any, packs: dict[str, dict[str, Any]]) -> None:
    for cid, pk in packs.items():
        src = [f"data/raw/openmeteo_nowcast_{cid}.json", "data/out/update_spec.json"]
        fn = "pipeline.nowcast.city"
        num.add(f"nowcast.{cid}.fetched_utc", pk["forecast_fetched_utc"], "ensemble forecast download time (UTC)",
                src, fn)
        num.add(f"nowcast.{cid}.forecast_end_utc", pk["hours_utc"][-1], "last forecast hour in the nowcast (UTC)",
                src, fn)
        states = [s for site in pk["sites"] for s in site["state"] if s]
        num.add(f"nowcast.{cid}.site_hours", len(states), "site-hours in the nowcast", src, fn)
        for st in pk["states"]:
            num.add(f"nowcast.{cid}.state.{st}", sum(s == st for s in states), f"site-hours in state '{st}'", src, fn)
        fogs = [x for site in pk["sites"] for x in site["fog"] if x is not None]
        num.add(f"nowcast.{cid}.fog_min", min(fogs), "lowest fog over all site-hours", src, fn)
        num.add(f"nowcast.{cid}.fog_max", max(fogs), "highest fog over all site-hours", src, fn)
        p50 = [(x, site["code"], pk["hours_local"][i]) for site in pk["sites"] for i, x in enumerate(site["p50"])
               if x is not None]
        top = max(p50)
        num.add(f"nowcast.{cid}.p50_max", top[0], f"highest median chance over 900 ({top[1]}, {top[2]})", src, fn)
        num.add(f"nowcast.{cid}.grid_cells", len(pk["grid_cells"]), "forecast grid cells holding the city's sites",
                src, fn)
        num.add(f"nowcast.{cid}.largest_grid_cell_sites", pk["grid_cells"][0]["sites"],
                "sites in the city's most shared forecast grid cell", src, fn)
        usrc = [f"data/out/city_{cid}.json"]
        num.add(f"nowcast.{cid}.sites_snapped", sum(s["snapped"] for s in pk["sites"]),
                f"sites within {upstream.SNAP_M:.0f} m of an OpenStreetMap waterway", usrc,
                "pipeline.upstream.StreamNet")
        for k, q in enumerate(pk["quests"], 1):
            for fld in ("code", "window_start_local", "window_end_local", "fog_72h_mean_before",
                        "fog_72h_mean_after_expected", "fog_at_hour_before", "fog_at_hour_after_expected",
                        "upstream_km", "chosen_by", "rain_window_mm_p50", "rain_window_mm_p90", "benefit_hours",
                        "fog_benefit_mean_before", "fog_benefit_mean_after_expected", "fog_reduction_expected",
                        "when_local", "window_rain_mm_p50", "rain_48h_to_window_end_mm_p50",
                        "benefit_hours_in_forecast", "lab_turnaround_h", "result_ready_utc", "best_hour_local"):
                label = LABELS.get(fld, fld.replace('_', ' '))
                num.add(f"nowcast.{cid}.quest{k}.{fld}", q[fld], f"quest {k}: {label}", src,
                        "pipeline.nowcast.site_quest")
        for r, rnd in enumerate(pk.get("later_quests", []), 1):
            num.add(f"nowcast.{cid}.later{r}.from_utc", rnd["from_utc"],
                    f"later round {r}: sampling hours from this instant (UTC)", src, "pipeline.nowcast.city")
            for k, q in enumerate(rnd["quests"], 1):
                for fld in ("code", "window_start_local", "window_end_local", "fog_reduction_expected", "when_local"):
                    num.add(f"nowcast.{cid}.later{r}.quest{k}.{fld}", q[fld],
                            f"later round {r}, quest {k}: {LABELS.get(fld, fld.replace('_', ' '))}", src,
                            "pipeline.nowcast.site_quests")
