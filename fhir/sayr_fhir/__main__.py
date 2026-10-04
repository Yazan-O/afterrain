"""python -m sayr_fhir build | validate-examples | serve [port]

build: fetch and build the OAH IG, generate Sayr's instances from sayr/data/out, build Sayr's IG, validate every
Sayr resource and the transaction Bundle with the HL7 validator, and write fhir-static/. Exits non-zero on any
validation error.
"""
from __future__ import annotations

import json
import shutil
import sys

from . import assemble, generate, ig, narrative, validate
from . import config as C


def oah_package():
    return C.BUILD / "packages" / f"{C.OAH_PACKAGE['name']}-{C.OAH_PACKAGE['version']}.tgz"


def build() -> dict:
    report: dict = {}
    print("1/5 OneAquaHealth IG: fetch at the pinned commit and build with SUSHI")
    report["oah"] = ig.build_oah()
    print(f"    {report['oah']['resources']} resources, {report['oah']['examples']} examples")
    print("2/5 Sayr instances from sayr/data/out")
    report["facts"] = generate.write_all()
    print("3/5 Sayr IG with SUSHI")
    res, log, sayr_tgz = ig.build_sayr()
    report["sayr_sushi"] = next((ln for ln in log.splitlines() if "Errors" in ln), "").strip("| ")
    sayr = [narrative.add(r) for r in res] + [assemble.binary_dataset()]
    final = C.BUILD / "sayr-final"
    if final.exists():
        shutil.rmtree(final)
    final.mkdir(parents=True)
    for r in sayr:
        (final / f"{r['resourceType']}-{r['id']}.json").write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"    {len(sayr)} Sayr resources")
    print("4/5 static FHIR surface")
    oah = ig.load_dir(C.BUILD / "oah-generated")
    static = assemble.write_static(oah, sayr, report["facts"]["build_utc"])
    report["static"] = {k: v for k, v in static.items() if k not in ("capability", "search_counts")}
    report["static"]["search_counts"] = {k: v for k, v in static["search_counts"].items()
                                         if not k.startswith("Location?identifier=")}
    print("5/5 HL7 validator: every Sayr resource, the transaction Bundle and the CapabilityStatement")
    tx = assemble.transaction(sayr) | {"id": "sayr-transaction"}
    report["validation"] = validate.validate_dir("sayr", sayr + [tx, static["capability"]], [oah_package(), sayr_tgz])
    (C.BUILD / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    v = report["validation"]["counts"]
    print(f"validator: {report['validation']['validated']} resources, {v['error']} errors, "
          f"{v['warning']} warnings, {v['information']} information")
    if v["error"] or v["fatal"]:
        for g in report["validation"]["groups"]:
            if g["severity"] in ("error", "fatal"):
                print(f"  {g['count']} x {g['example']['file']} {g['example']['at']}: {g['example']['text']}")
        shutil.rmtree(C.STATIC)
        raise SystemExit("validation failed; fhir-static/ removed")
    print(f"done: {C.STATIC}")
    return report


def validate_examples() -> dict:
    ex = C.package_cache() / f"{C.OAH_PACKAGE['name']}#{C.OAH_PACKAGE['version']}" / "package" / "example"
    out = C.BUILD / "validate" / "oah-examples.outcome.json"
    validate.run_validator(ex, [oah_package()], out, C.BUILD / "validate" / "oah-examples.log")
    s = validate.summarise(out)
    s.pop("file_names")
    (C.BUILD / "validate" / "oah-examples.summary.json").write_text(json.dumps(s, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in s.items() if k != "groups"}, indent=1)[:3000])
    return s


def main(argv: list[str]) -> None:
    cmd = argv[0] if argv else "build"
    if cmd == "build":
        build()
    elif cmd == "validate-examples":
        validate_examples()
    elif cmd == "serve":
        from .serve import serve
        serve(int(argv[1]) if len(argv) > 1 else 8777)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
