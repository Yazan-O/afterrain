"""Deploy gate for GitHub Pages: never replace a city's forecast with an older one.

  python docs/freshness_gate.py stamp data/out             prints this build's forecast fetch times as JSON
  python docs/freshness_gate.py check <base_url> '<json>'  prints deploy=true or deploy=false

check reads forecast_fetched_utc from the live data/nowcast_<city>.json of all five cities. It deploys when no city
on the live site is newer than this build. A 404 at the site root is a first deployment and deploys. Any other
failure (a network error, another status, a missing city file, unreadable JSON) exits 1, so the run fails and the
live site stays as it is.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

CITIES = ("BE", "CO", "GH", "OS", "TO")
Get = Callable[[str], "tuple[int, bytes]"]


class GateError(RuntimeError):
    """The live forecast could not be read, so freshness is unknown."""


def _time(value: object, where: str) -> dt.datetime:
    if not isinstance(value, str):
        raise GateError(f"{where}: forecast_fetched_utc missing or not a string")
    try:
        t = dt.datetime.fromisoformat(value)
    except ValueError as e:
        raise GateError(f"{where}: forecast_fetched_utc {value!r} is not ISO 8601") from e
    if t.tzinfo is None:
        raise GateError(f"{where}: forecast_fetched_utc {value!r} has no time zone")
    return t


def stamp(out_dir: Path) -> dict[str, str]:
    times = {}
    for c in CITIES:
        p = out_dir / f"nowcast_{c}.json"
        v = json.loads(p.read_text(encoding="utf-8")).get("forecast_fetched_utc")
        _time(v, str(p))
        times[c] = v
    return times


def http_get(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}),
                                    timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise GateError(f"{url}: {e}") from e


def live_times(base_url: str, get: Get = http_get) -> dict[str, str] | None:
    """The live site's fetch time per city, or None when the site is not deployed yet (404 at its root)."""
    base = base_url.rstrip("/")
    status, _ = get(base + "/")
    if status == 404:
        return None
    if status != 200:
        raise GateError(f"{base}/: HTTP {status}")
    times = {}
    for c in CITIES:
        url = f"{base}/data/nowcast_{c}.json"
        status, body = get(url)
        if status != 200:
            raise GateError(f"{url}: HTTP {status} while the site is live")
        try:
            v = json.loads(body).get("forecast_fetched_utc")
        except (ValueError, AttributeError) as e:
            raise GateError(f"{url}: not a JSON object") from e
        _time(v, url)
        times[c] = v
    return times


def decide(build: dict[str, str], live: dict[str, str] | None) -> tuple[bool, str]:
    missing = [c for c in CITIES if c not in build]
    if missing:
        raise GateError(f"this build has no forecast time for {', '.join(missing)}")
    if live is None:
        return True, "first deployment: no live site yet"
    newer = [f"{c} (live {live[c]}, build {build[c]})" for c in CITIES
             if _time(live[c], f"live {c}") > _time(build[c], f"build {c}")]
    if newer:
        return False, "the live site serves a newer forecast for " + "; ".join(newer)
    return True, "no live city is newer than this build"


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "stamp":
        print(json.dumps(stamp(Path(argv[1])), separators=(",", ":")))
        return 0
    if len(argv) == 3 and argv[0] == "check":
        try:
            ok, why = decide(json.loads(argv[2]), live_times(argv[1], http_get))
        except GateError as e:
            print(f"::error::Freshness unknown, not deployed: {e}", file=sys.stderr)
            return 1
        print(f"::notice::{'Deploying' if ok else 'Not deployed'}: {why}", file=sys.stderr)
        print(f"deploy={'true' if ok else 'false'}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
