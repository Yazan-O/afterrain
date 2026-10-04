"""Paths, pins and tool discovery for the AfterRain FHIR build."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

FHIR_DIR = Path(__file__).resolve().parent.parent          # sayr/fhir
SAYR_DIR = FHIR_DIR.parent                                  # sayr
DATA_OUT = SAYR_DIR / "data" / "out"

# The OneAquaHealth FHIR IG source. The repository states no licence, so it is fetched at build time
# into ig-src/ (git-ignored) instead of being redistributed with AfterRain.
IG_REPO = "https://github.com/hl7-eu/oah"
IG_COMMIT = "b907cf0869b59d82d9138b3d147fca66f333d911"      # last push 2026-06-11
IG_SRC = FHIR_DIR / "ig-src"
OAH_PACKAGE = {"name": "hl7.eu.fhir.oah", "version": "0.1.0-ci-build", "canonical": "http://hl7.eu/fhir/ig/oah"}
# Dependencies of the OAH IG as SUSHI resolved them (sushi-config.yaml + the automatic extensions pack).
OAH_DEPENDENCIES = {"hl7.fhir.r4.core": "4.0.1", "hl7.fhir.uv.xver-r5.r4": "0.1.0", "hl7.fhir.uv.extensions.r4": "5.3.0"}

SAYR_IG = FHIR_DIR / "sayr-ig"
SAYR_PACKAGE = {"name": "afterrain.fhir.oah", "version": "0.1.0", "canonical": "https://yazan-o.github.io/afterrain/fhir"}
CANONICAL = SAYR_PACKAGE["canonical"]

BUILD = FHIR_DIR / "build"                  # everything regenerated; git-ignored
FHIR_HOME = BUILD / "fhir-home"             # private FHIR package cache for SUSHI and the validator
STATIC = FHIR_DIR / "fhir-static"           # the static read-only FHIR surface; git-ignored
GENERATED_FSH = SAYR_IG / "input" / "fsh" / "generated"

LOCAL_TOOLS = FHIR_DIR / "tools.local.json"  # {"java": "...", "validator": "..."}; git-ignored


def sushi_cmd() -> list[str]:
    exe = FHIR_DIR / "node_modules" / ".bin" / ("sushi.cmd" if os.name == "nt" else "sushi")
    if not exe.exists():
        raise SystemExit(f"SUSHI is not installed: run `npm ci` in {FHIR_DIR}")
    return [str(exe)]


def tools() -> tuple[str, str]:
    """Java 17+ and validator_cli.jar: from env FHIR_JAVA / FHIR_VALIDATOR_JAR, else tools.local.json."""
    cfg = json.loads(LOCAL_TOOLS.read_text(encoding="utf-8")) if LOCAL_TOOLS.exists() else {}
    java = os.environ.get("FHIR_JAVA") or cfg.get("java") or shutil.which("java")
    jar = os.environ.get("FHIR_VALIDATOR_JAR") or cfg.get("validator")
    if not java or not jar or not Path(jar).exists():
        raise SystemExit(
            "The HL7 validator is not configured. Set FHIR_JAVA (Java 17 or later) and FHIR_VALIDATOR_JAR "
            f"(validator_cli.jar from https://github.com/hapifhir/org.hl7.fhir.core/releases), or write {LOCAL_TOOLS}.")
    return java, jar


def env_with_fhir_home() -> dict[str, str]:
    """SUSHI finds packages under <home>/.fhir/packages; point it at the build's private cache."""
    FHIR_HOME.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["USERPROFILE"] = str(FHIR_HOME)
    env["HOME"] = str(FHIR_HOME)
    return env


def package_cache() -> Path:
    return FHIR_HOME / ".fhir" / "packages"
