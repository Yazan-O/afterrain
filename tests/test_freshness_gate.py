"""The Pages deploy gate compares all five cities and fails on any lookup error except a genuine first deploy."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("freshness_gate", ROOT / "docs" / "freshness_gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

BASE = "https://example.test/afterrain/"
T0, T1 = "2026-10-02T04:05:00Z", "2026-10-03T04:05:00Z"


def build(t=T1, **over):
    return {c: over.get(c, t) for c in gate.CITIES}


def site(times=None, root=200, files=None, raise_on=None):
    times = times or build(T0)
    files = files or {}

    def get(url):
        if raise_on and raise_on in url:
            raise gate.GateError(f"{url}: connection reset")
        if url == BASE.rstrip("/") + "/":
            return root, b"<html>"
        c = url.rsplit("nowcast_", 1)[1][:2]
        if c in files:
            return files[c]
        return 200, json.dumps({"forecast_fetched_utc": times[c]}).encode()
    return get


def test_newer_build_deploys():
    assert gate.decide(build(T1), gate.live_times(BASE, site())) == (True, "no live city is newer than this build")


def test_one_older_city_blocks_the_deploy_even_when_coimbra_is_fresh():
    ok, why = gate.decide(build(T1, TO=T0), gate.live_times(BASE, site(build(T0, TO=T1))))
    assert not ok and "TO" in why and "CO" not in why


def test_equal_times_deploy():
    assert gate.decide(build(T0), gate.live_times(BASE, site(build(T0))))[0]


def test_first_deployment_is_a_404_at_the_root():
    assert gate.live_times(BASE, site(root=404)) is None
    assert gate.decide(build(), None) == (True, "first deployment: no live site yet")


@pytest.mark.parametrize("kw", [
    {"root": 503},
    {"files": {"GH": (404, b"")}},
    {"files": {"OS": (500, b"")}},
    {"files": {"BE": (200, b"<html>not json")}},
    {"files": {"TO": (200, b"{}")}},
    {"files": {"CO": (200, b'{"forecast_fetched_utc": "yesterday"}')}},
    {"raise_on": "nowcast_OS"},
])
def test_lookup_errors_fail_instead_of_deploying(kw):
    with pytest.raises(gate.GateError):
        gate.live_times(BASE, site(**kw))


def test_a_build_missing_a_city_fails():
    with pytest.raises(gate.GateError):
        gate.decide({"CO": T1}, None)


def test_cli_check_exits_1_on_a_lookup_error(monkeypatch, capsys):
    monkeypatch.setattr(gate, "http_get", site(root=500))
    assert gate.main(["check", BASE, json.dumps(build())]) == 1
    assert "deploy=" not in capsys.readouterr().out


def test_stamp_reads_all_five_published_nowcasts():
    times = gate.stamp(ROOT / "data" / "out")
    assert sorted(times) == sorted(gate.CITIES)
