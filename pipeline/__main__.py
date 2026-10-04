"""python -m pipeline build [--offline | --allow-cache] | nowcast [--offline | --allow-cache]"""
from __future__ import annotations

import argparse
import json
import sys
import warnings

from .fetch import MissingInput


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="fetch inputs, recompute every number, write data/out/")
    b.add_argument("--offline", action="store_true", help="use only the cached inputs in data/raw")
    b.add_argument("--allow-cache", action="store_true",
                   help="local builds only: when a download fails, use its cached copy (logged in fetch_log)")
    n = sub.add_parser("nowcast", help="refetch the ensemble forecast, write data/out/nowcast_<city>.json")
    n.add_argument("--offline", action="store_true", help="use the cached forecast in data/raw")
    n.add_argument("--allow-cache", action="store_true",
                   help="local builds only: when the forecast download fails, use its cached copy (never in a deploy)")
    args = ap.parse_args(argv)
    warnings.filterwarnings("ignore", message="Unknown solver options")
    from .build import run, run_nowcast
    try:
        run_cmd = run if args.cmd == "build" else run_nowcast
        info = run_cmd(offline=args.offline, allow_cache=args.allow_cache)
    except MissingInput as e:
        print(f"input missing: {e}", file=sys.stderr)
        return 2
    print(json.dumps(info, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
