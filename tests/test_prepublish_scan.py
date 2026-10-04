"""The pre-publish scan accepts AfterRain's served FHIR export and rejects everything it guards against."""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "docs" / "prepublish_scan.py"
SERVED = ROOT / "fhir" / "served"
spec = importlib.util.spec_from_file_location("prepublish_scan", SCAN)
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)

GUIDE_EXAMPLES = ["Device/Dev-HI98130", "Group/Group-BN-All", "ConceptMap/SampleOah2FHIR",
                  "CodeSystem/temporarySystem-oah-eu"]


def served_index() -> dict:
    return json.loads((SERVED / "index.json").read_text(encoding="utf-8"))


def test_every_served_resource_passes() -> None:
    listed = set(served_index()["resources"])
    bad = {r: scan.fhir_problem(f"fhir/served/{r}.json", "fhir/served", listed) for r in listed}
    assert {r: why for r, why in bad.items() if why} == {}


@pytest.mark.parametrize("ref", GUIDE_EXAMPLES + ["Observation/warleigh-ecoli-latest", "Library/other-dataset",
                                                   "Binary/other-data", "Patient/warleigh-weir",
                                                   "Specimen/warleigh-water-20220818T0547Z-x"])
def test_rejects_ids_that_are_not_sayr_own(ref: str) -> None:
    assert scan.fhir_problem(f"fhir/served/{ref}.json", "fhir/served", {ref}) is not None


def test_rejects_unlisted_and_misplaced() -> None:
    assert "not listed" in scan.fhir_problem("fhir/served/Location/warleigh-weir.json", "fhir/served", set())
    assert "outside" in scan.fhir_problem("data/out/Location/warleigh-weir.json", "fhir/served",
                                          {"Location/warleigh-weir"})


def _site(tmp: Path) -> Path:
    site = tmp / "site"
    shutil.copytree(SERVED, site / "data" / "fhir")
    (site / "index.html").write_text("<!doctype html><title>AfterRain</title>", encoding="utf-8")
    return site


def _run(site: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCAN), "--site", str(site)], capture_output=True, text=True)


def test_site_scan_exit_codes(tmp_path: Path) -> None:
    site = _site(tmp_path)
    ok = _run(site)
    assert ok.returncode == 0, ok.stdout
    # a guide example inside the served folder
    (site / "data" / "fhir" / "Group").mkdir(exist_ok=True)
    (site / "data" / "fhir" / "Group" / "Group-BN-All.json").write_text('{"resourceType": "Group"}', encoding="utf-8")
    r = _run(site)
    assert r.returncode == 1 and "Group-BN-All" in r.stdout
    (site / "data" / "fhir" / "Group" / "Group-BN-All.json").unlink()
    # restricted content and a credential pattern
    (site / "data" / "raw").mkdir(parents=True)
    (site / "data" / "raw" / "oah_sites.json").write_text("[]", encoding="utf-8")
    (site / "notes.txt").write_text("grant" + "_type=" + "pass" + "word", encoding="utf-8")
    r = _run(site)
    assert r.returncode == 1
    assert "raw OneAquaHealth API response" in r.stdout and "OAuth grant parameter" in r.stdout
