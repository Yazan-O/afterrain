"""Standing checks on AfterRain's FHIR layer. Run `npm run fhir` (or `python -m sayr_fhir build`) first.

test_validator_zero_errors re-runs the HL7 validator on the built resources and fails on any error.
The other tests check that the resources carry the real values of sayr/data/out.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest

from sayr_fhir import assemble, config as C, validate


def data(name):
    return json.loads((C.DATA_OUT / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def sayr():
    final = C.BUILD / "sayr-final"
    if not final.exists():
        pytest.fail("no build output: run `npm run fhir` first")
    res = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(final.glob("*.json"))]
    return {f"{r['resourceType']}/{r['id']}": r for r in res}


def test_validator_zero_errors(sayr):
    resources = list(sayr.values())
    igs = [C.BUILD / "packages" / f"{C.OAH_PACKAGE['name']}-{C.OAH_PACKAGE['version']}.tgz",
           C.BUILD / "packages" / f"{C.SAYR_PACKAGE['name']}-{C.SAYR_PACKAGE['version']}.tgz"]
    cap = json.loads((C.STATIC / "metadata.json").read_text(encoding="utf-8"))
    s = validate.validate_dir("test", resources + [assemble.transaction(resources) | {"id": "afterrain-transaction"}, cap], igs)
    assert s["validated"] == len(resources) + 2
    assert s["files"] == s["validated"], "the validator skipped files"
    errors = [g for g in s["groups"] if g["severity"] in ("error", "fatal")]
    assert not errors, json.dumps(errors, indent=1)[:4000]


def test_oah_sites_and_stations(sayr):
    codes = {site["code"] for c in ["BE", "CO", "GH", "OS", "TO"] for site in data(f"city_{c}.json")["sites"]}
    locs = [r for k, r in sayr.items() if k.startswith("Location/oah-site-")]
    assert len(codes) == 106 and {r["identifier"][0]["value"] for r in locs} == codes
    assert all(r["meta"]["profile"] == ["http://hl7.eu/fhir/ig/oah/StructureDefinition/location-oah"] for r in locs)
    pech = sayr["Location/hubeau-station-BF000002"]
    assert pech["identifier"][0] == {"system": "https://id.eaufrance.fr/StationMesureEauxSurface", "value": "BF000002",
                                     "assigner": {"display": "Sandre / Hub'Eau (eaufrance)"}}


def test_the_31000_sample(sayr):
    obs = sayr["Observation/warleigh-ecoli-20240924T0810Z"]
    assert obs["valueQuantity"] == {"value": 31000, "unit": "per 100 mL", "system": "http://unitsofmeasure.org",
                                    "code": "/(100.mL)"}
    assert obs["effectiveDateTime"] == "2024-09-24T09:10:00+01:00"      # 08:10 UTC
    assert [c["code"] for c in obs["code"]["coding"]] == ["coliforms", "87317-4"]
    spec = sayr[obs["specimen"]["reference"]]
    assert spec["collection"]["collectedDateTime"] == obs["effectiveDateTime"]


def test_every_backtest_sample_is_an_observation(sayr):
    rows = data("warleigh_backtest.json")["samples"]
    obs = [r for k, r in sayr.items() if k.startswith("Observation/warleigh-ecoli-")]
    assert len(obs) == len(rows)
    assert sorted(o["valueQuantity"]["value"] for o in obs) == sorted(r["ecoli"] for r in rows)
    lib = sayr["Library/warleigh-backtest"]
    n = next(e for e in lib["extension"] if e["url"].endswith("library-numberOfRecords"))["valueInteger"]
    assert n == len(rows) and len(lib["content"]) == len(rows) + 1


def test_risk_estimates_equal_model_output(sayr):
    probs = {r["time_utc"]: r["model_probability"] for r in data("warleigh_backtest.json")["samples"]}
    risks = [r for k, r in sayr.items() if k.startswith("Observation/warleigh-risk-")]
    assert len(risks) == 3 * len(data("replay_2024-09-23.json")["samples"])
    for r in risks:
        t = dt.datetime.fromisoformat(r["effectiveDateTime"]).astimezone(dt.timezone.utc)
        assert r["valueQuantity"]["value"] == pytest.approx(probs[t.strftime("%Y-%m-%dT%H:%M:%SZ")], abs=1e-12)
        assert r["focus"][0]["reference"].startswith("Group/cohort-")


def test_site_risk_equals_nowcast_peak(sayr):
    """One dog-owner risk per OneAquaHealth site: the highest median chance over the forecast, at its first hour,
    with the fog at that hour, the nowcast's model version and fetch time."""
    n = 0
    for c in ["BE", "CO", "GH", "OS", "TO"]:
        pk = data(f"nowcast_{c}.json")
        for site in pk["sites"]:
            r = sayr[f"Observation/oah-risk-dog-owners-{site['code']}"]
            p50 = site["p50"]
            top = max(x for x in p50 if x is not None)
            i = p50.index(top)
            t = dt.datetime.fromisoformat(r["effectiveDateTime"]).astimezone(dt.timezone.utc)
            assert r["valueQuantity"]["value"] == pytest.approx(top, abs=1e-12)
            assert t.strftime("%Y-%m-%dT%H:%MZ") == pk["hours_utc"][i]
            assert r["component"][0]["code"]["coding"][0]["code"] == "fog"
            assert r["component"][0]["valueQuantity"]["value"] == pytest.approx(site["fog"][i], abs=1e-12)
            assert r["subject"]["reference"] == f"Location/oah-site-{site['code']}"
            assert r["subject"]["reference"] in sayr and r["focus"][0]["reference"] in sayr
            assert pk["model_version"] in r["method"]["text"] and pk["forecast_fetched_utc"] in r["note"][1]["text"]
            n += 1
    assert n == 106
    assert sayr["Device/afterrain-model-city"]["version"][0]["value"] == pk["model_version"]


