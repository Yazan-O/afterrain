"""Logistic model for P(E. coli > 900 per 100 ml): transparent features, fitted on 2021-2024, tested on 2025."""
from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

from . import config
from .evidence import is_freshford
from .sources import LONDON, DailySeries, Sample, Spill, complete_day

CAP_H = 720.0          # "hours since" features saturate at 30 days
C_REG = 1.0            # L2 strength of the logistic fit (library default, not tuned)
VELOCITIES = (0.0, 0.25, 0.5, 1.0)  # m/s candidates for travel-time alignment; 0 = no alignment


def overflow_key(name: str) -> str:
    """One key per physical overflow across the spelling changes between yearly logs."""
    n = name.upper().replace("/", " ")
    n = re.sub(r"\bST\b", "STREET", n)
    n = re.sub(r"\bAND\b", " ", n)
    return re.sub(r"[^A-Z0-9]+", " ", n).strip()


@dataclass
class Overflow:
    key: str
    name: str
    site_ids: list[str]
    lat: float | None
    lon: float | None
    watercourse: str | None
    distance_m: float | None = None
    snap_m: float | None = None
    starts: np.ndarray = field(default_factory=lambda: np.zeros(0))
    ends: np.ndarray = field(default_factory=lambda: np.zeros(0))


def group_overflows(spills: list[Spill]) -> dict[str, Overflow]:
    out: dict[str, Overflow] = {}
    rows: dict[str, list[Spill]] = {}
    for s in spills:
        rows.setdefault(overflow_key(s.name), []).append(s)
    for k, ss in rows.items():
        last = max(ss, key=lambda s: s.start)  # the newest log's coordinates
        ids = sorted({s.site_id for s in ss})
        out[k] = Overflow(k, last.name, ids, last.lat, last.lon, last.watercourse,
                          starts=np.array([s.start.timestamp() for s in ss]),
                          ends=np.array([s.end.timestamp() for s in ss]))
    return out


def _overlap_h(starts: np.ndarray, ends: np.ndarray, t0: float, t1: float) -> float:
    return float(np.clip(np.minimum(ends, t1) - np.maximum(starts, t0), 0, None).sum() / 3600)


def _since_end_h(starts: np.ndarray, ends: np.ndarray, t: float) -> float:
    before = starts < t
    if not before.any():
        return CAP_H
    last_end = ends[before].max()
    return 0.0 if last_end >= t else min(CAP_H, (t - last_end) / 3600)


@dataclass
class Site:
    """Everything the features need at one exposure point."""
    overflows: dict[str, Overflow]
    rain: DailySeries
    flow: DailySeries
    anchor: str | None = None   # key of the named storm tank (Freshford at Warleigh)

    def flow_median(self) -> float:
        if not hasattr(self, "_median"):
            self._median = float(np.median([d.value for k, d in self.flow.items()
                                            if d.value is not None and k < "2025"]))
        return self._median


def raw_features(site: Site, t: dt.datetime, velocity: float) -> dict[str, float | None]:
    """Untransformed inputs at time t (UTC). Spills are shifted by their along-river travel time."""
    ts = t.timestamp()
    t0 = ts - config.WINDOW_H * 3600
    count, hours, since = 0, 0.0, CAP_H
    for o in site.overflows.values():
        lag = (o.distance_m / velocity) if (velocity > 0 and o.distance_m is not None) else 0.0
        h = _overlap_h(o.starts + lag, o.ends + lag, t0, ts)
        count += h > 0
        hours += h
        since = min(since, _since_end_h(o.starts + lag, o.ends + lag, ts))
    f: dict[str, float | None] = {"up_count_48h": float(count), "up_hours_48h": hours, "up_hours_since_end": since}
    if site.anchor:
        a = site.overflows[site.anchor]
        f["anchor_hours_since_end"] = _since_end_h(a.starts, a.ends, ts)
        f["anchor_hours_48h"] = _overlap_h(a.starts, a.ends, t0, ts)
    # Gauge days run 09:00-09:00 GMT; only intervals that finished at or before t are used.
    q = site.flow.get(complete_day(site.flow, t, 1))
    f["flow_prev_day"] = q.value if q else None
    f["flow_ratio"] = (q.value / site.flow_median()) if (q and q.value is not None) else None
    f["rain_2d"] = sum((site.rain[d].value or 0.0) if d in site.rain else 0.0
                       for d in (complete_day(site.rain, t, 1), complete_day(site.rain, t, 2)))
    doy = t.astimezone(LONDON).timetuple().tm_yday
    f["doy"] = float(doy)
    return f


