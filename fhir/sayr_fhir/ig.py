"""Fetch and build the OneAquaHealth IG, build AfterRain's IG on top of it, and package both."""
from __future__ import annotations

import json
import shutil
import subprocess
import tarfile
from collections import Counter
from pathlib import Path

from . import config as C


def run(cmd: list[str], cwd: Path | None = None, env: dict | None = None) -> str:
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise SystemExit(f"command failed ({p.returncode}): {' '.join(cmd)}\n{p.stdout[-4000:]}\n{p.stderr[-4000:]}")
    return p.stdout


def fetch_ig() -> str:
    """Clone hl7-eu/oah at the pinned commit into ig-src/ (kept out of the repository: no licence stated)."""
    if not (C.IG_SRC / ".git").exists():
        C.IG_SRC.mkdir(parents=True, exist_ok=True)
        run(["git", "init", "-q"], cwd=C.IG_SRC)
        run(["git", "remote", "add", "origin", C.IG_REPO], cwd=C.IG_SRC)
    # A freshly initialised repository (a clean clone, a CI runner) has no commit yet: rev-parse then exits non-zero.
    p = subprocess.run(["git", "rev-parse", "--verify", "-q", "HEAD"], cwd=C.IG_SRC, capture_output=True, text=True)
    head = p.stdout.strip() if p.returncode == 0 else ""
    if head != C.IG_COMMIT:
        run(["git", "fetch", "-q", "--depth", "1", "origin", C.IG_COMMIT], cwd=C.IG_SRC)
        run(["git", "checkout", "-q", "--force", C.IG_COMMIT], cwd=C.IG_SRC)
    head = run(["git", "rev-parse", "HEAD"], cwd=C.IG_SRC).strip()
    if head != C.IG_COMMIT:
        raise SystemExit(f"ig-src is at {head}, expected {C.IG_COMMIT}")
    return head


def sushi(project: Path, out: Path) -> str:
    if out.exists():
        shutil.rmtree(out)
    log = run(C.sushi_cmd() + ["build", str(project), "-o", str(out), "--snapshot"], env=C.env_with_fhir_home())
    tail = log[log.find("SUSHI RESULTS"):] if "SUSHI RESULTS" in log else log[-1500:]
    if " 0 Errors" not in tail:
        raise SystemExit(f"SUSHI reported errors for {project}:\n{log[-6000:]}")
    return tail


def load_dir(out: Path) -> list[dict]:
    d = out / "fsh-generated" / "resources"
    if not d.exists():
        d = out / "resources"
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(d.glob("*.json"))]


def ig_examples(ig: dict) -> set[str]:
    """References ("Type/id") that the ImplementationGuide marks as examples."""
    out = set()
    for r in ig["definition"]["resource"]:
        if r.get("exampleBoolean") or r.get("exampleCanonical"):
            out.add(r["reference"]["reference"])
    return out


def write_package(meta: dict, deps: dict, resources: list[dict], examples: set[str], dest: Path) -> Path:
    """Write an NPM-style FHIR package (package/ + package/example/) as a folder and a .tgz."""
    root = dest / f"{meta['name']}#{meta['version']}"
    if root.exists():
        shutil.rmtree(root)
    pkg = root / "package"
    (pkg / "example").mkdir(parents=True)
    manifest = {"name": meta["name"], "version": meta["version"], "fhirVersions": ["4.0.1"], "type": "fhir.ig",
                "canonical": meta["canonical"], "url": meta["canonical"], "dependencies": deps}
    (pkg / "package.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    index = []
    for r in resources:
        ref = f"{r['resourceType']}/{r['id']}"
        folder = pkg / "example" if ref in examples else pkg
        name = f"{r['resourceType']}-{r['id']}.json"
        (folder / name).write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
        if folder == pkg:
            entry = {"filename": name, "resourceType": r["resourceType"], "id": r["id"]}
            for k in ("url", "version", "kind", "type"):
                if isinstance(r.get(k), str):
                    entry[k] = r[k]
            index.append(entry)
    (pkg / ".index.json").write_text(json.dumps({"index-version": 1, "files": index}, indent=2), encoding="utf-8")
    tgz = dest / f"{meta['name']}-{meta['version']}.tgz"
    with tarfile.open(tgz, "w:gz") as t:
        t.add(pkg, arcname="package")
    return tgz


def install(tgz_folder: Path, meta: dict) -> None:
    """Put a package folder into the build's private FHIR cache, where SUSHI and the validator look."""
    target = C.package_cache() / f"{meta['name']}#{meta['version']}"
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(tgz_folder / f"{meta['name']}#{meta['version']}", target)


def build_oah() -> dict:
    commit = fetch_ig()
    out = C.BUILD / "oah-generated"
    log = sushi(C.IG_SRC, out)
    res = load_dir(out)
    ig = next(r for r in res if r["resourceType"] == "ImplementationGuide")
    examples = ig_examples(ig)
    tgz = write_package(C.OAH_PACKAGE, C.OAH_DEPENDENCIES, res, examples, C.BUILD / "packages")
    install(C.BUILD / "packages", C.OAH_PACKAGE)
    by_type = Counter(r["resourceType"] for r in res)
    ex_type = Counter(ref.split("/")[0] for ref in examples)
    return {"commit": commit, "sushi": log.strip(), "resources": len(res), "by_type": dict(sorted(by_type.items())),
            "examples": len(examples), "examples_by_type": dict(sorted(ex_type.items())), "package": str(tgz)}


def build_sayr() -> tuple[list[dict], str, Path]:
    out = C.BUILD / "sayr-generated"
    log = sushi(C.SAYR_IG, out)
    res = load_dir(out)
    deps = {"hl7.fhir.r4.core": "4.0.1", C.OAH_PACKAGE["name"]: C.OAH_PACKAGE["version"], "hl7.fhir.uv.xver-r5.r4": "0.1.0",
            "hl7.fhir.uv.extensions.r4": "5.3.0"}
    conformance = {"StructureDefinition", "CodeSystem", "ValueSet"}
    examples = {f"{r['resourceType']}/{r['id']}" for r in res if r["resourceType"] not in conformance}
    tgz = write_package(C.SAYR_PACKAGE, deps, res, examples, C.BUILD / "packages")
    return res, log.strip(), tgz
