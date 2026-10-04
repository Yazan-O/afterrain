"""Run the HL7 FHIR validator (validator_cli.jar) and summarise its OperationOutcomes."""
from __future__ import annotations

import datetime as dt
import json
import re
import shutil
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from . import config as C

FILE_EXT = "http://hl7.org/fhir/StructureDefinition/operationoutcome-file"


def run_validator(source_dir: Path, igs: list[Path], out_json: Path, log_path: Path) -> None:
    java, jar = C.tools()
    C.FHIR_HOME.mkdir(parents=True, exist_ok=True)
    cmd = [java, f"-Duser.home={C.FHIR_HOME}", "-Dfile.encoding=UTF-8", "-jar", jar, "-version", "4.0.1"]
    for ig in igs:
        cmd += ["-ig", str(ig)]
    cmd += ["-output", str(out_json), str(source_dir)]
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.unlink(missing_ok=True)          # never read an earlier run's outcome as this run's
    with open(log_path, "w", encoding="utf-8") as log:
        p = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    if p.returncode != 0:
        raise SystemExit(f"the validator exited {p.returncode}; see {log_path}")
    if not out_json.exists():
        raise SystemExit(f"the validator wrote no output (exit {p.returncode}); see {log_path}")


def summarise(out_json: Path) -> dict:
    data = json.loads(out_json.read_text(encoding="utf-8"))
    outcomes = [e["resource"] for e in data.get("entry", [])] if data["resourceType"] == "Bundle" else [data]
    per_file, counts, messages = {}, Counter(), defaultdict(list)
    for oo in outcomes:
        name = next((x.get("valueString") for x in oo.get("extension", []) if x["url"] == FILE_EXT), "?")
        name = Path(name).name
        c = Counter()
        for iss in oo.get("issue", []):
            sev = iss["severity"]
            text = iss.get("details", {}).get("text", "")
            if sev == "information" and text == "All OK":
                continue
            c[sev] += 1
            key = re.sub(r"'[^']*'|\"[^\"]*\"|\d+(\.\d+)?", "_", text)[:220]
            loc = (iss.get("expression") or iss.get("location") or [""])[0]
            messages[(sev, key)].append({"file": name, "at": loc, "text": text})
        counts.update(c)
        per_file[name] = dict(c)
    groups = sorted(({"severity": sev, "count": len(v), "example": v[0]} for (sev, _), v in messages.items()),
                    key=lambda g: (["fatal", "error", "warning", "information"].index(g["severity"]), -g["count"]))
    return {"files": len(per_file), "file_names": sorted(per_file), "counts": {k: counts.get(k, 0) for k in ("fatal", "error", "warning", "information")},
            "files_with_errors": sorted(f for f, c in per_file.items() if c.get("error") or c.get("fatal")),
            "groups": groups}


def validate_dir(name: str, resources: list[dict], igs: list[Path]) -> dict:
    src = C.BUILD / "validate" / name
    if src.exists():
        shutil.rmtree(src)
    src.mkdir(parents=True)
    for r in resources:
        (src / f"{r['resourceType']}-{r['id']}.json").write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
    out = C.BUILD / "validate" / f"{name}.outcome.json"
    run_validator(src, igs, out, C.BUILD / "validate" / f"{name}.log")
    summary = summarise(out)
    expected = {f"{r['resourceType']}-{r['id']}.json" for r in resources}
    missing = sorted(expected - set(summary["file_names"]))
    extra = sorted(set(summary["file_names"]) - expected)
    if missing or extra:
        raise SystemExit(f"{out.name} does not cover this run's inputs: missing {missing[:5]} ({len(missing)}), "
                         f"unexpected {extra[:5]} ({len(extra)})")
    del summary["file_names"]
    summary["validated"] = len(resources)
    # When and with which validator: the site serves this summary, so its date shows how fresh the check is.
    summary["validated_utc"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    head = (C.BUILD / "validate" / f"{name}.log").read_text(encoding="utf-8", errors="replace")[:300]
    version = re.search(r"Version (\S+)", head)
    summary["validator"] = f"HL7 FHIR validator {version.group(1)}" if version else "HL7 FHIR validator"
    (C.BUILD / "validate" / f"{name}.summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    return summary
