"""The quest's credited hours (lab turnaround) and the posterior predictive chance, on synthetic forecasts."""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import numpy as np
import pytest

from pipeline import config, nowcast, offsets

# The deployed city model (tests/test_citymodel.py::test_parameters_and_thresholds pins the same values).
P = offsets.Params(alpha=-2.781543713829914, beta=1.1118077472081938, tau_a=2.2624363718759493, tau_b=0.5,
                   s=0.26075946796946714, t_higher=0.2834577053139992, t_high=0.5, fog_unknown=0.5)
UTC = ZoneInfo("UTC")


def _forecast(storm_hours: range) -> dict:
    """48 past hours + 7 forecast days, 51 members; 3 mm/h (+ a member-dependent 0-0.5 mm/h) inside storm_hours."""
    t0 = dt.datetime(2026, 1, 5, tzinfo=dt.timezone.utc)
    n = 48 + 7 * 24
    rng = np.random.default_rng(7)
    hourly: dict = {"time": [(t0 + dt.timedelta(hours=k)).strftime("%Y-%m-%dT%H:%M") for k in range(n)]}
    for m in range(51):
        r = np.zeros(n)
        r[list(storm_hours)] = 3.0 + rng.uniform(0, 0.5)
        hourly[f"precipitation_member{m:02d}"] = [round(float(v), 2) for v in r]
    return {"hourly": hourly}


def _quest(d: dict) -> tuple[dict, list[dt.datetime], list[int]]:
    times, R, X = nowcast.member_x(d)
    idx = list(range(48, len(times)))
    lw = offsets.prior(P)
    m0, w0 = offsets.moments(P, lw), offsets.weights(lw)
    benefit = nowcast.warning_hours(P, m0, w0, X, nowcast.forecast_hours(X, idx))
    q = nowcast.site_quest(P, lw, X, R, times, idx, UTC, benefit, "higher or high", nowcast.member_rain(d), 5.0)
    return q, times, benefit


def test_quest_credits_only_hours_after_the_result() -> None:
    """Rain from the forecast's first hour for 4 days: warning hours start at hour 0, before any sampling hour (from
    08:00), so some can never use the result. The old score credited all of them (benefit_hours = every warning
    hour); now only hours at or after sampling hour + LAB_TURNAROUND_H count."""
    q, times, benefit = _quest(_forecast(range(48, 48 + 96)))
    assert q is not None and len(benefit) > 0
    best = dt.datetime.fromisoformat(q["best_hour_utc"].replace("Z", "+00:00"))
    ready = best + dt.timedelta(hours=config.LAB_TURNAROUND_H)
    after = [j for j in benefit if times[j] >= ready]
    assert q["benefit_hours"] == len(after) and q["benefit_hours_in_forecast"] == len(benefit)
    assert q["benefit_hours"] < len(benefit)          # some warning hours fall before the result: not credited
    assert q["result_ready_utc"] == ready.strftime("%Y-%m-%dT%H:%MZ")


def test_no_quest_when_every_warning_hour_precedes_any_result() -> None:
    """Rain only in the 48 h before the forecast: every warning hour ends before a sample taken at the first
    08:00 could be back (the old score still posted a quest)."""
    q, _, benefit = _quest(_forecast(range(0, 30)))
    assert len(benefit) > 0
    assert q is None


def test_predictive_at_the_prior() -> None:
    """At a site with no counts and no rain, the chance averaged over the prior offsets is 16.5%; the plug-in
    sigmoid(alpha + mean offset) was 5.8%."""
    w = offsets.weights(offsets.prior(P))
    assert float(offsets.predictive(P, w, [0.0])[0]) == pytest.approx(0.1654, abs=1e-4)
    assert float(offsets.sigmoid(P.alpha + offsets.moments(P, offsets.prior(P)).ma)) == pytest.approx(0.0583, abs=1e-4)


def test_interpolated_predictive_matches_exact() -> None:
    """Quest scoring interpolates the predictive chance on the P_STEP lattice: within 1e-5 of the exact sum,
    for the prior and for a posterior after one count, and the fog matches hour_summary's."""
    lw = offsets.prior(P)
    for post in (lw, offsets.update(P, lw, np.log1p(20.0), {"count": 31000})):
        w = offsets.weights(post)
        x = np.linspace(0, 4.5, 397)
        exact = offsets.predictive(P, w, x)
        approx = offsets.predictive_many(P, w[None], x[None, :])[0, 0]
        assert np.max(np.abs(exact - approx)) < 1e-5
        X = np.sort(np.log1p(np.linspace(0, 30, 51)))[None, :]
        W, ms = offsets.moments_many(P, post)
        fog = offsets.fog_many(P, W, ms, X, np.array([float(offsets.quantile_sorted(X[0], 0.5))]))[0, 0]
        assert fog == pytest.approx(offsets.hour_summary(P, offsets.moments(P, post), X[0], w)["fog"], abs=1e-5)
