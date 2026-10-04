"""Typed loaders for the Wessex Water and Environment Agency inputs."""
from __future__ import annotations

import collections
import csv
import datetime as dt
import io
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from . import config
from .fetch import Fetcher

UTC = dt.timezone.utc
LONDON = ZoneInfo("Europe/London")
EDM_FIELDS = "SiteId,SiteName,EventStart,EventEnd,OutfallLatitude,OutfallLongitude,ReceivingWatercourse"


@dataclass(frozen=True)
class Spill:
    site_id: str
    name: str
    start: dt.datetime
    end: dt.datetime
    lat: float | None
    lon: float | None
    watercourse: str | None
    layer: str


@dataclass(frozen=True)
class Sample:
    t: dt.datetime          # UTC
    local: str              # the timestamp as published (Europe/London wall time)
    ecoli: float
    enterococci: float | None
    operator: str = ""      # the E. coli result's laboratory qualifier as published: "<", ">" or "" (exact)
    enterococci_operator: str = ""

    @property
    def over_900(self) -> bool | None:
        """None when the qualifier leaves the result undecided against the flag ("< 1000")."""
        return config.label(self.ecoli, self.operator)


@dataclass(frozen=True)
class Daily:
    value: float | None
    quality: str
    start: dt.datetime | None = None   # interval start (UTC); the value covers [start, start + 24 h)

    @property
    def end(self) -> dt.datetime | None:
        return self.start + dt.timedelta(days=1) if self.start else None


class DailySeries(dict):
    """Environment Agency daily values keyed by their published date, which is the interval's START date: a daily
    value runs 09:00 to 09:00 GMT, so the one dated D finishes at 09:00 GMT on D + 1."""

    def __init__(self, rows: dict[str, Daily], day_start: dt.timedelta):
        super().__init__(rows)
        self.day_start = day_start   # time of day (GMT) at which every interval starts

    def interval(self, key: str) -> tuple[dt.datetime, dt.datetime]:
        s = dt.datetime.combine(dt.date.fromisoformat(key), dt.time(), UTC) + self.day_start
        return s, s + dt.timedelta(days=1)


def complete_day(series: DailySeries, t: dt.datetime, k: int) -> str:
    """Key of the k-th most recent daily interval that finished at or before t (k = 1 the latest; k = 0 the interval
    still running at t). A sample before 09:00 GMT on day D gets D - 2 as its latest complete interval."""
    running = (t.astimezone(UTC) - series.day_start).date()
    return (running - dt.timedelta(days=k)).isoformat()


def _spills(rows: list[dict], layer: str) -> list[Spill]:
    out = []
    for x in rows:
        if not x.get("EventStart") or not x.get("EventEnd"):
            continue
        s = dt.datetime.fromtimestamp(x["EventStart"] / 1000, UTC)
        e = dt.datetime.fromtimestamp(x["EventEnd"] / 1000, UTC)
        if e < s:
            continue
        out.append(Spill(x["SiteId"], x["SiteName"].strip(), s, e, x.get("OutfallLatitude"),
                         x.get("OutfallLongitude"), x.get("ReceivingWatercourse"), layer))
    return out


def warleigh_spills(f: Fetcher) -> list[Spill]:
    ids = ",".join(f"'{s}'" for s in config.WARLEIGH_UPSTREAM_IDS)
    out: list[Spill] = []
    for layer, url in config.EDM_LAYERS.items():
        where = f"SiteId IN ({ids})" if layer in ("2020_2023", "2024") else config.WARLEIGH_UPSTREAM_BOX
        out += _spills(f.arcgis(f"wessex_edm_warleigh_{layer}.json", url, where, EDM_FIELDS, config.CC_BY_4), layer)
    return sorted(out, key=lambda s: (s.start, s.end, s.name))


def farleigh_spills(f: Fetcher) -> list[Spill]:
    out: list[Spill] = []
    for layer, url in config.EDM_LAYERS.items():
        rows = f.arcgis(f"wessex_edm_farleigh_{layer}.json", url, config.FARLEIGH_UPSTREAM_BOX, EDM_FIELDS,
                        config.CC_BY_4)
        rows = [r for r in rows if not any(k in (r["SiteName"] or "").upper() for k in config.FARLEIGH_EXCLUDE)]
        out += _spills(rows, layer)
    return sorted(out, key=lambda s: (s.start, s.end, s.name))


