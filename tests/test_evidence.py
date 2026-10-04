"""Standing checks: the published numbers re-run from the cached inputs in data/raw (no network)."""
from __future__ import annotations

import json
import math
import warnings

import pytest

from pipeline import bath, config, evidence, oah, transfer
from pipeline.fetch import Fetcher, MissingInput

warnings.filterwarnings("ignore", message="Unknown solver options")


@pytest.fixture(scope="module")
def f() -> Fetcher:
    return Fetcher(offline=True)


@pytest.fixture(scope="module")
def b(f: Fetcher) -> bath.Bath:
    return bath.load(f)


@pytest.fixture(scope="module")
def table(b: bath.Bath) -> dict:
    return evidence.rule_table(b.joined)


def test_inputs(b: bath.Bath) -> None:
    assert len(b.spills) == 25154
    assert len({s.name for s in b.spills}) == 31
    assert len(b.joined) == 322


# Rain and flow use only gauge days (09:00-09:00 GMT) that finished by the sample time (2026-10-03 timing fix;
# before it: rain 58/62, flow 65/66, combined 108/125, 17 false, 37 unexplained).
@pytest.mark.parametrize("rule,hit,warned,pod,far", [
    ("freshford", 43, 44, 0.30, 0.02),
    ("any_upstream", 98, 113, 0.68, 0.13),
    ("rain", 56, 65, 0.39, 0.14),
    ("flow", 63, 65, 0.43, 0.03),
    ("combined", 111, 133, 0.77, 0.17),
])
def test_spec_table(table: dict, rule: str, hit: int, warned: int, pod: float, far: float) -> None:
    r = table[rule]
    assert r["exceedances"] == 145
    assert (r["warned_exceed"], r["warned"]) == (hit, warned)
    assert round(r["pod"], 2) == pod and round(r["far"], 2) == far


def test_freshford_split(table: dict) -> None:
    r = table["freshford"]
    assert (r["not_warned_exceed"], r["not_warned"]) == (102, 278)
    assert (r["warned_median"], r["not_warned_median"]) == (6400, 700)
    assert table["combined"]["false_warnings"] == 22


def test_unexplained(table: dict) -> None:
    assert table["combined"]["not_warned_exceed"] == 34


def test_near_field(table: dict) -> None:
    assert (table["near_field"]["warned_exceed"], table["near_field"]["warned"]) == (88, 101)


def test_farleigh(f: Fetcher) -> None:
    from pipeline import sources
    r = transfer.spill_backtest(transfer.classified(sources.farleigh_samples(f)),
                                [(s.start, s.end) for s in sources.farleigh_spills(f)])
    # the "< 1000" result of 2023-08-17 has no label against 900 and is dropped (it counted as an exceedance before:
    # 34 of 99 not warned)
    assert (r["warned_exceed"], r["warned"], r["not_warned_exceed"], r["not_warned"]) == (60, 75, 33, 98)
    assert r["ambiguous_dropped"] == 1


def test_alewife(f: Fetcher) -> None:
    try:
        r = transfer.alewife(f)
    except MissingInput:
        pytest.skip("Alewife inputs are not redistributed; run `python -m pipeline build` to download them")
    assert (r["warned_exceed"], r["warned"], r["not_warned_exceed"], r["not_warned"]) == (67, 84, 70, 330)


@pytest.mark.skipif(
    any(not (config.RAW / name).is_file() for name in ('oah_cities.json', 'oah_sites.json', 'oah_citizen_sites.json', 'oah_health_risks.json', 'oah_urban_parameters.json')),
    reason="OneAquaHealth raw responses are not redistributed; run `python -m pipeline build` online to acquire the local raw cache",
)
def test_dry_weather(f: Fetcher) -> None:
    d = oah.dry_weather(f, oah.core(f))
    assert (d["dry"], d["samples"]) == (80, 96)
    assert {k: (v["dry"], v["samples"]) for k, v in d["per_city"].items()} == {
        "GH": (17, 17), "OS": (20, 20), "TO": (21, 21), "CO": (16, 18), "BE": (6, 20)}


def test_toulouse(f: Fetcher) -> None:
    t = oah.toulouse(f)
    assert t["samples"] == 118
    assert (t["wet_2d_5mm"]["exceed"], t["wet_2d_5mm"]["n"]) == (6, 30)
    assert (t["otherwise"]["exceed"], t["otherwise"]["n"]) == (4, 88)
    assert (t["dry_3d_1mm"]["exceed"], t["dry_3d_1mm"]["n"]) == (0, 36)


def _engine(m: dict, inputs: dict) -> float:
    """Independent re-implementation of the exported formula (what the browser engine does)."""
    tf = {"identity": lambda x: x, "log1p": lambda x: math.log1p(max(x, 0.0)),
          "log": lambda x: math.log(max(x, 1e-3)), "sin": lambda x: math.sin(2 * math.pi * x / 365.25),
          "cos": lambda x: math.cos(2 * math.pi * x / 365.25)}
    z = m["intercept"]
    for ft in m["features"]:
        x = inputs[ft["input"]]
        x = ft["fill_if_missing"] if x is None else x
        z += ft["coef"] * (tf[ft["transform"]](x) - ft["mean"]) / ft["std"]
    return 1 / (1 + math.exp(-z))


@pytest.mark.parametrize("name", ["model_warleigh.json", "model_portable.json"])
def test_model_export(name: str) -> None:
    p = config.OUT / name
    if not p.exists():
        pytest.skip("run `python -m pipeline build` first")
    m = json.loads(p.read_text(encoding="utf-8"))
    assert len(m["test_vectors"]) == 5
    for v in m["test_vectors"]:
        assert abs(_engine(m, v["inputs"]) - v["expected_probability"]) < 1e-9
    assert m["train_n"] == 272 and m["test_2025"]["n"] == 50 and m["test_2025"]["exceedances"] == 14


def test_model_2025_recomputes(b: bath.Bath) -> None:
    """The held-out result in numbers.json is what a fresh fit on 2021-2024 gives."""
    p = config.OUT / "numbers.json"
    if not p.exists():
        pytest.skip("run `python -m pipeline build` first")
    nums = json.loads(p.read_text(encoding="utf-8"))
    site, _ = bath.site(b)
    r = bath.fit_and_test(b, site, "warleigh")
    assert all(x.local[:4] == "2025" for x in r["test_samples"])
    assert nums["model.warleigh.test2025.auc"]["value"] == round(r["test"]["auc"], 4)
    assert nums["model.warleigh.test2025.warned_exceed"]["value"] == r["test"]["warned_exceed"]


def test_replay_2024() -> None:
    p = config.OUT / "replay_2024-09-23.json"
    if not p.exists():
        pytest.skip("run `python -m pipeline build` first")
    r = json.loads(p.read_text(encoding="utf-8"))
    fres = next(o for o in r["overflows"] if o["name"] == "FRESHFORD STORM TANK")
    assert {"site_id": "13130S", "start_utc": "2024-09-23T09:28:00Z", "stop_utc": "2024-09-24T15:39:00Z",
            "hours": 30.18} in fres["events"]
    assert any(s["time_local"] == "2024-09-24T09:10:00" and s["ecoli_per_100ml"] == 31000 for s in r["samples"])
