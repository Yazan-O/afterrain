"""Assemble the transaction Bundles and the static read-only FHIR surface (fhir-static/)."""
from __future__ import annotations

import base64
import json
import re
import shutil
import unicodedata
from pathlib import Path

from . import config as C
from . import narrative

BASE = C.CANONICAL
CORE_SP = "http://hl7.org/fhir/SearchParameter/"
OAH_IG = "http://hl7.eu/fhir/ig/oah/ImplementationGuide/hl7.eu.fhir.oah"


def binary_dataset() -> dict:
    path = C.DATA_OUT / "warleigh_backtest.json"
    if not path.exists():
        raise SystemExit(f"missing input {path}")
    return {"resourceType": "Binary", "id": "warleigh-backtest-data", "contentType": "application/json",
            "data": base64.b64encode(path.read_bytes()).decode("ascii")}


def transaction(resources: list[dict]) -> dict:
    return {"resourceType": "Bundle", "type": "transaction",
            "entry": [{"fullUrl": f"{BASE}/{r['resourceType']}/{r['id']}", "resource": r,
                       "request": {"method": "PUT", "url": f"{r['resourceType']}/{r['id']}"}} for r in resources]}


# ---- search semantics (FHIR R4) ----------------------------------------------------------------------------

def norm(text: str) -> str:
    """String search normalisation: case- and accent-insensitive."""
    return "".join(ch for ch in unicodedata.normalize("NFD", text) if unicodedata.category(ch) != "Mn").lower()


def match_token_identifier(r: dict, value: str) -> bool:
    system, _, code = value.rpartition("|") if "|" in value else (None, "", value)
    for ident in r.get("identifier", []):
        if ident.get("value") == code and (system is None or ident.get("system") == system):
            return True
    return False


def match_reference(ref: dict | None, value: str) -> bool:
    return bool(ref) and ref.get("reference") == value


def match_string_starts(text: str | None, value: str) -> bool:
    return text is not None and norm(text).startswith(norm(value))


def match_codeable(cc_list, value: str) -> bool:
    system, _, code = value.rpartition("|") if "|" in value else (None, "", value)
    for cc in cc_list if isinstance(cc_list, list) else [cc_list]:
        for c in (cc or {}).get("coding", []):
            if c.get("code") == code and (system is None or c.get("system") == system):
                return True
    return False


SEARCH = {  # (type, param) -> (search type, SearchParameter canonical, matcher)
    ("Location", "identifier"): ("token", CORE_SP + "Location-identifier", lambda r, v: match_token_identifier(r, v)),
    ("Observation", "subject"): ("reference", CORE_SP + "Observation-subject", lambda r, v: match_reference(r.get("subject"), v)),
    ("Observation", "focus"): ("reference", CORE_SP + "Observation-focus",
                               lambda r, v: any(match_reference(f, v) for f in r.get("focus", []))),
    ("Library", "description"): ("string", CORE_SP + "Library-description", lambda r, v: match_string_starts(r.get("description"), v)),
    ("Library", "_id"): ("token", CORE_SP + "Resource-id", lambda r, v: r["id"] in v.split(",")),
    ("Communication", "category"): ("token", CORE_SP + "Communication-category", lambda r, v: match_codeable(r.get("category", []), v)),
    ("Communication", "subject"): ("reference", CORE_SP + "Communication-subject", lambda r, v: match_reference(r.get("subject"), v)),
}


def run_search(corpus: list[dict], rtype: str, param: str, value: str) -> list[dict]:
    _, _, fn = SEARCH[(rtype, param)]
    return [r for r in corpus if r["resourceType"] == rtype and fn(r, value)]


def queries(corpus: list[dict], sayr_ids: set[str]) -> list[tuple[str, str, str]]:
    q = []
    for loc in (r for r in corpus if r["resourceType"] == "Location"):
        for ident in loc.get("identifier", []):
            q.append(("Location", "identifier", ident["value"]))
            if ident.get("system"):
                q.append(("Location", "identifier", f"{ident['system']}|{ident['value']}"))
    subjects = sorted({o["subject"]["reference"] for o in corpus if o["resourceType"] == "Observation" and "subject" in o})
    q += [("Observation", "subject", s) for s in subjects]
    q += [("Observation", "focus", i) for i in sorted(sayr_ids) if i.startswith("Group/")]
    q += [("Library", "description", "Benevento"), ("Library", "_id", "Library-Benevento-All,warleigh-backtest"),
          ("Communication", "category", "alert"), ("Communication", "subject", "Group/cohort-dog-owners")]
    seen, out = set(), []
    for item in q:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def searchset(query: str, hits: list[dict]) -> dict:
    return {"resourceType": "Bundle", "type": "searchset", "total": len(hits),
            "link": [{"relation": "self", "url": f"{BASE}/{query}"}],
            "entry": [{"fullUrl": f"{BASE}/{r['resourceType']}/{r['id']}", "resource": r, "search": {"mode": "match"}}
                      for r in hits]}


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9=._-]", "_", text)


