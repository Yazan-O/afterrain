"""The Warleigh Weir warning-rule backtest (fixed thresholds, 48 h before each sample)."""
from __future__ import annotations

import datetime as dt
import statistics as st
from dataclasses import dataclass
from typing import Callable

from . import config
from .sources import LONDON, DailySeries, Sample, Spill, complete_day


@dataclass(frozen=True)
class Joined:
    sample: Sample
    hours_all: float        # upstream spill hours overlapping the 48 h before the sample
    hours_near: float       # the same, nine near-field overflows only
    hours_freshford: float  # the same, Freshford storm tank only
    rain_2d: float          # gauge rain in the two latest gauge days finished by the sample (missing = 0)
    flow_prev: float | None # gauge mean flow in the latest gauge day finished by the sample

    @property
    def exceed(self) -> bool:
        return bool(self.sample.over_900)   # join() keeps only samples whose label is decided


def is_near(name: str) -> bool:
    return any(name.upper().startswith(k) for k in config.NEAR_FIELD)


def is_freshford(name: str) -> bool:
    return name.upper().startswith(config.FRESHFORD)


def overlap_hours(spills: list[Spill], t0: dt.datetime, t1: dt.datetime) -> float:
    return sum((min(s.end, t1) - max(s.start, t0)).total_seconds() / 3600 for s in spills
               if s.end > t0 and s.start < t1)


def rain_2d(rain: DailySeries, t: dt.datetime) -> float:
    """Gauge rain over the two latest gauge days (09:00-09:00 GMT) that finished at or before t."""
    return sum((rain[d].value or 0.0) if d in rain else 0.0
               for d in (complete_day(rain, t, 1), complete_day(rain, t, 2)))


def flow_prev(flow: DailySeries, t: dt.datetime) -> float | None:
    """Gauge mean flow over the latest gauge day (09:00-09:00 GMT) that finished at or before t."""
    d = flow.get(complete_day(flow, t, 1))
    return d.value if d else None


def join(samples: list[Sample], spills: list[Spill], rain: dict[str, Daily],
         flow: dict[str, Daily]) -> list[Joined]:
    """One row per E. coli sample inside the spill-log period, in publication order. A sample whose laboratory
    qualifier leaves it undecided against the flag ("< 1000") is left out: it has no label to score."""
    first = min(s.start for s in spills)
    near = [s for s in spills if is_near(s.name)]
    fresh = [s for s in spills if is_freshford(s.name)]
    out = []
    for smp in samples:
        if smp.t < first or smp.over_900 is None:
            continue
        w0 = smp.t - dt.timedelta(hours=config.WINDOW_H)
        out.append(Joined(smp, overlap_hours(spills, w0, smp.t), overlap_hours(near, w0, smp.t),
                          overlap_hours(fresh, w0, smp.t), rain_2d(rain, smp.t), flow_prev(flow, smp.t)))
    return out


Rule = Callable[[Joined], bool]
RULES: dict[str, tuple[str, Rule]] = {
    "freshford": ("Freshford storm tank spilled", lambda j: j.hours_freshford > 0),
    "near_field": ("Any of 9 near-field overflows spilled", lambda j: j.hours_near > 0),
    "any_upstream": ("Any upstream overflow spilled", lambda j: j.hours_all > 0),
    "rain": ("Rain >= 10 mm in the 2 gauge days before", lambda j: j.rain_2d >= 10),
    "flow": ("Flow >= 15 m3/s the gauge day before", lambda j: (j.flow_prev or 0) >= 15),
    "combined": ("Spill OR flow OR rain",
                 lambda j: j.hours_all > 0 or (j.flow_prev or 0) >= 15 or j.rain_2d >= 10),
}


def score(rows: list[Joined], rule: Rule) -> dict[str, float | int | None]:
    warned = [j for j in rows if rule(j)]
    quiet = [j for j in rows if not rule(j)]
    hit = sum(j.exceed for j in warned)
    miss = sum(j.exceed for j in quiet)
    return {
        "n": len(rows), "exceedances": hit + miss,
        "warned": len(warned), "warned_exceed": hit,
        "warned_median": st.median(j.sample.ecoli for j in warned) if warned else None,
        "not_warned": len(quiet), "not_warned_exceed": miss,
        "not_warned_median": st.median(j.sample.ecoli for j in quiet) if quiet else None,
        "false_warnings": len(warned) - hit,
        "pod": hit / (hit + miss) if hit + miss else None,
        "far": (len(warned) - hit) / len(warned) if warned else None,
    }


def rule_table(rows: list[Joined]) -> dict[str, dict]:
    return {k: {"label": label, **score(rows, rule)} for k, (label, rule) in RULES.items()}


def by_year(rows: list[Joined], rule: Rule) -> dict[str, dict]:
    years = sorted({j.sample.local[:4] for j in rows})
    return {y: score([j for j in rows if j.sample.local[:4] == y], rule) for y in years}


def freshford_days(rows: list[Joined]) -> int:
    return len({j.sample.t.astimezone(LONDON).date() for j in rows if j.hours_freshford > 0})


def signal_adds(rows: list[Joined]) -> dict[str, int]:
    """Freshford-warned samples whose prior-day flow was under 15 m3/s, and how many of those exceeded."""
    low = [j for j in rows if j.hours_freshford > 0 and (j.flow_prev or 0) < 15]
    return {"freshford_low_flow": len(low), "freshford_low_flow_exceed": sum(j.exceed for j in low)}
