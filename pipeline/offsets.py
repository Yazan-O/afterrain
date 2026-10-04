"""Site offsets, fog, quests and the citizen update: pure functions the TypeScript app reproduces.

PRE-REGISTRATION (2026-09-25, written with pipeline/citymodel.py before any fit; not edited after)
--------------------------------------------------------------------------------------------------
Offset posterior. The site offsets (a, b) live on a fixed 61 x 61 grid spanning +-4 prior sd on each axis:
  a_i = -4 tau_a + i * (8 tau_a / 60), b_j = -4 tau_b + j * (8 tau_b / 60), i, j = 0..60.
  State = unnormalised log weights lw[i][j]; prior lw = -(a_i^2 / (2 tau_a^2) + b_j^2 / (2 tau_b^2)).
  At rain input x the site's log-odds on grid point (i, j) is eta_ij = alpha + a_i + (beta + b_j) * x.
Citizen update (exact Bayes on the grid). lw[i][j] += log L(obs | eta_ij), with
  over 900:   log sigmoid(eta)  = -softplus(-eta)
  900 or less: log sigmoid(-eta) = -softplus(eta)
  a count c:  u = (log10(max(c, 1)) - log10(900)) / s - eta;  log L = -u - 2 softplus(-u) - ln s
  softplus(z) = max(z, 0) + ln(1 + exp(-|z|)).  x is the member-median r48 input at the sample hour.
  Normalised weights w = exp(lw - max lw) / sum. Posterior summaries: means m_a, m_b, variances, covariance.
Probability at an hour. For each ensemble member k with a complete 48 h window, x_k = ln(1 + r48_k) and
  p_k = sigmoid(alpha + m_a + (beta + m_b) x_k). p10, p50, p90 = quantiles of {p_k} with linear interpolation
  (position (n - 1) q in the sorted list).
Fog in [0, 1] at a site-hour.
  fog_rain  = p90 - p10 (forecast spread across members).
  fog_local = sigmoid(eta~ + 1.2815515655446004 sd_u) - sigmoid(eta~ - 1.2815515655446004 sd_u), where
              x~ = the member-median x, eta~ = alpha + m_a + (beta + m_b) x~, and
              sd_u^2 = var(a) + 2 x~ cov(a, b) + x~^2 var(b)  (the 10-90 band of the probability from the site's
              own offset, as if the offset were normal with the posterior's mean and variance).
  fog = min(1, sqrt(fog_rain^2 + fog_local^2))   (two independent spreads add in variance).
  A storm hour is foggier than a dry hour by construction: the rain-response offset b multiplies x, and the
  logistic curve is steepest near the middle.
Quests. Horizon: the 72 hours from the nowcast's first hour. A sample can be taken at local hours 08:00-19:00.
  Score of a site-hour h = the expected drop in the site's mean fog over the 72 hours after one E. coli count at h
  (preposterior: log10 count on 60 nodes 0.05, 0.15, ..., 5.95, weighted by the site's predictive density at h,
  renormalised; each node's posterior gives a mean fog; the expectation is the weighted sum). The member-median x
  at h stands in for the rain the sample will see. Per site the best hour wins; its window is the contiguous run of
  sampling hours on the same local day with a score >= 0.8 of the best. A city's quests are its top 3 sites by
  best score (ties by site code).

DATED CHANGE (2026-10-02; the text above is left as written): the probability is the posterior predictive
-----------------------------------------------------------------------------------------------------------
Why. sigmoid(alpha + m_a + (beta + m_b) x) plugs the posterior MEAN offset into the logistic. With the wide prior
  (tau_a 2.26) that understates the chance at a site with no counts: at no rain 5.8% plug-in against 16.5% averaged
  over the prior grid.
What changes. p_k = sum_ij w_ij sigmoid(alpha + a_i + (beta + b_j) x_k), the chance averaged over the site's offset
  posterior on the grid (exact). p10/p50/p90, fog_rain = p90 - p10 and the state rule use these p_k; fog_local and
  the thresholds are unchanged. p_dry is the same average at x = 0. Quest scoring evaluates the same average by
  linear interpolation on a fine x lattice (P_STEP; error under 1e-5, tests/test_offsets.py).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Sequence

import numpy as np

GRID_N = 61
GRID_HALF = 4.0
Z90 = 1.2815515655446004
LOG10_900 = math.log10(900.0)
HORIZON_H = 72
SAMPLE_HOURS = (8, 19)          # local clock hours, both inclusive
WINDOW_FRAC = 0.8
L_NODES = np.array([0.05 + 0.1 * k for k in range(60)])


@dataclass(frozen=True)
class Params:
    alpha: float
    beta: float
    tau_a: float
    tau_b: float
    s: float
    t_higher: float
    t_high: float
    fog_unknown: float

    def axes(self) -> tuple[np.ndarray, np.ndarray]:
        a = np.array([-GRID_HALF * self.tau_a + i * (2 * GRID_HALF * self.tau_a / (GRID_N - 1)) for i in range(GRID_N)])
        b = np.array([-GRID_HALF * self.tau_b + j * (2 * GRID_HALF * self.tau_b / (GRID_N - 1)) for j in range(GRID_N)])
        return a, b


def prior(p: Params) -> np.ndarray:
    a, b = p.axes()
    return -(a[:, None] ** 2 / (2 * p.tau_a ** 2) + b[None, :] ** 2 / (2 * p.tau_b ** 2))


def softplus(z: np.ndarray | float) -> np.ndarray:
    z = np.asarray(z, float)
    return np.maximum(z, 0) + np.log1p(np.exp(-np.abs(z)))


def eta_grid(p: Params, x: float) -> np.ndarray:
    a, b = p.axes()
    return p.alpha + a[:, None] + (p.beta + b[None, :]) * x


def loglik(p: Params, obs: dict[str, Any], eta: np.ndarray) -> np.ndarray:
    """obs = {"over_900": bool} or {"count": float}."""
    if "count" in obs:
        u = (math.log10(max(float(obs["count"]), 1.0)) - LOG10_900) / p.s - eta
        return -u - 2 * softplus(-u) - math.log(p.s)
    if obs.get("over_900") is True:
        return -softplus(-eta)
    if obs.get("over_900") is False:
        return -softplus(eta)
    raise ValueError(f"observation needs 'count' or 'over_900': {obs}")


def update(p: Params, lw: np.ndarray, x: float, obs: dict[str, Any]) -> np.ndarray:
    """The citizen update: exact Bayes on the grid. Pure: returns new log weights."""
    return lw + loglik(p, obs, eta_grid(p, x))


def weights(lw: np.ndarray) -> np.ndarray:
    w = np.exp(lw - lw.max())
    return w / w.sum()


@dataclass(frozen=True)
class Moments:
    ma: float
    mb: float
    va: float
    vb: float
    cab: float


def moments(p: Params, lw: np.ndarray) -> Moments:
    a, b = p.axes()
    w = weights(lw)
    wa, wb = w.sum(1), w.sum(0)
    ma, mb = float(wa @ a), float(wb @ b)
    va = float(wa @ (a - ma) ** 2)
    vb = float(wb @ (b - mb) ** 2)
    cab = float(((a - ma)[:, None] * (b - mb)[None, :] * w).sum())
    return Moments(ma, mb, va, vb, cab)


def sigmoid(z: np.ndarray | float) -> np.ndarray:
    return 1 / (1 + np.exp(-np.asarray(z, float)))


def quantile_sorted(v: np.ndarray, q: float) -> np.ndarray:
    """Linear-interpolation quantile along the last axis of an already sorted array."""
    n = v.shape[-1]
    h = (n - 1) * q
    lo = int(math.floor(h))
    if lo >= n - 1:
        return v[..., n - 1]
    return v[..., lo] + (h - lo) * (v[..., lo + 1] - v[..., lo])


def predictive(p: Params, w: np.ndarray, xs: Sequence[float] | np.ndarray) -> np.ndarray:
    """Posterior predictive chance over 900 at each rain input x: sum_ij w_ij sigmoid(alpha + a_i + (beta + b_j) x).
    w = normalised grid weights (N, N)."""
    a, b = p.axes()
    x = np.asarray(xs, float)
    eta = p.alpha + a[:, None, None] + (p.beta + b[None, :, None]) * x[None, None, :]
    return np.tensordot(w, sigmoid(eta), axes=([0, 1], [0, 1]))


def hour_summary(p: Params, m: Moments, xs: Sequence[float], w: np.ndarray) -> dict[str, Any]:
    """Probability band, fog and state at one site-hour; xs = the members' ln(1 + r48), w = the posterior's
    normalised grid weights (the probability is the posterior predictive, the 2026-10-02 change above)."""
    x = np.sort(np.asarray(xs, float))
    pk = np.sort(predictive(p, w, x))
    p10, p50, p90 = (float(quantile_sorted(pk, q)) for q in (0.1, 0.5, 0.9))
    xt = float(quantile_sorted(x, 0.5))
    fog_rain, fog_local, fog = fog_parts(p, m, p10, p90, xt)
    return {"p10": p10, "p50": p50, "p90": p90, "x_median": xt, "fog_rain": fog_rain, "fog_local": fog_local,
            "fog": fog, "state": state(p, p50, fog)}


def fog_parts(p: Params, m: Moments, p10: float, p90: float, xt: float) -> tuple[float, float, float]:
    eta_t = p.alpha + m.ma + (p.beta + m.mb) * xt
    sd_u = math.sqrt(max(m.va + 2 * xt * m.cab + xt * xt * m.vb, 0.0))
    fog_local = float(sigmoid(eta_t + Z90 * sd_u) - sigmoid(eta_t - Z90 * sd_u))
    fog_rain = p90 - p10
    return fog_rain, fog_local, min(1.0, math.sqrt(fog_rain ** 2 + fog_local ** 2))


def state(p: Params, p50: float, fog: float) -> str:
    if fog >= p.fog_unknown:
        return "unknown"
    if p50 >= p.t_high:
        return "high"
    if p50 >= p.t_higher:
        return "higher"
    return "usual"


# ---- vectorised fog for many posteriors (quests) -------------------------------------------------------------
P_STEP = 0.005          # x lattice step for the quests' interpolated predictive chance


@lru_cache(maxsize=8)
def _sig_table(p: Params, n_nodes: int) -> np.ndarray:
    """sigmoid(eta) at every grid point and every lattice node x = 0, P_STEP, ...: shape (N * N, n_nodes)."""
    a, b = p.axes()
    x = np.arange(n_nodes) * P_STEP
    return sigmoid(p.alpha + a[:, None, None] + (p.beta + b[None, :, None]) * x[None, None, :]).reshape(-1, n_nodes)


def predictive_many(p: Params, W: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Posterior predictive chance for K posteriors (W: (K, N, N) normalised weights) at every x in X (any shape,
    x >= 0), by linear interpolation on the P_STEP lattice. Returns shape (K, *X.shape)."""
    n_nodes = int(math.ceil(max(float(X.max()), 6.0) / P_STEP)) + 2
    P = W.reshape(W.shape[0], -1) @ _sig_table(p, n_nodes)                          # (K, n_nodes)
    pos = X / P_STEP
    lo = np.floor(pos).astype(int)
    fr = pos - lo
    return P[:, lo] * (1 - fr) + P[:, lo + 1] * fr


