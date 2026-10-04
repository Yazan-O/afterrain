"""data/out/update_spec.json: everything the TypeScript engine needs to reproduce the offset update and the fog."""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from . import offsets

# Probe hour for the vectors: 51 members with r48 = 0, 0.4, ..., 20 mm.
PROBE_R48 = [0.4 * k for k in range(51)]
VECTORS: list[tuple[str, list[dict[str, Any]]]] = [
    ("dry hour, one sample at or under 900", [{"r48_mm": 0.0, "obs": {"over_900": False}}]),
    ("dry hour, a count of 50", [{"r48_mm": 0.0, "obs": {"count": 50}}]),
    ("storm hour (20 mm in 48 h), one sample over 900", [{"r48_mm": 20.0, "obs": {"over_900": True}}]),
    ("storm hour (20 mm in 48 h), a count of 31000", [{"r48_mm": 20.0, "obs": {"count": 31000}}]),
    ("two samples: a count of 50 on a dry hour, then 3100 after 12 mm",
     [{"r48_mm": 0.0, "obs": {"count": 50}}, {"r48_mm": 12.0, "obs": {"count": 3100}}]),
]


def summary(p: offsets.Params, lw: np.ndarray) -> dict[str, Any]:
    m = offsets.moments(p, lw)
    w = offsets.weights(lw)
    s = offsets.hour_summary(p, m, [math.log1p(r) for r in PROBE_R48], w)
    return {"mean_a": m.ma, "mean_b": m.mb, "var_a": m.va, "var_b": m.vb, "cov_ab": m.cab,
            "p_dry": float(offsets.predictive(p, w, [0.0])[0]),
            **{k: s[k] for k in ("p10", "p50", "p90", "x_median", "fog_rain", "fog_local", "fog", "state")}}


def build(p: offsets.Params, version: str) -> dict[str, Any]:
    a, b = p.axes()
    vecs = []
    for name, steps in VECTORS:
        lw = offsets.prior(p)
        for st in steps:
            lw = offsets.update(p, lw, math.log1p(st["r48_mm"]), st["obs"])
        vecs.append({"name": name, "start": "prior", "steps": steps, "probe_members_r48_mm": PROBE_R48,
                     "expected": summary(p, lw)})
    return {
        "model_version": version,
        "params": {**p.__dict__, "grid_n": offsets.GRID_N, "grid_half_width_sd": offsets.GRID_HALF,
                   "z90": offsets.Z90, "log10_900": offsets.LOG10_900},
        "axes": {"a": a.tolist(), "b": b.tolist()},
        "prior_at_probe": summary(p, offsets.prior(p)),
        "definitions": {
            "grid": "a_i = -4 tau_a + i * (8 tau_a / 60), b_j = -4 tau_b + j * (8 tau_b / 60), i, j = 0..60 "
                    "(values listed in `axes`); state = log weights lw[i][j]",
            "prior": "lw[i][j] = -(a_i^2 / (2 tau_a^2) + b_j^2 / (2 tau_b^2))",
            "eta": "eta_ij = alpha + a_i + (beta + b_j) * x, x = ln(1 + r48 mm)",
            "update": "lw[i][j] += log L(obs | eta_ij); over 900: -softplus(-eta); 900 or less: -softplus(eta); "
                      "count c: u = (log10(max(c, 1)) - log10_900) / s - eta, log L = -u - 2 softplus(-u) - ln s; "
                      "softplus(z) = max(z, 0) + ln(1 + exp(-|z|))",
            "weights": "w = exp(lw - max lw) / sum over the grid",
            "moments": "mean_a = sum w a_i; mean_b = sum w b_j; var_a, var_b, cov_ab the weighted (co)variances",
            "probability": "per member k: p_k = sum over the grid of w_ij sigmoid(alpha + a_i + (beta + b_j) x_k), "
                           "the posterior predictive chance (changed 2026-10-02 from the plug-in "
                           "sigmoid(alpha + mean_a + (beta + mean_b) x_k)); p10/p50/p90 = linear-interpolation "
                           "quantiles of the sorted p_k at position (n - 1) q; p_dry = the same sum at x = 0",
            "fog": "fog_rain = p90 - p10; x~ = the member-median x; eta~ = alpha + mean_a + (beta + mean_b) x~; "
                   "sd_u = sqrt(var_a + 2 x~ cov_ab + x~^2 var_b); fog_local = sigmoid(eta~ + z90 sd_u) - "
                   "sigmoid(eta~ - z90 sd_u); fog = min(1, sqrt(fog_rain^2 + fog_local^2))",
            "state": "unknown if fog >= fog_unknown; else high if p50 >= t_high; else higher if p50 >= t_higher; "
                     "else usual. The word used for the lowest state is 'usual'.",
            "x_for_a_sample": "the member-median x at the hour the sample was taken",
            "tolerance": "every expected value reproduces to 1e-9",
        },
        "vectors": vecs,
    }
