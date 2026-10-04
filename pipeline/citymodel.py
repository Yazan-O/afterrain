"""The city model: a rain-driven chance of E. coli over 900 per 100 ml, usable where only rain is known.

PRE-REGISTRATION (written 2026-09-25, before any of these models was fitted or scored; not edited after)
--------------------------------------------------------------------------------------------------------
Rain. Open-Meteo historical archive, model `era5`, hourly precipitation at the sample site (Warleigh Weir;
  Pech David, Hub'Eau station BF000002). r48 = rain in the 48 hourly stamps ending at the sample time floored to
  the UTC hour. Input x = ln(1 + r48). The forecast side computes the same r48 from the Open-Meteo ECMWF IFS 0.25
  ensemble hourly rain, member by member. The Bath rain gauge is not a model input anywhere in this module; the
  gauge vs Open-Meteo difference is measured and reported only (`gauge_vs_openmeteo`).
Model. logit p = alpha + beta * x, maximum likelihood (Newton), no penalty, no season term (Bath is sampled in the
  bathing season, Toulouse all year, so a season term fitted at one site cannot be checked at the other).
Candidates.
  (a) Bath: the 272 Warleigh samples of 2021-2024.
  (b) Toulouse: the 118 Pech David samples of 2016-2025.
  (c) Pooled: shared beta, one intercept per site, fitted on (a) + (b); at any other site it runs with the mean
      of the two site intercepts (its own site intercepts are never used for scoring).
Scoring sets (every prediction out-of-sample).
  Toulouse (118): (a) as fitted; (b) and (c) refitted with each Toulouse calendar year left out in turn.
  Bath 2025 (50, held out since P1): (a), (b), (c) as fitted.
  The two cross-site directions are (a) -> Toulouse and (b) -> Bath 2025.
  Reported per cell: n, exceedances, AUC, Brier, Brier of a constant forecast at the candidate's training base
  rate, and Brier of the scoring set's own base rate (a hindsight reference).
Selection rule. The final model is the candidate with the lowest mean Brier over the two scoring sets. A difference
  under 0.002 is a tie, broken in favour of (c), then (a).
Site offsets (the fog's local part). At a site s: logit p = alpha + a_s + (beta + b_s) * x with independent priors
  a_s ~ N(0, tau_a^2), b_s ~ N(0, tau_b^2). tau_a = max(1.0, sd of the intercepts of (a) and (b)); tau_b =
  max(0.5, sd of their slopes) (sample sd of two values = |difference| / sqrt 2). Two sites cannot estimate a
  between-site spread; the floors keep the prior wide if the two sites happen to agree.
Count likelihood. log10(count) ~ Logistic(location log10(900) + s * eta, scale s), which makes P(count > 900) =
  sigmoid(eta) exactly. s is the maximum-likelihood scale on the 390 training samples with eta from (c) at each
  sample's own site intercept. Counts under 1 are read as 1.
States (replaced, see DEVIATION 1 in run()). T_higher = share of the 390 training samples over 900. T_high = the Peirce cut (hit rate minus false-alarm
  rate, maximised) of the chosen model's probabilities on the 390 training samples at its deployed intercept. If
  T_high <= T_higher the build stops. State from the median probability: high if >= T_high, higher if >= T_higher,
  usual otherwise; "unknown" overrides all three when fog >= 0.5.
Fog, quests and the citizen update: see pipeline/offsets.py (same date, same rule: fixed before any fit).
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
from scipy.optimize import minimize_scalar
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score

from . import bath, config, oah, offsets, rainarchive
from .fetch import Fetcher
from .model import peirce_threshold

PARIS = ZoneInfo("Europe/Paris")
TIE = 0.002
TAU_A_FLOOR, TAU_B_FLOOR = 1.0, 0.5
FOG_UNKNOWN = 0.5
HIGH_P = 0.5
LOG10_900 = math.log10(config.THRESHOLD)
BATH_TRAIN, BATH_TEST = bath.TRAIN_YEARS, bath.TEST_YEAR


@dataclass(frozen=True)
class Obs:
    site: str          # "bath" | "toulouse"
    t_utc: dt.datetime
    local: str
    ecoli: float
    r48: float
    qualifier: str = ""          # "<" or ">" as the laboratory published it; "" for an exact count
    bound: float | None = None   # the qualified count's bound (per 100 ml); None for an exact count

    @property
    def x(self) -> float:
        return rainarchive.x_of(self.r48)

    @property
    def y(self) -> int:
        lab = config.label(self.bound if self.qualifier else self.ecoli, self.qualifier)
        if lab is None:
            raise ValueError(f"{self.site} {self.local}: the qualifier leaves the label undecided")
        return int(lab)


# ---- data --------------------------------------------------------------------------------------------------
def load(f: Fetcher, b: bath.Bath | None = None, tl: dict[str, Any] | None = None) -> dict[str, Any]:
    b = b or bath.load(f)
    rb = rainarchive.hourly(f, "openmeteo_era5_hourly_warleigh.json", rainarchive.WARLEIGH_POINT,
                            "2020-12-25", "2025-12-31")
    rt = rainarchive.hourly(f, "openmeteo_era5_hourly_pech_david.json", rainarchive.PECH_DAVID_POINT,
                            "2015-12-25", "2025-12-31")
    bath_obs = [Obs("bath", j.sample.t, j.sample.local, j.sample.ecoli, rainarchive.r48(rb, j.sample.t),
                    j.sample.operator, j.sample.ecoli if j.sample.operator else None) for j in b.joined]
    tl = tl or oah.toulouse(f)
    tou_obs = []
    for r in tl["rows"]:
        if not r["time"]:
            raise RuntimeError(f"Toulouse sample {r['date']} has no time")
        t = dt.datetime.fromisoformat(f"{r['date']}T{r['time']}").replace(tzinfo=PARIS).astimezone(dt.timezone.utc)
        tou_obs.append(Obs("toulouse", t, f"{r['date']}T{r['time']}", float(r["ecoli_per_100ml"]),
                           rainarchive.r48(rt, t), r["qualifier"], r["bound_per_100ml"]))
    return {"bath": b, "bath_obs": bath_obs, "tou_obs": tou_obs, "toulouse": tl}


# ---- fitting -----------------------------------------------------------------------------------------------
def newton_logit(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    w = np.zeros(X.shape[1])
    for _ in range(100):
        p = 1 / (1 + np.exp(-(X @ w)))
        H = X.T @ (X * (p * (1 - p))[:, None])
        step = np.linalg.solve(H, X.T @ (y - p))
        w = w + step
        if np.max(np.abs(step)) < 1e-12:
            return w
    raise RuntimeError("logistic fit did not converge")


@dataclass(frozen=True)
class Fit:
    name: str
    alpha: float            # the intercept used at a site the model has not seen
    beta: float
    site_alpha: dict[str, float]

    def p(self, xs: np.ndarray) -> np.ndarray:
        return 1 / (1 + np.exp(-(self.alpha + self.beta * xs)))


def fit_single(name: str, obs: list[Obs]) -> Fit:
    X = np.column_stack([np.ones(len(obs)), [o.x for o in obs]])
    a, b = newton_logit(X, np.array([o.y for o in obs], float))
    return Fit(name, float(a), float(b), {obs[0].site: float(a)})


def fit_pooled(obs: list[Obs]) -> Fit:
    sites = sorted({o.site for o in obs})
    X = np.column_stack([[float(o.site == s) for o in obs] for s in sites] + [[o.x for o in obs]])
    w = newton_logit(X, np.array([o.y for o in obs], float))
    site_alpha = {s: float(w[i]) for i, s in enumerate(sites)}
    return Fit("pooled", float(np.mean(list(site_alpha.values()))), float(w[-1]), site_alpha)


def score(y: np.ndarray, p: np.ndarray, train_rate: float | np.ndarray) -> dict[str, Any]:
    """train_rate: one training base rate, or per sample the base rate of the fold that predicted it."""
    ex = int(y.sum())
    return {"n": int(len(y)), "exceedances": ex,
            "auc": float(roc_auc_score(y, p)) if 0 < ex < len(y) else None,
            "brier": float(np.mean((p - y) ** 2)),
            "brier_train_base_rate": float(np.mean((train_rate - y) ** 2)),
            "brier_own_base_rate": float(np.mean((y.mean() - y) ** 2)),
            "train_base_rate": float(np.mean(train_rate)), "mean_probability": float(p.mean())}


def loyo_toulouse(kind: str, tou: list[Obs], bath_train: list[Obs]) -> tuple[np.ndarray, np.ndarray]:
    """Out-of-fold probabilities for every Toulouse sample, each calendar year predicted by a fit without it, and per
    sample the share over 900 in that fit's training data (the fold's base-rate baseline, held year excluded)."""
    p = np.zeros(len(tou))
    rate = np.zeros(len(tou))
    years = sorted({o.local[:4] for o in tou})
    for yr in years:
        keep = [o for o in tou if o.local[:4] != yr]
        idx = [i for i, o in enumerate(tou) if o.local[:4] == yr]
        train = keep if kind == "toulouse" else bath_train + keep
        m = fit_single("toulouse", keep) if kind == "toulouse" else fit_pooled(train)
        p[idx] = m.p(np.array([tou[i].x for i in idx]))
        rate[idx] = np.mean([o.y for o in train])
    return p, rate


def evaluate(bath_train: list[Obs], bath_test: list[Obs], tou: list[Obs]) -> dict[str, Any]:
    fits = {"bath": fit_single("bath", bath_train), "toulouse": fit_single("toulouse", tou),
            "pooled": fit_pooled(bath_train + tou)}
    rate = {"bath": float(np.mean([o.y for o in bath_train])), "toulouse": float(np.mean([o.y for o in tou])),
            "pooled": float(np.mean([o.y for o in bath_train + tou]))}
    y_t = np.array([o.y for o in tou], float)
    y_b = np.array([o.y for o in bath_test], float)
    x_t = np.array([o.x for o in tou])
    x_b = np.array([o.x for o in bath_test])
    table: dict[str, dict[str, Any]] = {}
    for k, m in fits.items():
        p_t, r_t = (m.p(x_t), rate[k]) if k == "bath" else loyo_toulouse(k, tou, bath_train)
        cells = {"toulouse": {**score(y_t, p_t, r_t),
                              "kind": "cross-site" if k == "bath" else "same site, leave-one-year-out",
                              "predictions": "as fitted" if k == "bath" else "each year from a fit without it"},
                 "bath_2025": {**score(y_b, m.p(x_b), rate[k]),
                               "kind": "cross-site" if k == "toulouse" else "same site, held-out year",
                               "predictions": "as fitted"}}
        table[k] = {"cells": cells, "mean_brier": (cells["toulouse"]["brier"] + cells["bath_2025"]["brier"]) / 2,
                    "mean_brier_role": "candidate-selection validation score (the pre-registered rule picks the "
                                       "lowest); not an independent test of the chosen model",
                    "alpha_new_site": m.alpha, "beta": m.beta, "site_alpha": m.site_alpha}
    return {"fits": fits, "table": table, "train_rate": rate}


def select(table: dict[str, dict[str, Any]]) -> tuple[str, str]:
    """The pre-registered rule: lowest mean Brier; within TIE, (c) pooled, then (a) Bath."""
    order = {"pooled": 0, "bath": 1, "toulouse": 2}
    best = min(table.values(), key=lambda r: r["mean_brier"])["mean_brier"]
    tied = [k for k, r in table.items() if r["mean_brier"] - best < TIE]
    pick = min(tied, key=order.get)
    why = (f"lowest mean Brier over the two scoring sets ({best:.4f})" if len(tied) == 1 else
           f"tied within {TIE} of the lowest mean Brier ({best:.4f}) with {sorted(set(tied) - {pick})}; "
           f"tie-break order pooled, bath")
    return pick, why


def count_nll(eta: np.ndarray, obs: list[Obs], s: float) -> float:
    """Negative log-likelihood of the counts under log10(count) ~ Logistic(log10(900) + s * eta, s). An exact count
    contributes its density; a count published below a bound ("<") the chance of lying under it (the CDF), and one
    published above a bound (">") the chance of lying over it (DATED CHANGE 2026-10-03: qualified counts were read
    as exact values before)."""
    q = np.array([o.qualifier for o in obs])
    L = np.log10(np.maximum([o.bound if o.qualifier else o.ecoli for o in obs], 1.0))
    u = (L - LOG10_900) / s - eta
    exact = q == ""
    return float(np.sum(u[exact] + 2 * np.logaddexp(0, -u[exact]) + math.log(s))
                 + np.sum(np.logaddexp(0, -u[q == "<"])) + np.sum(np.logaddexp(0, u[q == ">"])))


def count_scale(obs: list[Obs], pooled: Fit) -> float:
    eta = np.array([pooled.site_alpha[o.site] + pooled.beta * o.x for o in obs])
    r = minimize_scalar(lambda s: count_nll(eta, obs, s), bounds=(0.02, 5.0), method="bounded",
                        options={"xatol": 1e-10})
    return float(r.x)


def gauge_vs_openmeteo(joined: list, bath_obs: list[Obs]) -> dict[str, Any]:
    """Report only: the Claverton gauge (2 latest finished gauge days) against Open-Meteo ERA5 r48 at the same samples."""
    g = np.array([j.rain_2d for j in joined])
    o = np.array([ob.r48 for ob in bath_obs])
    y = np.array([ob.y for ob in bath_obs])
    test = np.array([ob.local[:4] == BATH_TEST for ob in bath_obs])
    wet = g >= 10
    return {"samples": int(len(g)), "spearman": float(spearmanr(g, o).statistic),
            "gauge_mean_mm": float(g.mean()), "openmeteo_mean_mm": float(o.mean()),
            "gauge_ge10": int(wet.sum()), "gauge_ge10_openmeteo_ge10": int((wet & (o >= 10)).sum()),
            "gauge_ge10_median_ratio": float(np.median(o[wet] / g[wet])) if wet.any() else None,
            "auc_all_gauge": float(roc_auc_score(y, g)), "auc_all_openmeteo": float(roc_auc_score(y, o)),
            "auc_2025_gauge": float(roc_auc_score(y[test], g[test])),
            "auc_2025_openmeteo": float(roc_auc_score(y[test], o[test])),
            "note": "gauge = Environment Agency Bath Claverton daily rain over the 2 latest gauge days (09:00-09:00 "
                    "GMT) that finished by the sample time; "
                    "Open-Meteo = ERA5 hourly r48 before the sample. AUC = chance an over-900 sample had more "
                    "rain than an under-900 one. Report only: the model is fitted and run on Open-Meteo rain."}


def _r48_reaching(p: offsets.Params, w: np.ndarray, t: float) -> float:
    """48 h rain (mm) at which the posterior predictive chance reaches t (bisection on x = ln(1 + r48))."""
    lo, hi = 0.0, 12.0
    if offsets.predictive(p, w, [lo])[0] >= t:
        return 0.0
    if offsets.predictive(p, w, [hi])[0] < t:
        raise RuntimeError(f"the predictive chance never reaches {t}")
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if offsets.predictive(p, w, [mid])[0] < t else (lo, mid)
    return math.expm1((lo + hi) / 2)


CALIB_NOTE = {"toulouse": "118 Pech David samples; the deployed fit includes them",
              "bath_2021_2024": "272 Warleigh samples; the deployed fit includes them",
              "bath_2025": "50 Warleigh samples, held out of every fit"}


def calibration(p: offsets.Params, w: np.ndarray, sets: dict[str, list[Obs]],
                table: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Predicted against observed share over 900, by site: the chance the app shows at a site with no counts
    (posterior predictive over the prior offsets), the fitted curve alone (plug-in), and for the scored sets the
    pooled candidate's out-of-sample plug-in mean (the citymodel.pooled.* rows)."""
    out: dict[str, Any] = {}
    for k, obs in sets.items():
        x = np.array([o.x for o in obs])
        y = np.array([o.y for o in obs])
        row = {"n": int(len(y)), "observed_exceedances": int(y.sum()), "observed_share": float(y.mean()),
               "predictive_mean": float(offsets.predictive(p, w, x).mean()),
               "plugin_mean": float((1 / (1 + np.exp(-(p.alpha + p.beta * x)))).mean())}
        cell = {"toulouse": "toulouse", "bath_2025": "bath_2025"}.get(k)
        if cell:
            row["pooled_scored_plugin_mean"] = float(table["pooled"]["cells"][cell]["mean_probability"])
        out[k] = {**row, "note": CALIB_NOTE[k]}
    allx = np.array([o.x for obs in sets.values() for o in obs])
    ally = np.array([o.y for obs in sets.values() for o in obs])
    out["all"] = {"n": int(len(ally)), "observed_exceedances": int(ally.sum()), "observed_share": float(ally.mean()),
                  "predictive_mean": float(offsets.predictive(p, w, allx).mean()),
                  "plugin_mean": float((1 / (1 + np.exp(-(p.alpha + p.beta * allx)))).mean()),
                  "note": "all 440 samples of both sites"}
    return out


