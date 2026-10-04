"""Laboratory qualifiers ("<", ">") are kept, and a binary label the qualifier leaves undecided against 900 is dropped.

The Farleigh record of
2023-08-17T11:10 reads "< 1000", which could lie on either side of 900.
"""
from __future__ import annotations

import math
import warnings

import numpy as np
import pytest

from pipeline import citymodel, config, oah, sources, transfer
from pipeline.fetch import Fetcher

warnings.filterwarnings("ignore", message="Unknown solver options")


def test_label_rule():
    lab = config.label
    assert lab(1000, "") is True and lab(900, "") is False
    assert lab(1000, "<") is None          # under 1000: either side of 900
    assert lab(900, "<") is False and lab(15, "<") is False
    assert lab(10000, ">") is True and lab(900, ">") is True
    assert lab(500, ">") is None           # over 500: either side of 900


def test_wessex_operator_kept():
    rows = [{"SampleDate": "2023-08-17T11:10:00", "Determinand": "E. coli", "Operator": "<", "Result": "1000"},
            {"SampleDate": "2023-05-09T09:45:00", "Determinand": "E. coli", "Operator": ">", "Result": "10000"},
            {"SampleDate": "2023-08-25T10:15:00", "Determinand": "E. coli", "Operator": " ", "Result": "550"},
            {"SampleDate": "2025-01-02T12:25:00", "Determinand": "E. coli", "Operator": "NA", "Result": "8000"}]
    got = sources._samples(rows)
    assert [s.operator for s in got] == ["<", ">", "", ""]
    assert [s.over_900 for s in got] == [None, True, False, True]


@pytest.fixture(scope="module")
def f() -> Fetcher:
    return Fetcher(offline=True)


def test_farleigh_ambiguous_record(f: Fetcher):
    smp = {s.local: s for s in sources.farleigh_samples(f)}
    s = smp["2023-08-17T11:10:00"]
    assert (s.operator, s.ecoli, s.over_900) == ("<", 1000.0, None)
    assert [k for k, v in smp.items() if v.operator == ">"] == ["2021-05-24T10:20:00", "2023-05-09T09:45:00"]


def test_farleigh_rule_drops_ambiguous(f: Fetcher):
    samples = sources.farleigh_samples(f)
    rule = transfer.spill_backtest(transfer.classified(samples),
                                   [(s.start, s.end) for s in sources.farleigh_spills(f)])
    assert rule["n"] == len(samples) - 1 and rule["ambiguous_dropped"] == 1


def test_warleigh_has_no_e_coli_qualifier(f: Fetcher):
    assert all(s.operator == "" for s in sources.warleigh_samples(f))


def test_toulouse_below_detection(f: Fetcher):
    tl = oah.toulouse(f)
    below = [r for r in tl["rows"] if r["qualifier"] == "<"]
    assert len(below) == 7 and all(r["over_900"] is False for r in below)
    assert all(r["bound_per_100ml"] == 15.0 and r["bound_source"] == "inferred" for r in below)
    assert (tl["samples"], tl["exceed"]) == (118, 10)


@pytest.mark.skipif(
    not (config.RAW / "restricted" / "mwra_mystic_bacteria.xlsx").is_file(),
    reason="MWRA raw inputs are not redistributed; supply the local restricted cache to run this check",
)
def test_alewife_qualifiers(f: Fetcher):
    smp = transfer._mystic_samples(f.fetch("mwra_mystic_bacteria.xlsx", config.MWRA_MYSTIC_XLSX, config.UNCLEAR,
                                           restricted=True))
    q = sorted((op, v) for _, v, op in smp if op)
    assert q == [("<", 10.0), (">", 24200.0)]
    assert all(config.label(v, op) is not None for _, v, op in smp)


def test_censored_count_likelihood():
    """A left-censored count contributes the CDF at its bound, a right-censored one the survival."""
    t = citymodel.Obs("toulouse", None, "x", 0.0, 0.0, "<", 15.0)    # type: ignore[arg-type]
    s, eta = 0.3, -1.0
    u = (math.log10(15.0) - citymodel.LOG10_900) / s - eta
    assert math.isclose(citymodel.count_nll(np.array([eta]), [t], s), math.log1p(math.exp(-u)), rel_tol=1e-12)
    r = citymodel.Obs("bath", None, "x", 10000.0, 0.0, ">", 10000.0)  # type: ignore[arg-type]
    u = (4.0 - citymodel.LOG10_900) / s - eta
    assert math.isclose(citymodel.count_nll(np.array([eta]), [r], s), math.log1p(math.exp(u)), rel_tol=1e-12)
