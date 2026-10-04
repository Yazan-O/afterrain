"""The local FHIR server reads only resources inside its static folder (no directory traversal)."""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from sayr_fhir import config as C, serve


@pytest.fixture()
def base(tmp_path, monkeypatch):
    static = tmp_path / "static"
    (static / "Location").mkdir(parents=True)
    (static / "Location" / "warleigh-weir.json").write_text('{"resourceType": "Location", "id": "warleigh-weir"}')
    (static / "metadata.json").write_text('{"resourceType": "CapabilityStatement"}')
    (tmp_path / "secret.json").write_text('{"java": "outside"}')        # one level above the static folder
    (static / "Location" / "x").mkdir()
    monkeypatch.setattr(C, "STATIC", static)
    serve.Handler.index = {}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_reads_a_resource(base):
    assert get(base + "/Location/warleigh-weir") == (200, {"resourceType": "Location", "id": "warleigh-weir"})
    assert get(base + "/Location/warleigh-weir.json")[0] == 200


@pytest.mark.parametrize("path", ["/%2E%2E/secret", "/..%2Fsecret/x", "/Location/..", "/Location/%2E%2E",
                                  "/Location/..%2F..%2Fsecret", "/location/warleigh-weir", "/Location/a%20b",
                                  "/Location/x", "/Location/" + "a" * 65])
def test_rejects_paths_outside_the_resource_syntax(base, path):
    status, body = get(base + path)
    assert status in (400, 404) and body["resourceType"] == "OperationOutcome"
    assert "outside" not in json.dumps(body)
