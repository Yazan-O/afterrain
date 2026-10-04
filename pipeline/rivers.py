"""OpenStreetMap waterways (Overpass API, ODbL) and along-river distances."""
from __future__ import annotations

import math
import urllib.parse
from dataclasses import dataclass
from typing import Any

import networkx as nx
import numpy as np

from . import config
from .fetch import Fetcher

ATTRIBUTION = "Waterways (c) OpenStreetMap contributors, ODbL 1.0, via the Overpass API"


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(a))


def overpass_waterways(f: Fetcher, name: str, bbox: tuple[float, float, float, float],
                       kinds: str) -> dict[str, Any]:
    """bbox = (south, west, north, east); kinds is a regex over the waterway tag."""
    s, w, n, e = bbox
    q = (f'[out:json][timeout:180];way["waterway"~"^({kinds})$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});'
         "out body;>;out skel qt;")
    return f.json(name, config.OVERPASS + "?data=" + urllib.parse.quote(q), config.ODBL)


@dataclass
class Network:
    graph: nx.Graph
    ids: np.ndarray
    lat: np.ndarray
    lon: np.ndarray

    @classmethod
    def from_osm(cls, osm: dict[str, Any]) -> "Network":
        nodes = {el["id"]: (el["lat"], el["lon"]) for el in osm["elements"] if el["type"] == "node"}
        g = nx.Graph()
        for el in osm["elements"]:
            if el["type"] != "way":
                continue
            tags = el.get("tags", {})
            label = tags.get("name") or tags.get("waterway", "")
            refs = [r for r in el["nodes"] if r in nodes]
            for a, b in zip(refs, refs[1:]):
                d = haversine_m(*nodes[a], *nodes[b])
                g.add_edge(a, b, length=d, name=label, kind=tags.get("waterway", ""))
        for k in g.nodes:
            g.nodes[k]["lat"], g.nodes[k]["lon"] = nodes[k]
        ids = np.array(list(g.nodes), dtype=np.int64)
        return cls(g, ids, np.array([nodes[k][0] for k in ids]), np.array([nodes[k][1] for k in ids]))

    def snap(self, lat: float, lon: float, component_of: int | None = None) -> tuple[int, float]:
        """Nearest network node (optionally within the component holding `component_of`) and its distance in m."""
        mask = np.ones(len(self.ids), bool)
        if component_of is not None:
            comp = nx.node_connected_component(self.graph, component_of)
            mask = np.isin(self.ids, np.fromiter(comp, dtype=np.int64))
        dy = (self.lat - lat) * 111_195.0
        dx = (self.lon - lon) * 111_195.0 * math.cos(math.radians(lat))
        d2 = np.where(mask, dx * dx + dy * dy, np.inf)
        i = int(np.argmin(d2))
        return int(self.ids[i]), float(math.sqrt(d2[i]))

    def route(self, src: int, dst: int) -> tuple[float, list[int]]:
        length, path = nx.single_source_dijkstra(self.graph, src, dst, weight="length")
        return float(length), path

    def coords(self, path: list[int]) -> list[list[float]]:
        return [[round(self.graph.nodes[k]["lon"], 6), round(self.graph.nodes[k]["lat"], 6)] for k in path]

    def names(self, path: list[int]) -> list[str]:
        seen: list[str] = []
        for a, b in zip(path, path[1:]):
            n = self.graph.edges[a, b]["name"]
            if n and n not in seen:
                seen.append(n)
        return seen


def merge_paths(net: Network, paths: list[list[int]]) -> list[dict[str, Any]]:
    """Draw each edge once: split every path into runs of edges not drawn before."""
    drawn: set[frozenset[int]] = set()
    out = []
    for path in paths:
        run: list[int] = []
        for a, b in zip(path, path[1:]):
            e = frozenset((a, b))
            if e in drawn:
                if len(run) > 1:
                    out.append(run)
                run = []
                continue
            drawn.add(e)
            run = run + [b] if run else [a, b]
        if len(run) > 1:
            out.append(run)
    return [{"names": net.names(r), "coordinates": net.coords(r)} for r in out]


def waterway_features(osm: dict[str, Any]) -> list[dict[str, Any]]:
    """Plain GeoJSON-like line features for a city map."""
    nodes = {el["id"]: (el["lon"], el["lat"]) for el in osm["elements"] if el["type"] == "node"}
    feats = []
    for el in osm["elements"]:
        if el["type"] != "way":
            continue
        pts = [[round(nodes[r][0], 5), round(nodes[r][1], 5)] for r in el["nodes"] if r in nodes]
        if len(pts) < 2:
            continue
        t = el.get("tags", {})
        feats.append({"osm_way": el["id"], "waterway": t.get("waterway"), "name": t.get("name"),
                      "intermittent": t.get("intermittent") == "yes", "coordinates": pts})
    return feats
