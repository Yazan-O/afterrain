"""Build the app's stream files: python scripts/build_streams.py (run from sayr/web; `npm run streams`).

Inputs (read only):
  sayr/data/out/city_<id>.json          OpenStreetMap waterways (ODbL) and the OneAquaHealth sites
  sayr/data/out/nowcast_<id>.json       the hours the nowcast covers and each site's forecast cell
  sayr/data/raw/openmeteo_nowcast_<id>.json  the 51 ensemble members' hourly rain the nowcast was computed from

Output: public/data/streams/<id>.json, one per city, with
  streams  the named streams chained from source to confluence, true along-stream km per vertex, and the
           OneAquaHealth sites on each (stations, snapped within STATION_SNAP_M of the line)
  ways     every waterway of the city pack with, per vertex, the network-nearest site and the network distance
           to it (km); vertices on a chained stream also carry (stream index, km) so the map uses the stream rule
  cells    per forecast cell, x = ln(1 + r48) for every member at every nowcast hour, so the browser can
           recompute a site's hours after a citizen sample (src/engine/fog.ts); the prior reproduces the
           nowcast's p50 and fog exactly (tests/unit/stream.test.ts checks it)

  E        ground elevation in metres at every stream, way and site vertex, sampled from the Mapzen terrain tiles
           (terrarium PNG, AWS Open Data) at DEM_ZOOM, the zoom the map's terrain draws the city at, bilinear as
           MapLibre samples its DEM. The browser draws the streams at once from these and never has to wait for
           the terrain tiles or query them point by point. Tiles are cached in sayr/data/raw/terrarium/.

Stream chaining:
for each name carried by a way within STATION_SNAP_M of a site, trace downstream from every source way of that
name along OSM direction (OSM draws waterways downstream), preferring the same name, then unnamed ways (culverts,
unnamed channels), then shorter named streams; it stops at a river, at a named canal, at a named stream at least as
long as its own (the receiving water), or at a dead end. The trace with the
most stations, then the longest, is the stream; streams are kept in that order while each adds a site no kept
stream has (a tributary whose chain runs through a kept stream adds none). Kind "river" ways are the receiving
rivers: drawn, never chained or coloured.
"""
from __future__ import annotations

import heapq
import io
import json
import math
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
OUT = WEB.parents[0] / "data" / "out"
RAW = WEB.parents[0] / "data" / "raw"
DST = WEB / "public" / "data" / "streams"
CITIES = ["CO", "BE", "GH", "OS", "TO"]
STATION_SNAP_M = 150.0
MAX_STREAMS = 8
CROP_KM = 16.0
CROP_PAD_KM = 3.0
MIN_MEMBERS = 26
WINDOW_H = 48
DEM_ZOOM = 12
DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
DEM_CACHE = WEB.parents[0] / "data" / "raw" / "terrarium"


