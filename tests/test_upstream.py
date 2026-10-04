"""The quest tie-break: upstream stream length, reaches, the spread rule, and Coimbra's quests."""
from __future__ import annotations

import json
import random

import pytest

from pipeline import config, nowcast, oah, upstream
from pipeline.fetch import Fetcher
from pipeline.rivers import haversine_m

# A Y-shaped network, every way drawn downstream: tributaries A (north) and B (east) meet at J, then a main stem.
J = [0.0, 45.0]
WAYS = [
    {"coordinates": [[0.0, 45.01], [0.0, 45.005], J]},                  # A
    {"coordinates": [[0.02, 45.0], [0.01, 45.0], J]},                   # B
    {"coordinates": [J, [0.0, 44.99], [0.0, 44.98]]},                   # main stem
]
A_KM = haversine_m(45.01, 0.0, 45.0, 0.0) / 1000
B_KM = haversine_m(45.0, 0.02, 45.0, 0.0) / 1000


def _sites(net: upstream.StreamNet) -> dict[str, dict]:
    return {"a": net.site(45.0075, 0.00001),          # halfway down A's first segment
            "b": net.site(45.00001, 0.015),           # halfway along B's first segment
            "main": net.site(44.995, 0.00001),        # halfway down the main stem's first segment
            "a2": net.site(45.0025, -0.00001),        # A's second segment: same reach as "a"
            "far": net.site(45.5, 0.5)}               # ~60 km away: does not snap


def test_synthetic_three_sites() -> None:
    s = _sites(upstream.StreamNet(WAYS))
    assert s["a"]["upstream_km"] == pytest.approx(A_KM / 4, abs=0.005)
    assert s["b"]["upstream_km"] == pytest.approx(B_KM / 4, abs=0.005)
    assert s["main"]["upstream_km"] == pytest.approx(A_KM + B_KM + A_KM / 2, abs=0.005)
    assert s["far"] == {"upstream_km": 0.0, "snapped": False, "snap_m": s["far"]["snap_m"], "reach": None}
    assert s["far"]["snap_m"] > upstream.SNAP_M
    assert all(s[k]["snapped"] and s[k]["snap_m"] < 2 for k in ("a", "b", "main", "a2"))
    # J is a confluence: A, B and the main stem are three reaches; both points on A share one.
    assert len({s[k]["reach"] for k in ("a", "b", "main")}) == 3 and s["a2"]["reach"] == s["a"]["reach"]
    # Tied scores rank by upstream length (main 2.2, a2 0.83, b 0.39, a 0.28 km); the unsnapped site last.
    cands = [{"code": k, "_score": 0.2, **v} for k, v in s.items()]
    assert [q["code"] for q in upstream.rank(cands)] == ["main", "a2", "b", "a", "far"]


def test_criterion_deterministic() -> None:
    """Same numbers from the same network, whatever the order of ways, and whatever the order of candidates."""
    base = _sites(upstream.StreamNet(WAYS))
    assert _sites(upstream.StreamNet(WAYS)) == base
    assert _sites(upstream.StreamNet(WAYS[::-1])) == base
    cands = [{"code": k, "_score": 0.2, **v} for k, v in base.items()]
    want = [q["code"] for q in upstream.select(cands)]
    for seed in range(5):
        random.Random(seed).shuffle(cands)
        assert [q["code"] for q in upstream.select([dict(q) for q in cands])] == want


