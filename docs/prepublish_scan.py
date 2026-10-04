"""Pre-publish scan: fails (exit 1) if a file that would be published is restricted or holds a credential.

  python docs/prepublish_scan.py                  # the repository: files git would commit
  python docs/prepublish_scan.py --site web/dist  # a built site: every file in the folder
  add --list to print every scanned file

Repository mode uses `git ls-files --cached --others --exclude-standard` inside a git repository, and
otherwise walks the tree applying the .gitignore files (plain patterns only; a negation pattern stops the scan).
A file holding a FHIR resource passes only as one of AfterRain's own served resources: under fhir/served/ (repository) or
data/fhir/ (site), listed in that folder's index.json, with one of AfterRain's ids.
The forbidden literals are assembled from pieces so this file does not match itself.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Paths that must never be published: sources without a stated licence (licence table: "not redistributed")
# and the OneAquaHealth FHIR guide's source, package and examples (no stated licence).
RESTRICTED_PATHS = [
    (r"(^|/)data/raw/restricted/", "restricted source data (MWRA, MassDEP)"),
    (r"(^|/)(mwra|massdep)_[^/]*$", "restricted source file (MWRA, MassDEP)"),
    (r"(^|/)data/raw/oah_[^/]*\.json$", "raw OneAquaHealth API response (no licence stated; derived data only)"),
    (r"(^|/)fhir/(ig-src|fhir-static|build)/", "OneAquaHealth guide source, package or examples"),
    (r"hl7\.eu\.fhir\.oah[^/]*\.tgz$", "OneAquaHealth guide package"),
    (r"(^|/)(\.env[^/]*|tools\.local\.json)$", "local configuration"),
]

_W = "pass" + "word"
CREDENTIALS = [
    (re.escape("api-enora" + "innovation.com"), "ENORA Earth Observation API host"),
    (_W, "the word " + _W[:4] + "-" + _W[4:]),
    ("grant" + "_type", "OAuth grant parameter"),
    ("client" + "_secret", "OAuth client secret"),
    (r"-----BEGIN [A-Z ]*PRIVATE" + r" KEY-----", "private key"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key"),
    (r"\bgh[pousr]_[A-Za-z0-9]{36,}", "GitHub token"),
    (r"\bgithub_pat_[A-Za-z0-9_]{22,}", "GitHub token"),
    (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", "Slack token"),
    (r"\bsk-(ant-)?[A-Za-z0-9_-]{24,}", "API secret key"),
    (r"\bAIza[0-9A-Za-z_-]{35}", "Google API key"),
    (r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "JSON web token"),
    (r"\bBearer\s+[A-Za-z0-9._~+/-]{20,}", "bearer token"),
    (r"\b(api[_-]?key|secret|access[_-]?token|passwd)[\"']?\s*[:=]\s*[\"'][^\"'\s]{12,}[\"']", "key assignment"),
]
CRED_RE = [(re.compile(p.encode(), re.IGNORECASE), why) for p, why in CREDENTIALS]
PATH_RE = [(re.compile(p), why) for p, why in RESTRICTED_PATHS]
FHIR_RE = re.compile(rb'"resourceType"\s*:')
# FHIR resources may be published only as AfterRain's own served set (fhir/served in the repository, data/fhir in the site):
# listed in that folder's index.json and named with AfterRain's own ids. The guide's examples never match these ids.
FHIR_HOME = {"git": "fhir/served", "gitignore walk": "fhir/served", "site": "data/fhir"}
# The served set is the selection plus its dependency closure (web/scripts/sync-fhir.mjs --export): cohorts, model
# devices, organisations, the dataset Library with its Binary, and the alert's supporting observation. Each id is
# listed explicitly (replicate samples at one time carry -1, -2); a resource must also be in the served index.json,
# and the guide's example ids never match.
SAYR_ID = re.compile(r"^(Location/(warleigh-weir|oah-site-[A-Za-z0-9]+|oah-city-(BE|CO|GH|OS|TO))"
                     r"|Observation/(warleigh-ecoli-\d{8}T\d{4}Z(-\d)?|warleigh-risk-dog-owners-\d{8}T\d{4}Z"
                     r"|oah-risk-dog-owners-[A-Za-z0-9]+)"
                     r"|Specimen/warleigh-water-\d{8}T\d{4}Z(-\d)?|Communication/alert-warleigh-[A-Za-z0-9-]+"
                     r"|Device/afterrain-model-(city|warleigh-without-\d{4})|Group/cohort-dog-owners"
                     r"|Library/warleigh-backtest|Binary/warleigh-backtest-data"
                     r"|Organization/(afterrain-team|wessex-water)|PractitionerRole/wessex-water-sampler)$")


def fhir_problem(rel: str, home: str, listed: set[str]) -> str | None:
    """Why a file holding a FHIR resource may not be published, or None when it is one of AfterRain's served resources."""
    if not rel.startswith(home + "/") or not rel.endswith(".json"):
        return f"FHIR resource outside {home}/ (only AfterRain's own served resources are published)"
    ref = rel[len(home) + 1:-len(".json")]
    if not SAYR_ID.match(ref):
        return "FHIR resource whose id is not one of AfterRain's own (the guide's examples are not published)"
    if ref not in listed:
        return f"FHIR resource not listed in {home}/index.json"
    return None


