"""Serve fhir-static/ with FHIR REST paths: GET /metadata, /[type]/[id], /[type]?[param]=[value]."""
from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from . import config as C


def outcome(code: str, text: str) -> bytes:
    return json.dumps({"resourceType": "OperationOutcome",
                       "issue": [{"severity": "error", "code": code, "diagnostics": text}]}).encode()


class Handler(BaseHTTPRequestHandler):
    index: dict[str, str] = {}

    def send(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/fhir+json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        url = urlsplit(self.path)
        path = unquote(url.path).strip("/")
        if url.query:
            key = f"{path}?{unquote(url.query)}"
            rel = self.index.get(key)
            if rel is None:
                return self.send(404, outcome("not-supported", f"search not precomputed: {key}; see /metadata"))
            return self.send(200, (C.STATIC / rel).read_bytes())
        if path == "metadata":
            return self.send(200, (C.STATIC / "metadata.json").read_bytes())
        f = resource_file(path)
        if f is None:
            return self.send(400, outcome("invalid", "expected /[type]/[id] with a FHIR resource type and id"))
        if f.is_file():
            return self.send(200, f.read_bytes())
        return self.send(404, outcome("not-found", f"no resource at /{path}"))


TYPE_RE = re.compile(r"[A-Z][A-Za-z]{0,63}")
ID_RE = re.compile(r"[A-Za-z0-9\-.]{1,64}")   # the FHIR id datatype


def resource_file(path: str) -> Path | None:
    """The file for a read of `[type]/[id]` (id may end in .json), or None when the path is not that shape or would
    resolve outside the static folder."""
    parts = path.split("/")
    if len(parts) != 2:
        return None
    rtype, rid = parts[0], parts[1].removesuffix(".json")
    if not TYPE_RE.fullmatch(rtype) or not ID_RE.fullmatch(rid) or set(rid) == {"."}:
        return None
    root = C.STATIC.resolve()
    f = (root / rtype / f"{rid}.json").resolve()
    return f if f.is_relative_to(root / rtype) else None


def serve(port: int = 8777) -> None:
    Handler.index = json.loads((C.STATIC / "_search" / "index.json").read_text(encoding="utf-8"))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"AfterRain static FHIR surface on http://127.0.0.1:{port}/ (Ctrl+C to stop)")
    httpd.serve_forever()