# ---- CapabilityStatement ------------------------------------------------------------------------------------

def capability(corpus: list[dict], search_index: dict[str, str], build_utc: str) -> dict:
    types = sorted({r["resourceType"] for r in corpus})
    profiles: dict[str, set[str]] = {}
    for r in corpus:
        for p in r.get("meta", {}).get("profile", []):
            profiles.setdefault(r["resourceType"], set()).add(p)
    resources = []
    for t in types:
        entry = {"type": t}
        if t in profiles:
            entry["supportedProfile"] = sorted(profiles[t])
        entry["interaction"] = [{"code": "read"}]
        params = [(p, v) for (rt, p), v in SEARCH.items() if rt == t]
        if params:
            entry["interaction"].append({"code": "search-type"})
            entry["searchParam"] = []
            for p, (kind, definition, _) in params:
                values = [k.split("=", 1)[1] for k in search_index if k.startswith(f"{t}?{p}=")]
                entry["searchParam"].append({
                    "name": p, "definition": definition, "type": kind,
                    "documentation": f"Precomputed for {len(values)} value(s), listed in _search/index.json; any other value returns 404."})
        resources.append(entry)
    return narrative.add({
        "resourceType": "CapabilityStatement", "id": "sayr-static", "url": f"{BASE}/CapabilityStatement/sayr-static",
        "version": C.SAYR_PACKAGE["version"], "name": "SayrStaticFhirSurface", "title": "Sayr static FHIR surface",
        "status": "active", "experimental": False, "date": build_utc[:10], "publisher": "Sayr team",
        "description": ("Read-only FHIR R4 surface published as static files. It supports read of every resource listed "
                        "and search only for the precomputed queries in _search/index.json. It does not support create, "
                        "update, delete, history, paging, _include, _revinclude, _sort, _count or _format."),
        "kind": "instance", "software": {"name": "sayr_fhir static generator", "version": C.SAYR_PACKAGE["version"]},
        "implementation": {"description": "Static files generated by `python -m sayr_fhir build`", "url": BASE},
        "fhirVersion": "4.0.1", "format": ["json"],
        "implementationGuide": [OAH_IG],
        "rest": [{"mode": "server",
                  "documentation": "Read: GET [base]/[type]/[id] (file [type]/[id].json). Search: GET [base]/[type]?[param]=[value] for the listed values (file named in _search/index.json).",
                  "resource": resources}]})


# ---- write everything ---------------------------------------------------------------------------------------

def write_static(oah: list[dict], sayr: list[dict], build_utc: str) -> dict:
    corpus = oah + sayr
    ids = [f"{r['resourceType']}/{r['id']}" for r in corpus]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise SystemExit(f"resource ids collide between the OAH IG and Sayr: {sorted(dup)[:10]}")
    if C.STATIC.exists():
        shutil.rmtree(C.STATIC)
    for r in corpus:
        d = C.STATIC / r["resourceType"]
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{r['id']}.json").write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
    sayr_ids = {f"{r['resourceType']}/{r['id']}" for r in sayr}
    index, counts = {}, {}
    for rtype, param, value in queries(corpus, sayr_ids):
        key = f"{rtype}?{param}={value}"
        rel = f"_search/{rtype}/{slug(param + '=' + value)}.json"
        if rel in index.values():
            raise SystemExit(f"search file name collision: {rel}")
        hits = run_search(corpus, rtype, param, value)
        path = C.STATIC / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(searchset(key, hits), ensure_ascii=False, indent=1), encoding="utf-8")
        index[key] = rel
        counts[key] = len(hits)
    (C.STATIC / "_search" / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False), encoding="utf-8")
    cap = capability(corpus, index, build_utc)
    for name in ("metadata", "metadata.json"):
        (C.STATIC / name).write_text(json.dumps(cap, indent=1), encoding="utf-8")
    bundles = C.STATIC / "_bundles"
    bundles.mkdir()
    (bundles / "sayr-transaction.json").write_text(json.dumps(transaction(sayr), ensure_ascii=False), encoding="utf-8")
    (bundles / "oah-transaction.json").write_text(json.dumps(transaction(oah), ensure_ascii=False), encoding="utf-8")
    return {"resources": len(corpus), "oah": len(oah), "sayr": len(sayr), "searches": len(index),
            "search_counts": counts, "capability": cap}
