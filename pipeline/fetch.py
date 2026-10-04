"""Download with a cache and a manifest row per file; --offline reads the cache only.

A failed download raises MissingInput. Only allow_cache (the CLI's --allow-cache, for local builds) turns a failed
download into the cached copy, logged in fetch_log; the Pages deploy never passes it, so a failed refresh stops the
deploy instead of shipping an older forecast."""
from __future__ import annotations

import datetime as dt
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config


class MissingInput(RuntimeError):
    """An input is neither cached nor downloadable."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class Fetcher:
    offline: bool = False
    allow_cache: bool = False
    log: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        config.RAW.mkdir(parents=True, exist_ok=True)
        config.RESTRICTED.mkdir(parents=True, exist_ok=True)
        self.manifest_path = config.RAW / "manifest.json"
        self.manifest: dict[str, dict[str, Any]] = (
            json.loads(self.manifest_path.read_text(encoding="utf-8")) if self.manifest_path.exists() else {})

    # ---- low level -------------------------------------------------------------------------
    def _path(self, name: str, restricted: bool) -> Path:
        return (config.RESTRICTED if restricted else config.RAW) / name

    def _record(self, name: str, url: str, licence: str, path: Path, restricted: bool, note: str = "") -> None:
        self.manifest[name] = {"file": str(path.relative_to(config.ROOT)).replace("\\", "/"), "url": url,
                               "fetched_utc": utc_now(), "licence": licence, "bytes": path.stat().st_size,
                               "published": not restricted, **({"note": note} if note else {})}
        self.manifest_path.write_text(json.dumps(self.manifest, indent=1, ensure_ascii=False), encoding="utf-8")

    def _download(self, url: str, headers: dict[str, str] | None, data: bytes | None, tries: int = 4) -> bytes:
        h = {"User-Agent": config.USER_AGENT, **(headers or {})}
        err: Exception | None = None
        for k in range(tries):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=h, data=data), timeout=300) as r:
                    return r.read()
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                err = e
                if isinstance(e, urllib.error.HTTPError) and e.code not in (429, 500, 502, 503, 504):
                    break
                time.sleep(5 * (k + 1))
        raise MissingInput(f"download failed for {url}: {err}")

    def fetch(self, name: str, url: str, licence: str, *, headers: dict[str, str] | None = None,
              data: bytes | None = None, restricted: bool = False) -> Path:
        """Return the cached file `name`, downloading it first unless offline."""
        path = self._path(name, restricted)
        if self.offline:
            if not path.exists():
                raise MissingInput(f"{name}: not in the cache ({path}); run without --offline to fetch {url}")
            return path
        try:
            body = self._download(url, headers, data)
        except MissingInput as e:
            if self.allow_cache and path.exists():
                self.log.append(f"{name}: fetch failed, cached copy used ({e})")
                return path
            raise MissingInput(f"{e} (pass --allow-cache to use the cached copy in a local build)") from e
        path.write_bytes(body)
        self._record(name, url, licence, path, restricted)
        return path

    def json(self, name: str, url: str, licence: str, **kw: Any) -> Any:
        return json.loads(self.fetch(name, url, licence, **kw).read_text(encoding="utf-8"))

    # ---- ArcGIS FeatureServer query with paging ------------------------------------------------
    def arcgis(self, name: str, layer: str, where: str, fields: str, licence: str,
               order: str = "OBJECTID") -> list[dict[str, Any]]:
        path = self._path(name, False)
        url = layer + "/query?" + urllib.parse.urlencode({"where": where, "outFields": fields, "orderByFields": order})
        if self.offline:
            if not path.exists():
                raise MissingInput(f"{name}: not in the cache ({path}); run without --offline to query {url}")
            return json.loads(path.read_text(encoding="utf-8"))
        rows: list[dict[str, Any]] = []
        off = 0
        try:
            while True:
                q = {"where": where, "outFields": fields, "orderByFields": order, "resultOffset": off,
                     "resultRecordCount": 2000, "f": "json"}
                r = json.loads(self._download(layer + "/query?" + urllib.parse.urlencode(q), None, None))
                if "error" in r:
                    raise MissingInput(f"{name}: ArcGIS error {r['error']} for {url}")
                fs = [f["attributes"] for f in r["features"]]
                rows += fs
                off += len(fs)
                if not r.get("exceededTransferLimit") or not fs:
                    break
        except MissingInput as e:
            if self.allow_cache and path.exists():
                self.log.append(f"{name}: query failed, cached copy used ({e})")
                return json.loads(path.read_text(encoding="utf-8"))
            raise MissingInput(f"{e} (pass --allow-cache to use the cached copy in a local build)") from e
        path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        self._record(name, url, licence, path, False)
        return rows

    def fetched_utc(self, name: str) -> str | None:
        row = self.manifest.get(name)
        return row["fetched_utc"] if row else None
