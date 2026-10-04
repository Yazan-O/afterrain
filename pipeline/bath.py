"""Warleigh Weir: joined backtest, travel distances, the fitted model and its 2025 test."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import networkx as nx
import numpy as np

from . import config, evidence, model, rivers, sources
from .fetch import Fetcher

TRAIN_YEARS = ("2021", "2022", "2023", "2024")
TEST_YEAR = "2025"
AVON_BBOX = (51.14, -2.48, 51.40, -2.17)
SNAP_WARN_M = 250.0


@dataclass
class Bath:
    spills: list[sources.Spill]
    samples: list[sources.Sample]
    rain: dict[str, sources.Daily]
    flow: dict[str, sources.Daily]
    joined: list[evidence.Joined]
    net: rivers.Network


def load(f: Fetcher) -> Bath:
    spills = sources.warleigh_spills(f)
    samples = sources.warleigh_samples(f)
    rain, flow = sources.claverton_rain(f), sources.bradford_flow(f)
    joined = evidence.join(samples, spills, rain, flow)
    osm = rivers.overpass_waterways(f, "osm_avon_frome_waterways.json", AVON_BBOX, "river|stream")
    return Bath(spills, samples, rain, flow, joined, rivers.Network.from_osm(osm))


def locate(net: rivers.Network, overflows: dict[str, model.Overflow], target: tuple[float, float]) -> dict[str, list[int]]:
    """Along-river distance from each overflow to the target; returns each overflow's node path."""
    dst, _ = net.snap(*target)
    paths = {}
    for o in overflows.values():
        if o.lat is None or o.lon is None:
            continue
        src, snap = net.snap(o.lat, o.lon, component_of=dst)
        try:
            length, path = net.route(src, dst)
        except nx.NetworkXNoPath:
            continue
        o.distance_m, o.snap_m, paths[o.key] = length, snap, path
    return paths


def site(b: Bath) -> tuple[model.Site, dict[str, list[int]]]:
    ovs = model.group_overflows(b.spills)
    paths = locate(b.net, ovs, config.WARLEIGH)
    anchor = next(k for k, o in ovs.items() if evidence.is_freshford(o.name))
    return model.Site(ovs, b.rain, b.flow, anchor=anchor), paths


def travel_table(s: model.Site, velocity: float) -> dict[str, dict[str, Any]]:
    out = {}
    for k, o in sorted(s.overflows.items(), key=lambda kv: kv[1].distance_m or 1e12):
        out[k] = {"name": o.name, "site_ids": o.site_ids, "lat": o.lat, "lon": o.lon,
                  "receiving_water": (o.watercourse or "").strip() or None,
                  "distance_m": round(o.distance_m) if o.distance_m is not None else None,
                  "snap_m": round(o.snap_m) if o.snap_m is not None else None,
                  "distance_approximate": bool(o.snap_m is not None and o.snap_m > SNAP_WARN_M),
                  "travel_hours": round(o.distance_m / velocity / 3600, 2)
                  if (velocity > 0 and o.distance_m is not None) else 0.0}
    return out


def fit_and_test(b: Bath, s: model.Site, spec: str) -> dict[str, Any]:
    train = [j.sample for j in b.joined if j.sample.local[:4] in TRAIN_YEARS]
    test = [j.sample for j in b.joined if j.sample.local[:4] == TEST_YEAR]
    velocity, cv_scores = model.select_velocity(spec, train, s, TRAIN_YEARS)
    y_oof, p_oof = model.year_cv(spec, train, s, velocity, TRAIN_YEARS)
    raws_tr = [model.raw_features(s, x.t, velocity) for x in train]
    y_tr = np.array([bool(x.over_900) for x in train], int)
    m = model.fit(spec, raws_tr, y_tr, velocity)
    m.threshold = model.peirce_threshold(y_oof, p_oof)
    base = float(y_tr.mean())
    raws_te = [model.raw_features(s, x.t, velocity) for x in test]
    y_te = np.array([bool(x.over_900) for x in test], int)
    p_te = m.predict(raws_te)
    test_rows = [j for j in b.joined if j.sample.local[:4] == TEST_YEAR]
    rules = evidence.rule_table(test_rows)
    return {"model": m, "velocity_cv_logloss": cv_scores, "train_n": len(train),
            "train_exceedances": int(y_tr.sum()), "train_oof": model.metrics(y_oof, p_oof, m.threshold, base),
            "test": model.metrics(y_te, p_te, m.threshold, base), "test_rules": rules,
            "test_samples": test, "test_raws": raws_te, "test_p": p_te}


def vectors(m: model.Fitted, samples: list[sources.Sample], raws: list[dict], p: np.ndarray,
            n: int = 5) -> list[dict[str, Any]]:
    """Five held-out samples spread over the probability range, with the raw inputs the engine needs."""
    order = np.argsort(p)
    pick = [order[int(round(i))] for i in np.linspace(0, len(order) - 1, n)]
    spec = model.SPECS[m.spec]
    out = []
    for i in pick:
        inputs = {src: raws[i][src] for src, _ in spec.values()}
        out.append({"sample_time_utc": samples[i].t.isoformat(), "ecoli_observed": samples[i].ecoli,
                    "inputs": inputs, "expected_probability": float(p[i])})
    return out
