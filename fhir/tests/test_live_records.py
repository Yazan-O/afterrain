"""The records the app makes in the browser validate against the guide.

build/live-export/ (git-ignored) holds the records the opening's interaction makes at Eiras: the published forecast,
a low and a high test reading, written by web/tests/e2e/story.spec.ts ("the opening comparison's live records").
They are validated with the HL7 validator against the OneAquaHealth package and the Sayr package (which defines the
test-reading terms). The forecast record claims ObservationHealthMeasureOah; the test records do not (the profile
fixes status to final, and a test estimate is preliminary). The records are not kept in the repository: the
pre-publish scan admits FHIR resources only as Sayr's served set. Without an export the test skips; the unit test
web/tests/unit/liveTerms.test.ts checks the terms, the profile claim and the dateTimes on every run.
Checks for undefined Sayr terms, invalid dateTimes and forecast records outside the profile.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from sayr_fhir import config as C, validate

EXPORT = C.BUILD / "live-export"
PROFILE = "http://hl7.eu/fhir/ig/oah/StructureDefinition/observation-health-measure-oah"


def _igs() -> list[Path]:
    igs = [C.BUILD / "packages" / f"{C.OAH_PACKAGE['name']}-{C.OAH_PACKAGE['version']}.tgz",
           C.BUILD / "packages" / f"{C.SAYR_PACKAGE['name']}-{C.SAYR_PACKAGE['version']}.tgz"]
    if not all(p.exists() for p in igs):
        pytest.fail("no build output: run `npm run fhir` first")
    return igs


def test_live_records_validate() -> None:
    files = sorted(EXPORT.glob("*.json"))
    if not files:
        pytest.skip("no export: run the e2e test \"the opening comparison's live records\"")
    by = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in files}
    assert set(by) == {"forecast", "test-low", "test-high"}
    assert by["forecast"]["meta"]["profile"] == [PROFILE] and by["forecast"]["status"] == "final"
    assert all("profile" not in by[k]["meta"] and by[k]["status"] == "preliminary" for k in ("test-low", "test-high"))

    def flag(r: dict) -> bool:
        return next(c["valueBoolean"] for c in r["component"] if c["code"]["coding"][0]["code"] == "test-reading-over-900")

    assert (flag(by["test-low"]), flag(by["test-high"])) == (False, True)
    s = validate.validate_dir("live-export", list(by.values()), _igs())
    assert s["validated"] == 3 and s["files"] == 3
    errors = [g for g in s["groups"] if g["severity"] in ("error", "fatal")]
    assert not errors, json.dumps(errors, indent=1)[:4000]
