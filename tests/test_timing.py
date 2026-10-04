"""Every weather input must have finished by the sample time (no look-ahead).

Environment Agency daily values run 09:00 to 09:00 GMT and carry the start date (checked against the 15-minute
Claverton rain and Bradford-on-Avon flow series: the 2023-07-10 daily value equals the 15-minute total of
2023-07-10 09:00 to 2023-07-11 09:00 GMT).
"""
from __future__ import annotations

import datetime as dt
import warnings

import pytest

from pipeline import bath, model, sources
from pipeline.fetch import Fetcher

warnings.filterwarnings("ignore", message="Unknown solver options")
DAY = dt.timedelta(days=1)


@pytest.fixture(scope="module")
def b() -> bath.Bath:
    return bath.load(Fetcher(offline=True))


def test_interval_bounds(b: bath.Bath) -> None:
    for series in (b.rain, b.flow):
        d = series["2023-07-10"]
        assert d.start == dt.datetime(2023, 7, 10, 9, tzinfo=dt.timezone.utc)
        assert d.end == d.start + DAY


def test_morning_sample_uses_intervals_finished_before_it(b: bath.Bath) -> None:
    # 2023-07-11 09:00 BST = 08:00 GMT: the 2023-07-10 interval ends an hour later, so the latest complete one starts
    # 2023-07-09.
    j = next(x for x in b.joined if x.sample.local == "2023-07-11T09:00:00")
    assert j.flow_prev == b.flow["2023-07-09"].value
    assert j.rain_2d == pytest.approx((b.rain["2023-07-09"].value or 0) + (b.rain["2023-07-08"].value or 0))


def test_no_feature_interval_ends_after_its_sample(b: bath.Bath) -> None:
    for j in b.joined:
        t = j.sample.t
        for k in (1, 2):
            key = sources.complete_day(b.rain, t, k)
            assert b.rain.interval(key)[1] <= t
            if k == 1:
                # The next interval is not complete at t.
                assert b.rain.interval(sources.complete_day(b.rain, t, 0))[1] > t


def test_model_features_match_rule_features(b: bath.Bath) -> None:
    site, _ = bath.site(b)
    for j in b.joined[::7]:
        r = model.raw_features(site, j.sample.t, 0.0)
        assert r["flow_prev_day"] == j.flow_prev
        assert r["rain_2d"] == pytest.approx(j.rain_2d)
