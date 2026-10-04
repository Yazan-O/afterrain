"""Upstream stream length at each site, stream reaches, and the quest tie-break that uses them.

AMENDMENT to the quest rule in pipeline/offsets.py (2026-09-25, after the first nowcast; the pre-registered text
there is left as written). The primary criterion is unchanged: a site's quest score is its expected drop in 72 h
mean fog after one E. coli count. Only ties change, and only three things:

1. Tie-break. Sites whose scores are equal (within 1e-9; in practice sites in the same 0.25 degree forecast cell,
   which get identical rain and start from the same prior) are ordered by the length of stream network upstream
   of the site, longest first. Why: a count at a site integrates the water from everything that drains to it, so
   one sample at a site with more upstream network tells us about more stream. Site code is the last resort,
   used only when upstream lengths are also equal to the metre.
2. Spread. A city's quests are 3 distinct sites. When filling each slot, a site on a reach that already holds a
   quest is passed over if an equally scored snapped site on another reach is available (an unsnapped site has
   no known reach, so it is never that alternative). A lower score never outranks a higher one.
3. Reporting. Each nowcast pack lists how many sites share each forecast grid cell.

Upstream length. The network is the city pack's OpenStreetMap waterways (data/out/city_<id>.json: the ways of
kinds river, stream, canal, brook, tidal_channel that touch the sites' box plus 0.02 degrees; ways are kept whole,
so a way crossing the box edge is kept to its end, and nothing beyond those ways is counted). Vertices are way
points; two ways are joined where they share a point (coordinates rounded to 1e-5 degrees, as stored in the pack).
Each segment points from a way point to the next, the direction OSM draws waterways (downstream). A site snaps to
the nearest point on any segment if that point is within SNAP_M metres; otherwise it gets 0 km and snapped=False.
Upstream length = the length of every segment from which water can reach the snapped point along segment
directions (each segment counted once, whichever way it is drawn), plus the part of the snapped segment above
the snapped point.

Reach. A junction is a point where the number of distinct neighbouring points is not 2 (a confluence, a split, a
source, an outlet, or a cut end). A reach is a maximal run of segments between two junctions. Two sites are on the
same reach when their snapped points lie on the same reach. Unsnapped sites are on no reach.
"""
from __future__ import annotations

import math
from typing import Any, Sequence

import networkx as nx
import numpy as np

from .rivers import haversine_m

SNAP_M = 100.0            # a site farther than this from every waterway segment is not on the network
TIE_EPS = 1e-9            # scores closer than this are equal (the tie test already used by nowcast.tied_sites)
N_QUESTS = 3

Pt = tuple[float, float]  # (lon, lat), rounded to 1e-5 degrees


def _pt(c: Sequence[float]) -> Pt:
    return (round(float(c[0]), 5), round(float(c[1]), 5))