# name -> (raw input, transform)
SPECS: dict[str, dict[str, tuple[str, str]]] = {
    "warleigh": {
        "freshford_since_end": ("anchor_hours_since_end", "log1p"),
        "freshford_hours_48h": ("anchor_hours_48h", "log1p"),
        "upstream_count_48h": ("up_count_48h", "identity"),
        "upstream_hours_48h": ("up_hours_48h", "log1p"),
        "flow_prev_day": ("flow_prev_day", "log"),
        "rain_2d": ("rain_2d", "log1p"),
        "season_sin": ("doy", "sin"),
        "season_cos": ("doy", "cos"),
    },
    "portable": {
        "upstream_since_end": ("up_hours_since_end", "log1p"),
        "upstream_count_48h": ("up_count_48h", "identity"),
        "upstream_hours_48h": ("up_hours_48h", "log1p"),
        "flow_ratio": ("flow_ratio", "log"),
        "rain_2d": ("rain_2d", "log1p"),
        "season_sin": ("doy", "sin"),
        "season_cos": ("doy", "cos"),
    },
}


def transform(kind: str, x: float) -> float:
    if kind == "identity":
        return x
    if kind == "log1p":
        return math.log1p(max(x, 0.0))
    if kind == "log":
        return math.log(max(x, 1e-3))
    if kind == "sin":
        return math.sin(2 * math.pi * x / 365.25)
    if kind == "cos":
        return math.cos(2 * math.pi * x / 365.25)
    raise ValueError(kind)


@dataclass
class Fitted:
    spec: str
    velocity: float
    names: list[str]
    fill: dict[str, float]      # value used when a raw input is missing (training median)
    mean: np.ndarray
    std: np.ndarray
    coef: np.ndarray
    intercept: float
    threshold: float = 0.5

    def design(self, raws: Sequence[dict[str, float | None]]) -> np.ndarray:
        spec = SPECS[self.spec]
        rows = []
        for r in raws:
            rows.append([transform(tf, r[src] if r[src] is not None else self.fill[src])
                         for src, tf in (spec[n] for n in self.names)])
        return np.array(rows, float)

    def predict(self, raws: Sequence[dict[str, float | None]]) -> np.ndarray:
        z = (self.design(raws) - self.mean) / self.std
        return 1 / (1 + np.exp(-(z @ self.coef + self.intercept)))


def fit(spec: str, raws: list[dict[str, float | None]], y: np.ndarray, velocity: float) -> Fitted:
    names = list(SPECS[spec])
    fill = {}
    for src, _ in SPECS[spec].values():
        vals = [r[src] for r in raws if r[src] is not None]
        fill[src] = float(np.median(vals))
    m = Fitted(spec, velocity, names, fill, np.zeros(len(names)), np.ones(len(names)), np.zeros(len(names)), 0.0)
    x = m.design(raws)
    m.mean, m.std = x.mean(0), x.std(0)
    m.std[m.std == 0] = 1.0
    lr = LogisticRegression(C=C_REG, max_iter=5000).fit((x - m.mean) / m.std, y)
    m.coef, m.intercept = lr.coef_[0], float(lr.intercept_[0])
    return m


def year_cv(spec: str, samples: list[Sample], site: Site, velocity: float,
            years: Sequence[str]) -> tuple[np.ndarray, np.ndarray]:
    """Out-of-fold probabilities, leaving one training year out at a time."""
    raws = [raw_features(site, s.t, velocity) for s in samples]
    if any(s.over_900 is None for s in samples):
        raise ValueError("a sample's qualifier leaves its label undecided; drop it before fitting")
    y = np.array([bool(s.over_900) for s in samples], int)
    yr = np.array([s.local[:4] for s in samples])
    p = np.zeros(len(samples))
    for held in years:
        tr, te = yr != held, yr == held
        m = fit(spec, [r for r, k in zip(raws, tr) if k], y[tr], velocity)
        p[te] = m.predict([r for r, k in zip(raws, te) if k])
    return y, p