def _num(v: object) -> float | None:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _operator(r: dict) -> str:
    """Wessex `Operator`: "<" or ">" qualify the result; blank and "NA" (the 2025 rows) mean an exact result."""
    op = (r.get("Operator") or "").strip()
    if op in ("", "NA"):
        return ""
    if op in ("<", ">"):
        return op
    raise RuntimeError(f"unknown Wessex Operator {op!r} at {r.get('SampleDate')}")


def _samples(rows: list[dict]) -> list[Sample]:
    # Replicate samples share a timestamp and the source has no sample id, so an enterococci result
    # is paired with an E. coli result only when it is the only one at that timestamp.
    ent_rows = [r for r in rows if r["Determinand"] == "Enterococci"]
    n_at = collections.Counter(r["SampleDate"] for r in ent_rows)
    entero = {r["SampleDate"]: (_num(r["Result"]), _operator(r)) for r in ent_rows if n_at[r["SampleDate"]] == 1}
    out = []
    for r in rows:
        if r["Determinand"] != "E. coli":
            continue
        v = _num(r["Result"])
        if v is None:
            continue
        t = dt.datetime.fromisoformat(r["SampleDate"]).replace(tzinfo=LONDON).astimezone(UTC)
        ev, eop = entero.get(r["SampleDate"], (None, ""))
        out.append(Sample(t, r["SampleDate"], v, ev, _operator(r), eop))
    return out


def warleigh_samples(f: Fetcher) -> list[Sample]:
    rows = f.arcgis("wessex_wq_warleigh.json", config.WQ_LAYER,
                    config.WARLEIGH_SAMPLE_BOX + " AND Determinand IN ('E. coli','Enterococci')",
                    "SampleDate,Determinand,Units,Operator,Result,Latitude,Longitude", config.CC_BY_4,
                    order="SampleDate")
    return _samples(rows)


def farleigh_samples(f: Fetcher) -> list[Sample]:
    rows = f.arcgis("wessex_wq_farleigh.json", config.WQ_LAYER,
                    config.FARLEIGH_SAMPLE_BOX + " AND Determinand IN ('E. coli','Enterococci')",
                    "SampleDate,Determinand,Units,Operator,Result,Latitude,Longitude", config.CC_BY_4,
                    order="SampleDate")
    return _samples(rows)


def ea_daily(f: Fetcher, name: str, measure: str) -> DailySeries:
    """Daily values with their interval kept: `dateTime` (GMT) is the interval start, `date` its start date."""
    url = (f"{config.EA_HYDROLOGY}{measure}/readings.csv?mineq-date={config.HYDRO_START}"
           f"&max-date={config.HYDRO_END}&_limit=5000")
    text = f.fetch(name, url, config.OGL_3).read_text(encoding="utf-8")
    out: dict[str, Daily] = {}
    starts = set()
    for r in csv.DictReader(io.StringIO(text)):
        s = dt.datetime.fromisoformat(r["dateTime"].removesuffix("Z")).replace(tzinfo=UTC)
        if s.date().isoformat() != r["date"]:
            raise RuntimeError(f"{name}: reading dated {r['date']} starts at {r['dateTime']}")
        starts.add(s - dt.datetime.combine(s.date(), dt.time(), UTC))
        out[r["date"]] = Daily(_num(r["value"]), r["quality"], s)
    if not out:
        raise RuntimeError(f"{name}: no readings in {url}")
    if len(starts) != 1:
        raise RuntimeError(f"{name}: daily intervals start at {sorted(starts)}; expected one time of day")
    return DailySeries(out, starts.pop())


def claverton_rain(f: Fetcher) -> DailySeries:
    return ea_daily(f, "ea_rain_claverton_daily.csv", config.RAIN_CLAVERTON)


def bradford_flow(f: Fetcher) -> DailySeries:
    return ea_daily(f, "ea_flow_bradford_on_avon_daily.csv", config.FLOW_BRADFORD)


def tellisford_flow(f: Fetcher) -> DailySeries:
    return ea_daily(f, "ea_flow_tellisford_daily.csv", config.FLOW_TELLISFORD)