class Dem:
    """Terrarium elevation tiles at one zoom: elevation = R * 256 + G + B / 256 - 32768 metres."""

    def __init__(self, z: int):
        self.z = z
        self.n = 256 * 2 ** z
        self.tiles: dict[tuple[int, int], list[float]] = {}

    def tile(self, x: int, y: int) -> list[float]:
        t = self.tiles.get((x, y))
        if t is not None:
            return t
        path = DEM_CACHE / str(self.z) / str(x) / f"{y}.png"
        if not path.exists():
            url = DEM_URL.format(z=self.z, x=x, y=y)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "sayr-build-streams"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    body = r.read()
            except OSError as e:
                raise SystemExit(f"terrain tile {url} could not be fetched ({e}); the stream packs need it for their elevations")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        img = Image.open(io.BytesIO(path.read_bytes())).convert("RGB")
        if img.size != (256, 256):
            raise SystemExit(f"terrain tile {path}: {img.size}, expected 256 x 256")
        b = img.tobytes()
        t = [b[i] * 256 + b[i + 1] + b[i + 2] / 256 - 32768 for i in range(0, len(b), 3)]
        self.tiles[(x, y)] = t
        return t

    def px(self, gx: int, gy: int) -> float:
        gx %= self.n
        gy = min(max(gy, 0), self.n - 1)
        return self.tile(gx // 256, gy // 256)[(gy % 256) * 256 + gx % 256]

    def at(self, lon: float, lat: float) -> float:
        s = math.sin(math.radians(lat))
        fx = (lon + 180) / 360 * self.n
        fy = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * self.n
        ix, iy = math.floor(fx), math.floor(fy)
        tx, ty = fx - ix, fy - iy
        return (self.px(ix, iy) * (1 - tx) * (1 - ty) + self.px(ix + 1, iy) * tx * (1 - ty)
                + self.px(ix, iy + 1) * (1 - tx) * ty + self.px(ix + 1, iy + 1) * tx * ty)


def key(c):
    return (round(c[0], 5), round(c[1], 5))


class Proj:
    def __init__(self, lat0: float):
        self.kx = 111320 * math.cos(math.radians(lat0))
        self.ky = 110540

    def xy(self, c):
        return (c[0] * self.kx, c[1] * self.ky)

    def d(self, a, b):
        return math.hypot((a[0] - b[0]) * self.kx, (a[1] - b[1]) * self.ky)


def seg_project(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t


def line_project(p, line_xy, cum):
    best = (1e18, 0.0)
    for i in range(len(line_xy) - 1):
        d, t = seg_project(p, line_xy[i], line_xy[i + 1])
        if d < best[0]:
            best = (d, cum[i] + t * math.dist(line_xy[i], line_xy[i + 1]))
    return best


def rolling_r48(v):
    out = [None] * len(v)
    for i in range(WINDOW_H - 1, len(v)):
        w = v[i - WINDOW_H + 1:i + 1]
        out[i] = None if any(x is None for x in w) else float(sum(w))
    return out


def build_city(cid: str) -> dict:
    city = json.loads((OUT / f"city_{cid}.json").read_text(encoding="utf-8"))
    now = json.loads((OUT / f"nowcast_{cid}.json").read_text(encoding="utf-8"))
    raw = json.loads((RAW / f"openmeteo_nowcast_{cid}.json").read_text(encoding="utf-8"))
    raw = raw if isinstance(raw, list) else [raw]
    sites = city["sites"]
    if len(raw) != len(sites):
        raise SystemExit(f"{cid}: {len(raw)} forecast locations for {len(sites)} sites")
    P = Proj(city["city"]["latitude"])
    F = city["waterways"]["features"]

    # ---------- 1. chains ----------
    start_of, nodes_of = defaultdict(list), defaultdict(set)
    for i, f in enumerate(F):
        c = f["coordinates"]
        start_of[key(c[0])].append(i)
        for q in c:
            nodes_of[key(q)].add(i)
    ends = {key(f["coordinates"][-1]) for f in F}
    site_ll = [(s["lon"], s["lat"]) for s in sites]

    def near_names(lls, rivers=False):
        names = set()
        for ll in lls:
            p = P.xy(ll)
            for f in F:
                if not f["name"] or (f["waterway"] == "river" and not rivers):
                    continue
                c = [P.xy(q) for q in f["coordinates"]]
                if any(seg_project(p, c[k], c[k + 1])[0] <= STATION_SNAP_M for k in range(len(c) - 1)):
                    names.add(f["name"])
        return sorted(names)

    namelen = defaultdict(float)
    for f in F:
        c = f["coordinates"]
        namelen[f["name"]] += sum(P.d(a, b) for a, b in zip(c, c[1:]))

    def joins(f, name):
        """Whether a trace of `name` flows on into way f, or f is the receiving water where it ends."""
        if f["name"] == name:
            return True
        if f["waterway"] == "river":
            return False
        if f["name"] is None:
            return True
        return f["waterway"] in ("stream", "brook") and namelen[f["name"]] < namelen[name]

    def trace(first):
        name = F[first]["name"]
        path, seen, coords = [first], {first}, list(F[first]["coordinates"])
        while True:
            end = key(coords[-1])
            nxt = [j for j in start_of[end] if j not in seen and joins(F[j], name)]
            if not nxt:
                return path, coords
            nxt.sort(key=lambda j: (F[j]["name"] != name, F[j]["name"] is not None, -len(F[j]["coordinates"])))
            j = nxt[0]
            path.append(j)
            seen.add(j)
            coords += F[j]["coordinates"][1:]

    def build(name):
        ids = [i for i, f in enumerate(F) if f["name"] == name]
        srcs = [i for i in ids if key(F[i]["coordinates"][0]) not in ends] or ids
        best = pick(srcs)
        if best is None:
            # a named stretch that begins where other water flows in (Oslo's Alna below its unnamed and canal
            # reaches) has no source of its own: start also where the name begins
            own_ends = {key(F[i]["coordinates"][-1]) for i in ids}
            best = pick([i for i in ids if key(F[i]["coordinates"][0]) not in own_ends and i not in srcs])
        if best is None:
            return None
        _, path, clean, cum, st = best
        st.sort(key=lambda s: s["km"])
        if cum[-1] > CROP_KM * 1000:  # a long river or canal: the stretch around its sites, CROP_PAD_KM each side
            lo = max(0.0, st[0]["km"] * 1000 - CROP_PAD_KM * 1000)
            hi = min(cum[-1], st[-1]["km"] * 1000 + CROP_PAD_KM * 1000)
            keep = [i for i, m in enumerate(cum) if lo <= m <= hi]
            origin_m = cum[keep[0]]
            clean = [clean[i] for i in keep]
            cum = [cum[i] - origin_m for i in keep]
            st = [{**x, "km": round(x["km"] - origin_m / 1000, 3)} for x in st]
        return {"name": name, "osm_ids": [F[i]["osm_way"] for i in path],
                "line": [[round(x, 6), round(y, 6)] for x, y in clean],
                "km": [round(m / 1000, 4) for m in cum], "length_km": round(cum[-1] / 1000, 3), "stations": st}

    def pick(srcs):
        """The trace from these source ways with the most stations, then the longest."""
        best = None
        for s in srcs:
            path, coords = trace(s)
            clean = [coords[0]]
            for c in coords[1:]:
                if P.d(c, clean[-1]) > 0.5:
                    clean.append(c)
            if len(clean) < 2:
                continue
            lxy = [P.xy(c) for c in clean]
            cum = [0.0]
            for i in range(len(lxy) - 1):
                cum.append(cum[-1] + math.dist(lxy[i], lxy[i + 1]))
            st = []
            for k, s_ in enumerate(sites):
                d, along = line_project(P.xy(site_ll[k]), lxy, cum)
                if d <= STATION_SNAP_M:
                    st.append({"code": s_["code"], "name": s_["name"], "off_m": round(d), "km": round(along / 1000, 3)})
            score = (len(st), cum[-1])
            if st and (best is None or score > best[0]):
                best = (score, path, clean, cum, st)
        return best

    cand = [c for c in (build(n) for n in near_names(site_ll)) if c and c["length_km"] >= 0.8]
    cand.sort(key=lambda c: (-len(c["stations"]), -c["length_km"]))
    chains, covered = [], set()
    for c in cand:  # a chain that adds no new site runs through one already kept (a tributary): dropped
        codes = {s["code"] for s in c["stations"]}
        if codes - covered and len(chains) < MAX_STREAMS:
            chains.append(c)
            covered |= codes
    # every other site with a named waterway (a river included) within reach gets its own strip
    for k, s_ in enumerate(sites):
        if s_["code"] in covered:
            continue
        opts = [c for c in (build(n) for n in near_names([site_ll[k]], rivers=True)) if c and c["length_km"] >= 0.5 and s_["code"] in {x["code"] for x in c["stations"]}]
        if not opts:
            continue
        c = max(opts, key=lambda c: (len({x["code"] for x in c["stations"]} - covered), -c["length_km"]))
        chains.append(c)
        covered |= {x["code"] for x in c["stations"]}

    # ---------- 2. network: nearest site by network distance, per vertex ----------
    und = defaultdict(list)
    allnodes = set()
    for f in F:
        c = f["coordinates"]
        for a, b in zip(c, c[1:]):
            ka, kb = key(a), key(b)
            if ka == kb:
                continue
            L = P.d(a, b)
            und[ka].append((kb, L))
            und[kb].append((ka, L))
            allnodes.update((ka, kb))
    nodes = list(allnodes)
    S, SITE = {}, {}
    heap = []
    for k, ll in enumerate(site_ll):
        best = min(nodes, key=lambda n: P.d(n, ll))
        heapq.heappush(heap, (P.d(best, ll), k, best))
    while heap:
        d, k, n = heapq.heappop(heap)
        if n in S:
            continue
        S[n], SITE[n] = d, k
        for m, L in und[n]:
            if m not in S:
                heapq.heappush(heap, (d + L, k, m))

    chain_way = {}
    for ci, ch in enumerate(chains):
        for oid in ch["osm_ids"]:
            chain_way.setdefault(oid, ci)
    ways = []
    for f in F:
        c = f["coordinates"]
        kind = "river" if f["waterway"] == "river" else "stream" if f["waterway"] in ("stream", "brook") else "minor"
        w = {"id": f["osm_way"], "kind": kind, "name": f["name"] or "",
             "c": [[round(x, 5), round(y, 5)] for x, y in c],
             "site": [SITE.get(key(p), -1) for p in c],
             "S": [round(S.get(key(p), 9e6) / 1000, 3) for p in c]}
        ci = chain_way.get(f["osm_way"])
        if ci is not None and kind != "river":
            ch = chains[ci]
            lxy = [P.xy(q) for q in ch["line"]]
            cum = [m * 1000 for m in ch["km"]]
            w["chain"] = ci
            w["km"] = [round(line_project(P.xy(p), lxy, cum)[1] / 1000, 3) for p in c]
        ways.append(w)

    # ---------- 3. ensemble x per forecast cell ----------
    hours = now["hours_utc"]
    cells, cell_of = [], {}
    for s, d in zip(sites, raw):
        h = d["hourly"]
        times = [t + "Z" for t in h["time"]]
        fmt = [t[:16] + "Z" for t in times]
        idx = [fmt.index(t) for t in hours]
        sig = json.dumps(h, sort_keys=True)
        if sig not in cell_of:
            keys = sorted(k for k in h if k.startswith("precipitation"))
            r48 = [rolling_r48([None if v is None else v for v in h[k]]) for k in keys]
            per_hour = []
            for i in idx:
                col = [r[i] for r in r48 if r[i] is not None]
                if len(col) < MIN_MEMBERS:
                    raise SystemExit(f"{cid}: hour {fmt[i]} has {len(col)} complete members")
                per_hour.append([round(v, 2) for v in col])
            cell_of[sig] = len(cells)
            cells.append({"grid": [d["latitude"], d["longitude"]], "sites": [], "r48_mm": per_hour})
        cells[cell_of[sig]]["sites"].append(s["code"])

    # ---------- 4. ground elevation per vertex (metres, 0.1 m) ----------
    dem = Dem(DEM_ZOOM)
    elev = lambda cs: [round(dem.at(c[0], c[1]), 1) for c in cs]
    for ch in chains:
        ch["E"] = elev(ch["line"])
    for w in ways:
        w["E"] = elev(w["c"])

    return {
        "city": cid,
        "name": city["city"]["name"],
        "center": [city["city"]["longitude"], city["city"]["latitude"]],
        "about": "Built by sayr/web/scripts/build_streams.py from city_<id>.json (OpenStreetMap waterways, ODbL; "
                 "OneAquaHealth sites), nowcast_<id>.json and the Open-Meteo ensemble rain it used (CC BY 4.0); "
                 "elevations from the Mapzen terrain tiles on AWS Open Data.",
        "station_snap_m": STATION_SNAP_M,
        "dem_zoom": DEM_ZOOM,
        "hours_utc": hours,
        "sites": [{"code": s["code"], "name": s["name"], "lat": s["lat"], "lon": s["lon"], "E": round(dem.at(s["lon"], s["lat"]), 1)} for s in sites],
        "streams": chains,
        "ways": ways,
        "cells": cells,
    }


def main(argv: list[str]) -> None:
    DST.mkdir(parents=True, exist_ok=True)
    for cid in argv or CITIES:
        pack = build_city(cid)
        (DST / f"{cid}.json").write_text(json.dumps(pack, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{cid}: {len(pack['streams'])} streams "
              + ", ".join(f"{c['name']} {c['length_km']} km {[s['code'] for s in c['stations']]}" for c in pack["streams"])
              + f"; {len(pack['ways'])} ways; {len(pack['cells'])} forecast cells")


if __name__ == "__main__":
    main(sys.argv[1:])