def peirce_threshold(y: np.ndarray, p: np.ndarray) -> float:
    """Probability cut that maximises hit rate minus false-alarm rate (Peirce skill)."""
    best, cut = -2.0, 0.5
    for c in np.unique(p):
        w = p >= c
        pod = (w & (y == 1)).sum() / max(1, (y == 1).sum())
        pofd = (w & (y == 0)).sum() / max(1, (y == 0).sum())
        if pod - pofd > best:
            best, cut = pod - pofd, float(c)
    return cut


def metrics(y: np.ndarray, p: np.ndarray, threshold: float, base_rate: float) -> dict[str, Any]:
    w = p >= threshold
    hit = int((w & (y == 1)).sum())
    ex = int(y.sum())
    return {"n": int(len(y)), "exceedances": ex,
            "auc": float(roc_auc_score(y, p)) if 0 < ex < len(y) else None,
            "brier": float(brier_score_loss(y, p)),
            "brier_base_rate": float(brier_score_loss(y, np.full(len(y), base_rate))),
            "warned": int(w.sum()), "warned_exceed": hit, "pod": hit / ex if ex else None,
            "far": (int(w.sum()) - hit) / int(w.sum()) if w.sum() else None, "threshold": threshold}


def select_velocity(spec: str, train: list[Sample], site: Site, years: Sequence[str]) -> tuple[float, dict]:
    scores = {}
    for v in VELOCITIES:
        y, p = year_cv(spec, train, site, v, years)
        scores[v] = float(log_loss(y, np.clip(p, 1e-6, 1 - 1e-6)))
    return min(scores, key=scores.get), scores


def export(m: Fitted, site_name: str, travel: dict[str, dict], vectors: list[dict]) -> dict[str, Any]:
    spec = SPECS[m.spec]
    feats = []
    for i, n in enumerate(m.names):
        src, tf = spec[n]
        feats.append({"name": n, "input": src, "transform": tf, "fill_if_missing": m.fill[src],
                      "mean": float(m.mean[i]), "std": float(m.std[i]), "coef": float(m.coef[i])})
    return {
        "site": site_name, "target": "P(E. coli > 900 per 100 ml) in a single sample",
        "note_900": "900 per 100 ml is used as a single-sample flag; the EU Bathing Water Directive applies 900 "
                    "to a 90th percentile of a season's samples.",
        "formula": "p = 1 / (1 + exp(-(intercept + sum_i coef_i * (transform_i(x_i) - mean_i) / std_i)))",
        "transforms": {"identity": "x", "log1p": "ln(1 + max(x, 0))", "log": "ln(max(x, 0.001))",
                       "sin": "sin(2*pi*x/365.25)", "cos": "cos(2*pi*x/365.25)"},
        "inputs": INPUT_DEFS, "window_hours": config.WINDOW_H, "cap_hours": CAP_H,
        "velocity_m_per_s": m.velocity, "intercept": m.intercept, "features": feats,
        "threshold": m.threshold, "travel": travel, "test_vectors": vectors,
    }


INPUT_DEFS = {
    "anchor_hours_since_end": "Hours from the end of the most recent Freshford storm tank spill that started before "
                              "t, to t; 0 while it is spilling; capped at 720; 720 if none.",
    "anchor_hours_48h": "Freshford storm tank spill hours overlapping [t-48 h, t].",
    "up_count_48h": "Number of upstream overflows whose spill, shifted later by its travel time (along-river "
                    "distance / velocity), overlaps [t-48 h, t].",
    "up_hours_48h": "Total travel-time-shifted spill hours of all upstream overflows overlapping [t-48 h, t].",
    "up_hours_since_end": "Hours since the most recent travel-time-shifted spill end of any upstream overflow; "
                          "0 while one is arriving; capped at 720.",
    "flow_prev_day": "Gauge daily mean flow (m3/s) over the latest 09:00-09:00 GMT gauge day that finished at or "
                     "before t.",
    "flow_ratio": "flow_prev_day divided by the gauge's median daily flow over 2021-2024.",
    "rain_2d": "Gauge rain (mm) summed over the two latest 09:00-09:00 GMT gauge days that finished at or before "
               "t; a missing day counts 0.",
    "doy": "Local (Europe/London) day of year of t.",
}