def git_files(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                         cwd=root, capture_output=True, check=True).stdout
    return sorted(p for p in out.decode().split("\0") if p and (root / p).is_file())


def walk_files(root: Path) -> list[str]:
    rules: dict[Path, list[tuple[str, bool, bool]]] = {}

    def load(d: Path) -> None:
        gi = d / ".gitignore"
        pats = []
        if gi.is_file():
            for line in gi.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                if s.startswith("!"):
                    sys.exit(f"prepublish_scan: negation pattern in {gi} is not supported here; run inside git")
                dir_only = s.endswith("/")
                s = s.rstrip("/")
                anchored = "/" in s
                pats.append((s.lstrip("/"), dir_only, anchored))
        rules[d] = pats

    def ignored(p: Path, is_dir: bool) -> bool:
        for d in [p.parent, *p.parent.parents]:
            if d not in rules:
                continue
            rel = p.relative_to(d).as_posix()
            for pat, dir_only, anchored in rules[d]:
                if dir_only and not is_dir:
                    continue
                if fnmatch.fnmatch(rel if anchored else p.name, pat):
                    return True
            if d == root:
                break
        return False

    files: list[str] = []

    def visit(d: Path) -> None:
        load(d)
        for c in sorted(d.iterdir()):
            if c.name == ".git" or ignored(c, c.is_dir()):
                continue
            if c.is_dir():
                visit(c)
            elif c.is_file():
                files.append(c.relative_to(root).as_posix())

    visit(root)
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", help="scan every file in this built site folder instead of the repository")
    ap.add_argument("--list", action="store_true", help="print every scanned file")
    a = ap.parse_args()
    if a.site:
        root = Path(a.site).resolve()
        if not root.is_dir():
            sys.exit(f"prepublish_scan: {root} is not a folder")
        files = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
        mode = "site"
    else:
        root = ROOT
        files = git_files(root) if (root / ".git").exists() else walk_files(root)
        mode = "git" if (root / ".git").exists() else "gitignore walk"
    home = FHIR_HOME[mode]
    index = root / home / "index.json"
    listed = set(json.loads(index.read_text(encoding="utf-8"))["resources"]) if index.is_file() else set()
    problems = []
    for rel in files:
        for rx, why in PATH_RE:
            if rx.search(rel):
                problems.append(f"{rel}: {why}")
        data = (root / rel).read_bytes()
        for rx, why in CRED_RE:
            if rx.search(data):
                problems.append(f"{rel}: {why}")
        if (a.site or rel.endswith(".json")) and FHIR_RE.search(data):
            why = fhir_problem(rel, home, listed)
            if why:
                problems.append(f"{rel}: {why}")
        if a.list:
            print(rel)
    size = sum((root / r).stat().st_size for r in files)
    print(f"prepublish_scan: {len(files)} files, {size / 1e6:.1f} MB scanned in {root} ({mode})")
    for p in problems:
        print("FAIL " + p)
    print("prepublish_scan: " + ("FAILED" if problems else "clean"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