def test_alert_window_is_the_48h_rule(sayr):
    alert = next(r for k, r in sayr.items() if k.startswith("Communication/alert-"))
    period = alert["extension"][0]["valuePeriod"]
    freshford = next(o for o in data("replay_2024-09-23.json")["overflows"] if o["name"] == "FRESHFORD STORM TANK")
    sent = dt.datetime.fromisoformat(alert["sent"])
    last_stop = max(dt.datetime.fromisoformat(e["stop_utc"].replace("Z", "+00:00")) for e in freshford["events"]
                    if dt.datetime.fromisoformat(e["stop_utc"].replace("Z", "+00:00")) <= sent)
    assert dt.datetime.fromisoformat(period["end"]) == last_stop + dt.timedelta(hours=48)
    assert alert["subject"]["reference"] == "Group/cohort-dog-owners"
    assert all(ref["reference"] in sayr for ref in alert["reasonReference"] + alert["about"])


def test_static_surface():
    index = json.loads((C.STATIC / "_search" / "index.json").read_text(encoding="utf-8"))
    bundle = json.loads((C.STATIC / index["Library?description=Benevento"]).read_text(encoding="utf-8"))
    descriptions = [e["resource"]["description"] for e in bundle["entry"]]
    assert descriptions and all(d.lower().startswith("benevento") for d in descriptions)   # FHIR string search: starts-with
    pair = json.loads((C.STATIC / index["Library?_id=Library-Benevento-All,warleigh-backtest"]).read_text(encoding="utf-8"))
    assert {e["resource"]["id"] for e in pair["entry"]} == {"Library-Benevento-All", "warleigh-backtest"}
    cap = json.loads((C.STATIC / "metadata").read_text(encoding="utf-8"))
    assert cap["resourceType"] == "CapabilityStatement" and cap["kind"] == "instance"
    assert (C.STATIC / "Location" / "warleigh-weir.json").exists()


# ---- the validator run cannot pass on a stale or partial outcome -------------------------------------------------
def _fake_run(tmp_path, monkeypatch, returncode: int, writes: list[str] | None):
    """Patch the validator call: exit with returncode, and write an outcome naming `writes` (None: write nothing)."""
    monkeypatch.setattr(C, "BUILD", tmp_path)
    monkeypatch.setattr(C, "tools", lambda: ("java", "validator_cli.jar"))

    def run(cmd, stdout=None, stderr=None):
        out = __import__("pathlib").Path(cmd[cmd.index("-output") + 1])
        if writes is not None:
            out.write_text(json.dumps({"resourceType": "Bundle", "entry": [{"resource": {
                "resourceType": "OperationOutcome",
                "extension": [{"url": validate.FILE_EXT, "valueString": f"/x/{n}"}],
                "issue": [{"severity": "information", "details": {"text": "All OK"}}]}} for n in writes]}))
        return type("P", (), {"returncode": returncode})()
    monkeypatch.setattr(validate.subprocess, "run", run)


RES = [{"resourceType": "Location", "id": "a"}, {"resourceType": "Location", "id": "b"}]


def _stale(tmp_path):
    (tmp_path / "validate").mkdir(parents=True, exist_ok=True)
    (tmp_path / "validate" / "t.outcome.json").write_text(json.dumps({"resourceType": "Bundle", "entry": []}))


def test_validate_fails_on_nonzero_exit(tmp_path, monkeypatch):
    _fake_run(tmp_path, monkeypatch, 1, ["Location-a.json", "Location-b.json"])
    with pytest.raises(SystemExit, match="exited 1"):
        validate.validate_dir("t", RES, [])


def test_validate_ignores_a_stale_outcome(tmp_path, monkeypatch):
    _stale(tmp_path)
    _fake_run(tmp_path, monkeypatch, 0, None)
    with pytest.raises(SystemExit, match="wrote no output"):
        validate.validate_dir("t", RES, [])


def test_validate_requires_every_input_in_the_outcome(tmp_path, monkeypatch):
    _fake_run(tmp_path, monkeypatch, 0, ["Location-a.json"])
    with pytest.raises(SystemExit, match="does not cover"):
        validate.validate_dir("t", RES, [])


def test_validate_accepts_a_fresh_complete_outcome(tmp_path, monkeypatch):
    _fake_run(tmp_path, monkeypatch, 0, ["Location-a.json", "Location-b.json"])
    s = validate.validate_dir("t", RES, [])
    assert s["files"] == s["validated"] == 2 and "file_names" not in s
