"""Standing checks on the city model: cross-site numbers, thresholds, the citizen update, dark hours, the nowcast."""
from __future__ import annotations

import json
import math
import re
import warnings

import pytest

from pipeline import citymodel, config
from pipeline.fetch import Fetcher

warnings.filterwarnings("ignore", message="Unknown solver options")


def _out(name: str) -> dict:
    p = config.OUT / name
    if not p.exists():
        pytest.skip("run `python -m pipeline build` first")
    return json.loads(p.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def cm() -> dict:
    return citymodel.run(Fetcher(offline=True))


def test_cross_site(cm: dict) -> None:
    c = cm["candidates"]
    a_to = c["bath"]["cells"]["toulouse"]
    assert a_to["kind"] == "cross-site" and (a_to["n"], a_to["exceedances"]) == (118, 10)
    assert round(a_to["auc"], 4) == 0.7884 and round(a_to["brier"], 4) == 0.2305
    assert round(a_to["brier_train_base_rate"], 4) == 0.2351 and round(a_to["brier_own_base_rate"], 4) == 0.0776
    b_ba = c["toulouse"]["cells"]["bath_2025"]
    assert b_ba["kind"] == "cross-site" and (b_ba["n"], b_ba["exceedances"]) == (50, 14)
    assert round(b_ba["auc"], 4) == 0.7659 and round(b_ba["brier"], 4) == 0.2220
    assert round(b_ba["brier_train_base_rate"], 4) == 0.2397 and round(b_ba["brier_own_base_rate"], 4) == 0.2016
    assert {k: round(v["mean_brier"], 4) for k, v in c.items()} == {"bath": 0.2194, "toulouse": 0.1444,
                                                                     "pooled": 0.1335}
    assert cm["chosen"] == "pooled"
    # leave-one-year-out cells: the base-rate baseline uses each fold's training share (held year excluded)
    assert round(c["toulouse"]["cells"]["toulouse"]["brier_train_base_rate"], 4) == 0.0813
    assert round(c["pooled"]["cells"]["toulouse"]["brier_train_base_rate"], 4) == 0.1601
    assert (cm["train_n"], cm["train_exceedances"]) == (390, 141)


def test_parameters_and_thresholds(cm: dict) -> None:
    assert round(cm["alpha"], 4) == -2.7815 and round(cm["beta"], 4) == 1.1118
    assert round(cm["tau_a"], 4) == 2.2624 and cm["tau_b"] == 0.5
    assert round(cm["count_scale_s"], 4) == 0.2608   # censored "<" counts (2026-10-03); 0.2675 read them as 1
    assert round(cm["t_higher"], 4) == 0.2835 and cm["t_high"] == 0.5 and cm["fog_unknown"] == 0.5
    assert cm["t_higher"] < cm["t_high"]
    spec = _out("update_spec.json")["params"]
    for k, v in (("alpha", "alpha"), ("beta", "beta"), ("tau_a", "tau_a"), ("tau_b", "tau_b"),
                 ("s", "count_scale_s"), ("t_higher", "t_higher"), ("t_high", "t_high")):
        assert spec[k] == pytest.approx(cm[v], rel=1e-9)   # the fit converges to ~1e-11 differently across platforms


def test_gauge_vs_openmeteo(cm: dict) -> None:
    g = cm["gauge_vs_openmeteo"]
    # gauge days finished by the sample time (2026-10-03 timing fix; before: 62, 46, 0.7976)
    assert (g["samples"], g["gauge_ge10"], g["gauge_ge10_openmeteo_ge10"]) == (322, 65, 41)
    assert round(g["auc_2025_gauge"], 4) == 0.7798 and round(g["auc_2025_openmeteo"], 4) == 0.7659


# ---- the citizen update, re-implemented with plain loops (what the TypeScript engine does) -----------------------
def _sp(z: float) -> float:
    return max(z, 0.0) + math.log1p(math.exp(-abs(z)))


def _sig(z: float) -> float:
    return 1 / (1 + math.exp(-z))


def _q(v: list[float], q: float) -> float:
    h = (len(v) - 1) * q
    lo = math.floor(h)
    return v[-1] if lo >= len(v) - 1 else v[lo] + (h - lo) * (v[lo + 1] - v[lo])


def _replay(spec: dict, vec: dict) -> dict:
    P, a, b = spec["params"], spec["axes"]["a"], spec["axes"]["b"]
    lw = [[-(ai * ai / (2 * P["tau_a"] ** 2) + bj * bj / (2 * P["tau_b"] ** 2)) for bj in b] for ai in a]
    for st in vec["steps"]:
        x, obs = math.log1p(st["r48_mm"]), st["obs"]
        for i, ai in enumerate(a):
            for j, bj in enumerate(b):
                eta = P["alpha"] + ai + (P["beta"] + bj) * x
                if "count" in obs:
                    u = (math.log10(max(obs["count"], 1.0)) - P["log10_900"]) / P["s"] - eta
                    lw[i][j] += -u - 2 * _sp(-u) - math.log(P["s"])
                else:
                    lw[i][j] += -_sp(-eta) if obs["over_900"] else -_sp(eta)
    mx = max(max(r) for r in lw)
    w = [[math.exp(v - mx) for v in r] for r in lw]
    tot = sum(sum(r) for r in w)
    w = [[v / tot for v in r] for r in w]
    ma = sum(w[i][j] * a[i] for i in range(len(a)) for j in range(len(b)))
    mb = sum(w[i][j] * b[j] for i in range(len(a)) for j in range(len(b)))
    va = sum(w[i][j] * (a[i] - ma) ** 2 for i in range(len(a)) for j in range(len(b)))
    vb = sum(w[i][j] * (b[j] - mb) ** 2 for i in range(len(a)) for j in range(len(b)))
    cab = sum(w[i][j] * (a[i] - ma) * (b[j] - mb) for i in range(len(a)) for j in range(len(b)))
    xs = sorted(math.log1p(r) for r in vec["probe_members_r48_mm"])
    # the posterior predictive chance per member (offsets.py, 2026-10-02 change)
    pk = sorted(sum(w[i][j] * _sig(P["alpha"] + a[i] + (P["beta"] + b[j]) * x)
                    for i in range(len(a)) for j in range(len(b))) for x in xs)
    p10, p50, p90 = _q(pk, 0.1), _q(pk, 0.5), _q(pk, 0.9)
    xt = _q(xs, 0.5)
    eta_t = P["alpha"] + ma + (P["beta"] + mb) * xt
    sd = math.sqrt(max(va + 2 * xt * cab + xt * xt * vb, 0.0))
    fl = _sig(eta_t + P["z90"] * sd) - _sig(eta_t - P["z90"] * sd)
    fr = p90 - p10
    fog = min(1.0, math.sqrt(fr * fr + fl * fl))
    st = ("unknown" if fog >= P["fog_unknown"] else "high" if p50 >= P["t_high"]
          else "higher" if p50 >= P["t_higher"] else "usual")
    return {"mean_a": ma, "mean_b": mb, "var_a": va, "var_b": vb, "cov_ab": cab, "p_dry": sum(w[i][j] * _sig(P["alpha"] + a[i]) for i in range(len(a)) for j in range(len(b))),
            "p10": p10, "p50": p50, "p90": p90, "x_median": xt, "fog_rain": fr, "fog_local": fl, "fog": fog,
            "state": st}


def test_update_vectors() -> None:
    spec = _out("update_spec.json")
    assert len(spec["vectors"]) == 5
    for vec in spec["vectors"]:
        got = _replay(spec, vec)
        for k, v in vec["expected"].items():
            if isinstance(v, str):
                assert got[k] == v, (vec["name"], k)
            else:
                assert abs(got[k] - v) < 1e-9, (vec["name"], k, got[k], v)
    by = {v["name"]: v["expected"] for v in spec["vectors"]}
    assert by["storm hour (20 mm in 48 h), a count of 31000"]["state"] == "high"
    assert spec["prior_at_probe"]["state"] == "unknown"


# ---- outputs -----------------------------------------------------------------------------------------------------
SAFE = re.compile(r"\bsafe\b", re.IGNORECASE)


def test_no_safe_state() -> None:
    for name in ["update_spec.json", "city_model.json", "dark_hours.json"] + \
                [f"nowcast_{c}.json" for c in config.OAH_CITIES]:
        text = (config.OUT / name).read_text(encoding="utf-8") if (config.OUT / name).exists() else None
        if text is None:
            pytest.skip("run `python -m pipeline build` first")
        assert not SAFE.search(text), name
    for c in config.OAH_CITIES:
        pk = _out(f"nowcast_{c}.json")
        assert pk["states"] == ["usual", "higher", "high", "unknown"]
        for s in pk["sites"]:
            assert set(s["state"]) <= {"usual", "higher", "high", "unknown", None}


def test_nowcast_shape() -> None:
    fields = {"code", "name", "window_start_local", "window_end_local", "fog_72h_mean_before",
              "fog_72h_mean_after_expected", "fog_at_hour_before", "fog_at_hour_after_expected", "tied_sites",
              "tied_with", "when_local", "window_rain_mm_p50", "rain_48h_to_window_end_mm_p50", "after_rain"}
    total = 0
    for c in config.OAH_CITIES:
        pk = _out(f"nowcast_{c}.json")
        total += len(pk["sites"])
        assert pk["forecast_fetched_utc"].endswith("Z") and pk["model_version"].startswith("afterrain-city-2:")
        assert 1 <= len(pk["quests"]) <= 3 and len({q["code"] for q in pk["quests"]}) == len(pk["quests"])
        for q in pk["quests"]:
            assert fields <= set(q)
            assert q["fog_72h_mean_after_expected"] < q["fog_72h_mean_before"]
        for s in pk["sites"]:
            assert len(s["fog"]) == len(pk["hours_utc"])
            assert all(0 <= x <= 1 for x in s["fog"] if x is not None)
    assert total == 106


def test_dark_hours() -> None:
    d = _out("dark_hours.json")
    s = d["summary"]
    assert (s["oneaquahealth"]["n"], s["oneaquahealth"]["dry"]) == (96, 80)
    assert {k: (v["dry"], v["n"]) for k, v in s["oneaquahealth_by_city"].items()} == {
        "GH": (17, 17), "OS": (20, 20), "TO": (21, 21), "CO": (16, 18), "BE": (6, 20)}
    assert (s["toulouse_garonne"]["n"], s["toulouse_garonne"]["dry"], s["toulouse_garonne"]["dry_over_900"]) == \
        (118, 36, 0)
    assert s["bath_warleigh"]["n"] == 322
    for rows in (d["oneaquahealth"], d["toulouse_garonne"], d["bath_warleigh"]):
        for r in rows:
            assert {"site", "city", "date", "rain_1d_mm", "rain_3d_mm", "rain_7d_mm", "dry"} <= set(r)


DRY_BY_CITY = {"GH": 17, "OS": 20, "TO": 21, "CO": 16, "BE": 6}
SAMPLED_BY_CITY = {"GH": 17, "OS": 20, "TO": 21, "CO": 18, "BE": 20}


def test_sites_sampled_after_rain() -> None:
    """Each site's 'measured after rain' flag is the dark-hours row's rain_3d >= thresholds.dry_mm_3d: 80 of the 96
    sampled sites say no, with the published per-city counts."""
    thr = _out("numbers.json")["thresholds.dry_mm_3d"]["value"]
    rows = {r["site"]: r for r in _out("dark_hours.json")["oneaquahealth"]}
    no = yes = 0
    for c in config.OAH_CITIES:
        sites = _out(f"nowcast_{c}.json")["sites"]
        for s in sites:
            r = rows.get(s["code"])
            if r is None:
                assert (s["oah_sample_date"], s["oah_sample_rain_3d_mm"], s["oah_sampled_after_rain"]) == (None,) * 3
            else:
                assert (s["oah_sample_date"], s["oah_sample_rain_3d_mm"]) == (r["date"], r["rain_3d_mm"])
                assert s["oah_sampled_after_rain"] is (r["rain_3d_mm"] >= thr) is (not r["dry"])
        c_no = sum(s["oah_sampled_after_rain"] is False for s in sites)
        c_yes = sum(s["oah_sampled_after_rain"] is True for s in sites)
        assert (c_no, c_yes) == (DRY_BY_CITY[c], SAMPLED_BY_CITY[c] - DRY_BY_CITY[c]), c
        no, yes = no + c_no, yes + c_yes
    assert (no, yes) == (80, 16)


def test_dark_hours_toulouse_two_day_rain() -> None:
    """The Garonne rows carry the 2-day rain behind 6 of 30: wet rows 30 with 6 over 900, the rest 88 with 4."""
    thr = _out("numbers.json")["thresholds.wet_mm_2d"]["value"]
    rows = _out("dark_hours.json")["toulouse_garonne"]
    wet = [r for r in rows if r["rain_2d_mm"] >= thr]
    rest = [r for r in rows if r["rain_2d_mm"] < thr]
    assert (len(wet), sum(r["over_900"] for r in wet)) == (30, 6)
    assert (len(rest), sum(r["over_900"] for r in rest)) == (88, 4)


def test_quest_objective() -> None:
    import datetime as dt
    """The 2026-09-26 objective: the score is the fog reduction summed over the benefit hours, and no quest is
    picked over a site with a higher score. The 2026-09-27 window: the sampling hour may be any forecast hour but
    the last, at local 08:00-19:00."""
    for c in config.OAH_CITIES:
        pk = _out(f"nowcast_{c}.json")
        assert pk["quests"]
        scores = []
        for q in pk["quests"]:
            assert q["benefit_basis"] in ("higher or high", "all forecast hours") and q["benefit_hours"] > 0
            assert q["fog_reduction_expected"] == pytest.approx(
                q["benefit_hours"] * (q["fog_benefit_mean_before"] - q["fog_benefit_mean_after_expected"]),
                abs=q["benefit_hours"] * 1e-4 + 1e-3)          # the two means are stored to 4 decimals
            assert q["best_hour_utc"] in pk["hours_utc"][:-1]
            # the 2026-10-02 rule: credited hours start when the result is back
            best = dt.datetime.fromisoformat(q["best_hour_utc"].replace("Z", "+00:00"))
            ready = dt.datetime.fromisoformat(q["result_ready_utc"].replace("Z", "+00:00"))
            assert q["lab_turnaround_h"] == config.LAB_TURNAROUND_H and ready - best == dt.timedelta(hours=24)
            assert 0 < q["benefit_hours"] <= q["benefit_hours_in_forecast"]
            assert 8 <= int(q["best_hour_local"][11:13]) <= 19
            assert 0 <= q["rain_window_mm_p50"] <= q["rain_window_mm_p90"]
            scores.append(q["fog_reduction_expected"])
        assert scores == sorted(scores, reverse=True)


DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
WEEKDAY = re.compile(rf"^({'|'.join(DAYS)}) (morning|afternoon|evening|daytime|morning to afternoon|"
                     r"afternoon to evening)$")


def test_quest_fields_2026_09_27() -> None:
    """after_rain is the 48 h rain to the window's end against thresholds.wet_mm_2d; tied_with names the city's
    other quests with the same score; when_local names the window's weekday; window_rain = rain_window p50."""
    import datetime as dt
    thr = _out("numbers.json")["thresholds.wet_mm_2d"]["value"]
    for c in config.OAH_CITIES:
        pk = _out(f"nowcast_{c}.json")
        sites = {s["code"]: s for s in pk["sites"]}
        codes = [q["code"] for q in pk["quests"]]
        for q in pk["quests"]:
            assert q["window_rain_mm_p50"] == q["rain_window_mm_p50"]
            assert q["after_rain"] is (q["rain_48h_to_window_end_mm_p50"] >= thr)
            # the member-median r48 at the window's end stamp, as the site's hourly series has it
            j = pk["hours_utc"].index(q["window_end_utc"])
            assert q["rain_48h_to_window_end_mm_p50"] == sites[q["code"]]["r48_p50_mm"][j]
            assert set(q["tied_with"]) <= set(codes) - {q["code"]}
            assert set(q["tied_with"]) <= set(q["tied_sites"])
            for o in pk["quests"]:
                if o["code"] in q["tied_with"]:
                    assert q["code"] in o["tied_with"] and o["fog_reduction_expected"] == q["fog_reduction_expected"]
            assert WEEKDAY.match(q["when_local"]), q["when_local"]
            start = dt.date.fromisoformat(q["window_start_local"][:10])
            assert q["when_local"].split()[0] == DAYS[start.weekday()]


def test_numbers_for_the_app() -> None:
    nums = _out("numbers.json")
    assert nums["warleigh.window_hours"]["value"] == 48 == _out("warleigh_backtest.json")["window_hours"]
    assert nums["darkhours.oah.wet_after_rain"]["value"] == 16 == nums["darkhours.oneaquahealth.not_dry"]["value"]
    assert nums["darkhours.oah.wet_after_5mm"]["value"] == nums["oah.dry.wet_5mm"]["value"]
    for c in config.OAH_CITIES:
        pk = _out(f"nowcast_{c}.json")
        assert nums[f"nowcast.{c}.forecast_end_utc"]["value"] == pk["hours_utc"][-1]
        assert nums[f"nowcast.{c}.fetched_utc"]["value"] == pk["forecast_fetched_utc"]


def test_numbers_registered() -> None:
    nums = _out("numbers.json")
    cmj = _out("city_model.json")
    assert nums["citymodel.chosen"]["value"] == cmj["chosen"] == "pooled"
    assert nums["citymodel.bath.toulouse.auc"]["value"] == round(cmj["candidates"]["bath"]["cells"]["toulouse"]["auc"], 4)
    for c in config.OAH_CITIES:
        assert f"nowcast.{c}.quest1.code" in nums and f"nowcast.{c}.fetched_utc" in nums