class StreamNet:
    """Directed waterway network built from a city pack's `waterways.features`."""

    def __init__(self, features: list[dict[str, Any]]) -> None:
        g = nx.DiGraph()
        for ft in features:
            pts = [_pt(c) for c in ft["coordinates"]]
            for a, b in zip(pts, pts[1:]):
                if a != b:
                    g.add_edge(a, b, length=haversine_m(a[1], a[0], b[1], b[0]))
        self.g = g
        self.edges = sorted(g.edges)
        e = np.array(self.edges, float).reshape(-1, 2, 2) if self.edges else np.zeros((0, 2, 2))
        self._a, self._b = e[:, 0, :], e[:, 1, :]
        self._reach = self._reaches()

    def _reaches(self) -> dict[frozenset[Pt], str]:
        """Reach id per undirected segment: the run's smallest segment, 'lon,lat|lon,lat' (a segment belongs to
        exactly one run, so ids are unique; a point is not, since a junction ends several runs)."""
        h = self.g.to_undirected()
        junction = {n for n in h.nodes if h.degree(n) != 2}
        out: dict[frozenset[Pt], str] = {}
        for u, v in sorted(tuple(sorted(e)) for e in h.edges):
            if frozenset((u, v)) in out:
                continue
            run, stack = {frozenset((u, v))}, [n for n in (u, v) if n not in junction]
            seen = set(stack)
            while stack:
                n = stack.pop()
                for m in h.neighbors(n):
                    run.add(frozenset((n, m)))
                    if m not in junction and m not in seen:
                        seen.add(m)
                        stack.append(m)
            a, b = min(tuple(sorted(e)) for e in run)
            rid = "{:.5f},{:.5f}|{:.5f},{:.5f}".format(*a, *b)
            for e in run:
                out[e] = rid
        return out

    def snap(self, lat: float, lon: float) -> tuple[int, float, float]:
        """Nearest segment (index into self.edges), fraction along it from its upstream end, distance in m."""
        k = 111_195.0
        cx = k * math.cos(math.radians(lat))
        ax, ay = (self._a[:, 0] - lon) * cx, (self._a[:, 1] - lat) * k
        bx, by = (self._b[:, 0] - lon) * cx, (self._b[:, 1] - lat) * k
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = np.clip(np.where(L2 > 0, -(ax * dx + ay * dy) / np.where(L2 > 0, L2, 1), 0.0), 0.0, 1.0)
        d2 = (ax + t * dx) ** 2 + (ay + t * dy) ** 2
        i = int(np.argmin(d2))             # argmin returns the first minimum: segments are sorted, so ties are stable
        return i, float(t[i]), float(math.sqrt(d2[i]))

    def upstream_m(self, i: int, t: float) -> float:
        """Stream length draining to the point a fraction t along segment i (see the module docstring)."""
        u, v = self.edges[i]
        drains = nx.ancestors(self.g, u) | {u}
        segs = {frozenset((x, y)) for x, y in self.g.in_edges(drains)} - {frozenset((u, v))}
        total = sum(self.g.edges[e]["length"] if self.g.has_edge(*e) else self.g.edges[e[::-1]]["length"]
                    for e in (tuple(sorted(s)) for s in segs))
        return total + t * self.g.edges[u, v]["length"]

    def site(self, lat: float, lon: float) -> dict[str, Any]:
        if not self.edges:
            return {"upstream_km": 0.0, "snapped": False, "snap_m": None, "reach": None}
        i, t, d = self.snap(lat, lon)
        if d > SNAP_M:
            return {"upstream_km": 0.0, "snapped": False, "snap_m": round(d, 1), "reach": None}
        return {"upstream_km": round(self.upstream_m(i, t) / 1000, 3), "snapped": True, "snap_m": round(d, 1),
                "reach": self._reach[frozenset(self.edges[i])]}


def rank(cands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Score (higher first); within a tie, snapped sites before unsnapped, then upstream length, then site code.
    Input order does not matter."""
    order = sorted(cands, key=lambda q: (-q["_score"], q["code"]))
    tiers: list[list[dict[str, Any]]] = []
    for q in order:
        if tiers and abs(tiers[-1][0]["_score"] - q["_score"]) < TIE_EPS:
            tiers[-1].append(q)
        else:
            tiers.append([q])
    return [q for tier in tiers
            for q in sorted(tier, key=lambda q: (q["reach"] is None, -round(q["upstream_km"], 3), q["code"]))]


def select(cands: list[dict[str, Any]], k: int = N_QUESTS) -> list[dict[str, Any]]:
    """Top k distinct sites by rank(); within a score tie, a site on a reach already chosen waits for the others.
    Each chosen quest gets `chosen_by`: what separated it from the next candidate it was picked over."""
    left = rank(cands)
    chosen: list[dict[str, Any]] = []
    while left and len(chosen) < k:
        top = left[0]["_score"]
        tier = [q for q in left if abs(q["_score"] - top) < TIE_EPS]
        used = {q["reach"] for q in chosen if q["reach"] is not None}
        # A site on a new reach first, then one on a reach already chosen; an unsnapped site's place on the network
        # is unknown, so it never counts as the alternative on another reach (it has 0 km and ranks last anyway).
        fresh = [q for q in tier if q["reach"] is not None and q["reach"] not in used]
        pick = (fresh or [q for q in tier if q["reach"] is not None] or tier)[0]
        rest = [q for q in tier if q is not pick]
        if not rest:
            pick["chosen_by"] = "fog reduction"
        elif pick is not tier[0]:
            pick["chosen_by"] = "different reach (tied fog reduction)"
        elif round(rest[0]["upstream_km"], 3) != round(pick["upstream_km"], 3):
            pick["chosen_by"] = "upstream length (tied fog reduction)"
        else:
            pick["chosen_by"] = "site code (tied fog reduction and upstream length)"
        chosen.append(pick)
        left = [q for q in left if q is not pick]
    return chosen


def grid_cells(sites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sites per forecast grid cell, largest cell first."""
    cells: dict[tuple[float, float], list[str]] = {}
    for s in sites:
        cells.setdefault((s["grid_lat"], s["grid_lon"]), []).append(s["code"])
    return [{"grid_lat": la, "grid_lon": lo, "sites": len(c), "codes": sorted(c)}
            for (la, lo), c in sorted(cells.items(), key=lambda kv: (-len(kv[1]), kv[0]))]