def fog_many(p: Params, W: np.ndarray, ms: dict[str, np.ndarray], X: np.ndarray, xt: np.ndarray) -> np.ndarray:
    """W: (K, N, N) posterior weights, ms: their moments as arrays; X: (H, M) members' x per hour (sorted rows,
    NaN-free); xt: (H,) member-median x. Returns the fog at each of the H hours for each posterior, (K, H)."""
    pk = np.sort(predictive_many(p, W, X), axis=-1)
    fog_rain = quantile_sorted(pk, 0.9) - quantile_sorted(pk, 0.1)                   # (K, H)
    eta_t = p.alpha + ms["ma"][:, None] + (p.beta + ms["mb"][:, None]) * xt[None, :]
    var = ms["va"][:, None] + 2 * xt[None, :] * ms["cab"][:, None] + xt[None, :] ** 2 * ms["vb"][:, None]
    sd_u = np.sqrt(np.maximum(var, 0))
    fog_local = sigmoid(eta_t + Z90 * sd_u) - sigmoid(eta_t - Z90 * sd_u)
    return np.minimum(1.0, np.sqrt(fog_rain ** 2 + fog_local ** 2))


def mean_fog_many(p: Params, W: np.ndarray, ms: dict[str, np.ndarray], X: np.ndarray, xt: np.ndarray) -> np.ndarray:
    """fog_many averaged over the H hours: (K,)."""
    return fog_many(p, W, ms, X, xt).mean(axis=1)


