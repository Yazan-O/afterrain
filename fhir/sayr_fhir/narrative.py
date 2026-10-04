"""A short generated narrative (Resource.text) for every AfterRain resource, built from its own content."""
from __future__ import annotations

from html import escape


def _q(v: dict | None) -> str:
    if not v:
        return ""
    return f"{v.get('value')} {v.get('unit', v.get('code', ''))}".strip()


def _cc(cc: dict | None) -> str:
    if not cc:
        return ""
    return cc.get("text") or ", ".join(c.get("display", c.get("code", "")) for c in cc.get("coding", []))


def summary(r: dict) -> list[str]:
    t = r["resourceType"]
    if t == "Location":
        pos = r.get("position", {})
        return [r["name"], r.get("description", ""),
                f"Identifier {r['identifier'][0]['value']} ({r['identifier'][0].get('system', '')})",
                f"Position {pos.get('latitude')}, {pos.get('longitude')}" if pos else ""]
    if t == "Specimen":
        return [f"{_cc(r.get('type'))} sample from {r['subject']['reference']}",
                f"Collected {r['collection']['collectedDateTime']} by {r['collection']['collector']['reference']}"]
    if t == "Observation":
        focus = ", ".join(f["reference"] for f in r.get("focus", []))
        return [f"{_cc(r['code'])}: {_q(r.get('valueQuantity'))}",
                f"At {r['subject']['reference']}, {r.get('effectiveDateTime', '')}" + (f", for {focus}" if focus else ""),
                f"Interpretation: {_cc(r['interpretation'][0])}" if r.get("interpretation") else "",
                *(f"{_cc(c['code'])}: {_q(c.get('valueQuantity'))}" for c in r.get("component", [])),
                r.get("method", {}).get("text", "")]
    if t == "Group":
        parts = []
        for c in r.get("characteristic", []):
            v = c.get("valueCodeableConcept") or c.get("valueRange") or c.get("valueQuantity") or c.get("valueReference")
            if "valueRange" in c:
                lo, hi = c["valueRange"].get("low", {}).get("value"), c["valueRange"].get("high", {}).get("value")
                v = f"{lo if lo is not None else ''} to {hi if hi is not None else ''} years"
            elif isinstance(v, dict):
                v = _cc(v) if "coding" in v else v.get("reference", "")
            parts.append(f"{_cc(c['code'])}: {v}")
        return [r.get("name", r["id"])] + parts
    if t == "Communication":
        period = next((e["valuePeriod"] for e in r.get("extension", []) if "valuePeriod" in e), {})
        return [p.get("contentString", "") for p in r.get("payload", [])] + [
            f"Sent {r.get('sent', '')} to {r['subject']['reference']}; valid until {period.get('end', '')}"]
    if t == "Subscription":
        return [r.get("reason", ""), f"Criteria: {r.get('criteria', '')}", f"Channel: {r['channel']['type']}"]
    if t == "Device":
        return [r["deviceName"][0]["name"], f"Version: {r['version'][0]['value']}" if r.get("version") else ""]
    if t == "Organization":
        return [r.get("name", r["id"])]
    if t == "PractitionerRole":
        return [_cc(r["code"][0]) if r.get("code") else r["id"], f"Organization: {r['organization']['reference']}"]
    if t in ("Library", "CodeSystem", "ValueSet", "StructureDefinition", "CapabilityStatement"):
        return [r.get("title", r.get("name", r["id"])), r.get("description", "")]
    return [f"{t} {r['id']}"]


def add(r: dict) -> dict:
    if r["resourceType"] == "Binary" or "text" in r:
        return r
    lines = [x for x in summary(r) if x]
    body = "".join(f"<p>{escape(x)}</p>" for x in lines)
    r = dict(r)
    r["text"] = {"status": "generated", "div": f'<div xmlns="http://www.w3.org/1999/xhtml">{body}</div>'}
    # keep text right after meta, the conventional position
    order = ["resourceType", "id", "meta", "text"]
    return {k: r[k] for k in order if k in r} | {k: v for k, v in r.items() if k not in order}