def test_select_spreads_over_reaches() -> None:
    def c(code: str, score: float, reach: str | None, km: float) -> dict:
        return {"code": code, "_score": score, "reach": reach, "upstream_km": km}
    cands = [c("V", 0.30, "r1", 1.0), c("X", 0.20, "r1", 10.0), c("Y", 0.20, "r2", 9.0), c("Z", 0.20, "r2", 5.0),
             c("W", 0.20, "r3", 0.5), c("N", 0.20, None, 0.0), c("U", 0.10, "r9", 99.0)]
    got = upstream.select(cands)
    assert [q["code"] for q in got] == ["V", "Y", "W"]          # X and Z wait: their reaches already hold a quest
    assert [q["chosen_by"] for q in got] == ["fog reduction", "different reach (tied fog reduction)",
                                             "different reach (tied fog reduction)"]
    # No equally scored alternative on another reach: the same reach is allowed; unsnapped sites come last.
    got = upstream.select([c("X", 0.2, "r1", 3.0), c("Y", 0.2, "r1", 2.0), c("N", 0.2, None, 0.0)])
    assert [q["code"] for q in got] == ["X", "Y", "N"]
    # A lower score never outranks a higher one, whatever its reach or upstream length.
    got = upstream.select([c("X", 0.2, "r1", 1.0), c("Y", 0.2, "r1", 1.0), c("U", 0.1, "r2", 99.0)], k=2)
    assert [q["code"] for q in got] == ["X", "Y"] and got[0]["chosen_by"].startswith("site code")


_FETCH_CITY = nowcast.fetch_city       # the real one; each Coimbra run below patches the module's copy


# ---- Coimbra -----------------------------------------------------------------------------------------------------
def _out(name: str) -> dict:
    p = config.OUT / name
    if not p.exists():
        pytest.skip("run `python -m pipeline build` first")
    return json.loads(p.read_text(encoding="utf-8"))


def _coimbra(monkeypatch: pytest.MonkeyPatch, order: list[int], relabel: bool) -> list[str]:
    """Coimbra's quests (as original site codes) with the sites fed in `order`, optionally with codes whose
    alphabetical order is reversed."""
    spec = _out("update_spec.json")
    ww = _out("city_CO.json")["waterways"]["features"]
    f = Fetcher(offline=True)
    sites = [s for s in oah.api(f, "/sites/all", "oah_sites.json") if s["city"]["id"] == "CO"]
    data, fetched = _FETCH_CITY(f, "CO", sites)
    codes = sorted(s["code"] for s in sites)
    new = {c: f"X{len(codes) - k:02d}" for k, c in enumerate(codes)} if relabel else {c: c for c in codes}
    back = {v: k for k, v in new.items()}
    sites_p = [{**sites[i], "code": new[sites[i]["code"]]} for i in order]
    monkeypatch.setattr(nowcast, "fetch_city", lambda _f, _cid, _s: ([data[i] for i in order], fetched))
    p = nowcast.params_from_spec(spec)
    pk = nowcast.city(f, p, "CO", sites_p, nowcast.model_version(p), ww)
    return [back[q["code"]] for q in pk["quests"]]


@pytest.mark.skipif(
    any(not (config.RAW / name).is_file() for name in ('oah_sites.json',)),
    reason="OneAquaHealth raw responses are not redistributed; run `python -m pipeline build` online to acquire the local raw cache",
)
def test_coimbra_quests_not_alphabetical(monkeypatch: pytest.MonkeyPatch) -> None:
    pk = _out("nowcast_CO.json")
    n = len(pk["sites"])
    base = _coimbra(monkeypatch, list(range(n)), relabel=False)
    assert base == [q["code"] for q in pk["quests"]]
    assert _coimbra(monkeypatch, list(range(n))[::-1], relabel=True) == base
    order = list(range(n))
    random.Random(7).shuffle(order)
    assert _coimbra(monkeypatch, order, relabel=True) == base
    # The tied quests were decided by upstream length or reach, never by site code; no two share a reach.
    assert all(not q["chosen_by"].startswith("site code") for q in pk["quests"])
    reaches = [q["reach"] for q in pk["quests"]]
    assert None not in reaches and len(set(reaches)) == len(reaches)


def test_grid_cells_reported() -> None:
    for c in config.OAH_CITIES:
        pk = _out(f"nowcast_{c}.json")
        cells = pk["grid_cells"]
        assert sum(g["sites"] for g in cells) == len(pk["sites"])
        cell_of_site = {(s["grid_lat"], s["grid_lon"]) for s in pk["sites"]}
        assert {(g["grid_lat"], g["grid_lon"]) for g in cells} == cell_of_site
        assert [g["sites"] for g in cells] == sorted((g["sites"] for g in cells), reverse=True)