def public(cm: dict[str, Any]) -> dict[str, Any]:
    """The JSON-ready part of run()'s result, with the scored samples."""
    out = {k: v for k, v in cm.items() if k not in ("obs", "toulouse_pack", "bath_pack")}
    out["preregistration"] = __doc__
    out["samples"] = {site: [{"time_utc": o.t_utc.isoformat().replace("+00:00", "Z"), "time_local": o.local,
                              "ecoli_per_100ml": o.ecoli, "qualifier": o.qualifier, "bound_per_100ml": o.bound,
                              "over_900": bool(o.y), "r48_mm": round(o.r48, 3)}
                             for o in obs] for site, obs in cm["obs"].items()}
    return out


def numbers(num: Any, cm: dict[str, Any]) -> None:
    src = ["data/raw/openmeteo_era5_hourly_warleigh.json", "data/raw/openmeteo_era5_hourly_pech_david.json",
           "data/raw/wessex_wq_warleigh.json", "data/raw/hubeau_pech_david_ecoli.json"]
    fn = "pipeline.citymodel.run"
    what = {"chosen": "candidate picked by the pre-registered rule (lowest mean Brier)",
            "alpha": "deployed intercept (log-odds at no rain, new site)", "beta": "rain slope per ln(1 + r48 mm)",
            "tau_a": "prior sd of a site's intercept offset (log-odds)",
            "tau_b": "prior sd of a site's rain-slope offset", "count_scale_s": "logistic scale of log10 E. coli",
            "t_higher": "probability where 'higher' starts (Peirce cut, training only)",
            "t_high": "probability where 'high' starts", "fog_unknown": "fog at which the state is 'unknown'",
            "t_higher_r48_mm": "48 h rain at which a new site reaches 'higher' (no local samples; posterior "
                               "predictive)",
            "t_high_r48_mm": "48 h rain at which a new site reaches 'high' (no local samples; posterior predictive)",
            "t_higher_r48_mm_plugin": "48 h rain at which the fitted curve alone (no offset uncertainty) reaches "
                                      "'higher'",
            "t_high_r48_mm_plugin": "48 h rain at which the fitted curve alone reaches 'high'",
            "p_dry": "chance over 900 at a new site after no rain (posterior predictive over the prior offsets, "
                     "what the app shows)",
            "p_dry_plugin": "chance over 900 after no rain from the fitted curve alone (no offset uncertainty)",
            "train_n": "training samples (Bath 2021-2024 + Toulouse)",
            "train_exceedances": "training samples over 900", "toulouse_n": "Toulouse samples scored",
            "bath_test_n": "Bath 2025 samples scored"}
    for k, w in what.items():
        num.add(f"citymodel.{k}", cm[k], w, src, fn)
    for grp, c in cm["calibration"].items():
        for k, v in c.items():
            if k != "note":
                num.add(f"citymodel.calibration.{grp}.{k}", v, f"calibration on {grp} ({c['note']}): "
                        f"{k.replace('_', ' ')}", src, "pipeline.citymodel.calibration")
    for cand, r in cm["candidates"].items():
        num.add(f"citymodel.{cand}.mean_brier", r["mean_brier"], f"{cand} candidate: mean Brier over the two sets, "
                "the candidate-selection validation score (used to pick the model, not an independent test)",
                src, fn)
        for cell, c in r["cells"].items():
            for k in ("n", "exceedances", "auc", "brier", "brier_train_base_rate", "brier_own_base_rate",
                      "mean_probability"):
                num.add(f"citymodel.{cand}.{cell}.{k}", c[k], f"{cand} candidate on {cell} ({c['kind']}): "
                        f"{k.replace('_', ' ')}", src, "pipeline.citymodel.evaluate")
    for k, v in cm["gauge_vs_openmeteo"].items():
        if k != "note":
            num.add(f"citymodel.gauge.{k}", v, f"Bath gauge vs Open-Meteo ERA5 at the 322 samples: {k}",
                    src + ["data/raw/ea_rain_claverton_daily.csv"], "pipeline.citymodel.gauge_vs_openmeteo")


