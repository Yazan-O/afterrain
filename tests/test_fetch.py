"""A failed download never silently becomes a cached copy unless the caller asks for the cache (allow_cache)."""
from __future__ import annotations

import json

import pytest

from pipeline import config, nowcast
from pipeline.fetch import Fetcher, MissingInput

CACHED = [{"latitude": 43.6, "hourly": {"time": ["2026-09-01T00:00"]}}]
OLD = "2026-09-01T04:00:00Z"


@pytest.fixture()
def raw(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.setattr(config, "RAW", tmp_path / "data" / "raw")
    monkeypatch.setattr(config, "RESTRICTED", tmp_path / "data" / "raw" / "restricted")
    config.RAW.mkdir(parents=True)
    (config.RAW / "openmeteo_nowcast_TO.json").write_text(json.dumps(CACHED), encoding="utf-8")
    (config.RAW / "layer.json").write_text(json.dumps([{"OBJECTID": 1}]), encoding="utf-8")
    (config.RAW / "manifest.json").write_text(json.dumps({"openmeteo_nowcast_TO.json": {"fetched_utc": OLD}}),
                                              encoding="utf-8")
    return tmp_path


def _fail(self, url, headers, data, tries=4):
    raise MissingInput(f"download failed for {url}: offline in the test")


def _site():
    return {"latitude": 43.6, "longitude": 1.44}


def test_failed_fetch_raises_by_default(raw, monkeypatch):
    monkeypatch.setattr(Fetcher, "_download", _fail)
    f = Fetcher()
    with pytest.raises(MissingInput, match="--allow-cache"):
        f.fetch("openmeteo_nowcast_TO.json", "https://example.test/x", "test")
    assert f.log == []


def test_failed_forecast_never_returns_the_old_forecast(raw, monkeypatch):
    """The deploy path: a failed refresh of one city stops the nowcast instead of keeping its old fetch time."""
    monkeypatch.setattr(Fetcher, "_download", _fail)
    with pytest.raises(MissingInput):
        nowcast.fetch_city(Fetcher(), "TO", [_site()])


def test_failed_arcgis_query_raises_by_default(raw, monkeypatch):
    monkeypatch.setattr(Fetcher, "_download", _fail)
    with pytest.raises(MissingInput, match="--allow-cache"):
        Fetcher().arcgis("layer.json", "https://example.test/layer", "1=1", "*", "test")


def test_allow_cache_keeps_the_offline_fallback_and_logs_it(raw, monkeypatch):
    monkeypatch.setattr(Fetcher, "_download", _fail)
    f = Fetcher(allow_cache=True)
    data, fetched = nowcast.fetch_city(f, "TO", [_site()])
    assert data == CACHED and fetched == OLD
    assert Fetcher(allow_cache=True).arcgis("layer.json", "https://example.test/layer", "1=1", "*", "t") == [
        {"OBJECTID": 1}]
    assert len(f.log) == 1 and "cached copy used" in f.log[0]


def test_allow_cache_without_a_cached_copy_still_raises(raw, monkeypatch):
    monkeypatch.setattr(Fetcher, "_download", _fail)
    with pytest.raises(MissingInput):
        Fetcher(allow_cache=True).fetch("absent.json", "https://example.test/absent", "test")


def test_successful_fetch_writes_and_stamps(raw, monkeypatch):
    monkeypatch.setattr(Fetcher, "_download", lambda self, url, headers, data, tries=4: b'[{"latitude": 43.6}]')
    f = Fetcher()
    data, fetched = nowcast.fetch_city(f, "TO", [_site()])
    assert data == [{"latitude": 43.6}] and fetched != OLD and fetched.endswith("Z")


def test_cli_exposes_allow_cache(raw, monkeypatch):
    from pipeline import __main__ as cli, build
    seen = {}
    monkeypatch.setattr(build, "run_nowcast", lambda offline=False, allow_cache=False: seen.update(
        offline=offline, allow_cache=allow_cache) or {})
    assert cli.main(["nowcast"]) == 0 and seen == {"offline": False, "allow_cache": False}
    assert cli.main(["nowcast", "--allow-cache"]) == 0 and seen == {"offline": False, "allow_cache": True}