def moments_many(p: Params, lw: np.ndarray) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """One posterior as the (1, N, N) weights and moment arrays that fog_many takes."""
    m = moments(p, lw)
    return weights(lw)[None], {k: np.array([getattr(m, k)]) for k in ("ma", "mb", "va", "vb", "cab")}


def preposterior(p: Params, lw: np.ndarray, x_sample: float, X: np.ndarray, xt: np.ndarray) -> dict[str, Any]:
    """Expected mean fog over the horizon after one E. coli count taken at rain input x_sample; also returns the
    count nodes' posteriors (post, ms) and their predictive weights q."""
    a, b = p.axes()
    w = weights(lw)
    eta = eta_grid(p, x_sample)
    u = (L_NODES[:, None, None] - LOG10_900) / p.s - eta[None]
    lik = np.exp(-u - 2 * softplus(-u) - math.log(p.s))                               # (K, N, N)
    joint = lik * w[None]
    q = joint.sum(axis=(1, 2))
    post = joint / q[:, None, None]
    q = q / q.sum()
    wa, wb = post.sum(2), post.sum(1)
    ma, mb = wa @ a, wb @ b
    ms = {"ma": ma, "mb": mb, "va": ((a[None, :] - ma[:, None]) ** 2 * wa).sum(1),
          "vb": ((b[None, :] - mb[:, None]) ** 2 * wb).sum(1),
          "cab": ((a[None, :, None] - ma[:, None, None]) * (b[None, None, :] - mb[:, None, None]) * post).sum((1, 2))}
    after = mean_fog_many(p, post, ms, X, xt)
    return {"expected_mean_fog_after": float(q @ after), "ms": ms, "q": q, "post": post}