def run(f: Fetcher, b: bath.Bath | None = None, tl: dict[str, Any] | None = None) -> dict[str, Any]:
    d = load(f, b, tl)
    bo, tou = d["bath_obs"], d["tou_obs"]
    bath_train = [o for o in bo if o.local[:4] in BATH_TRAIN]
    bath_test = [o for o in bo if o.local[:4] == BATH_TEST]
    ev = evaluate(bath_train, bath_test, tou)
    chosen, why = select(ev["table"])
    fits: dict[str, Fit] = ev["fits"]
    m = fits[chosen]
    tau_a = max(TAU_A_FLOOR, abs(fits["bath"].alpha - fits["toulouse"].alpha) / math.sqrt(2))
    tau_b = max(TAU_B_FLOOR, abs(fits["bath"].beta - fits["toulouse"].beta) / math.sqrt(2))
    train = bath_train + tou
    s = count_scale(train, fits["pooled"])
    y_tr = np.array([o.y for o in train])
    p_tr = m.p(np.array([o.x for o in train]))
    # DEVIATION 1 (2026-09-25, logged before any cross-site result was printed): the pre-registered pair
    # (T_higher = training share over 900, T_high = Peirce cut) failed its own guard: Peirce 0.2835 <= share
    # 0.3615. Replacement, still training-only: T_higher = the Peirce cut; T_high = 0.5, "over 900 is more
    # likely than not".
    failed = {"t_higher_share": float(y_tr.mean()), "t_high_peirce": peirce_threshold(y_tr, p_tr)}
    t_higher = failed["t_high_peirce"]
    t_high = HIGH_P
    if t_high <= t_higher:
        raise RuntimeError(f"state rule failed: T_high {t_high} <= T_higher {t_higher}")
    # DATED CHANGE (2026-10-02): the app's chance is the posterior predictive (pipeline/offsets.py). At a new site
    # (prior offsets) the rain that reaches each state, the dry chance and the calibration are reported on that
    # scale; the plug-in values (the fit itself, no offset uncertainty) are kept under *_plugin.
    pp = offsets.Params(m.alpha, m.beta, tau_a, tau_b, s, t_higher, t_high, FOG_UNKNOWN)
    w0 = offsets.weights(offsets.prior(pp))
    r48_at = {"t_high_r48_mm": _r48_reaching(pp, w0, t_high), "t_higher_r48_mm": _r48_reaching(pp, w0, t_higher),
              "t_high_r48_mm_plugin": math.expm1((math.log(t_high / (1 - t_high)) - m.alpha) / m.beta),
              "t_higher_r48_mm_plugin": math.expm1((math.log(t_higher / (1 - t_higher)) - m.alpha) / m.beta)}
    calib = calibration(pp, w0, {"toulouse": tou, "bath_2021_2024": bath_train, "bath_2025": bath_test},
                        ev["table"])
    return {
        "chosen": chosen, "why": why, "alpha": m.alpha, "beta": m.beta,
        "tau_a": tau_a, "tau_b": tau_b, "count_scale_s": s,
        "t_higher": t_higher, "t_high": t_high, "state_rule_preregistered_failed": failed, "fog_unknown": FOG_UNKNOWN, **r48_at,
        "p_dry": float(offsets.predictive(pp, w0, [0.0])[0]), "p_dry_plugin": float(1 / (1 + math.exp(-m.alpha))),
        "calibration": calib,
        "candidates": ev["table"], "train_n": len(train), "train_exceedances": int(y_tr.sum()),
        "bath_train_n": len(bath_train), "bath_test_n": len(bath_test), "toulouse_n": len(tou),
        "gauge_vs_openmeteo": gauge_vs_openmeteo(d["bath"].joined, bo),
        "rain": {"source": "Open-Meteo historical archive, model era5 (0.25 degree), hourly precipitation",
                 "input": "x = ln(1 + r48); r48 = rain (mm) in the 48 hourly stamps ending at the time floored to "
                          "the UTC hour (each stamp holds the preceding hour's rain)",
                 "forecast": "the same r48 per ensemble member from the Open-Meteo ECMWF IFS 0.25 ensemble"},
        "obs": {"bath": bo, "toulouse": tou}, "toulouse_pack": d["toulouse"], "bath_pack": d["bath"],
    }
