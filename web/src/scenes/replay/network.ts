// The replay's river as a graph: the replay file's polylines joined at their shared vertices, every vertex
// labelled with its along-river distance to the weir (Dijkstra from the vertex nearest the weir), and one
// path per overflow from its nearest river vertex down to the weir. The lengths use a local equirectangular
// metric; they agree with the pipeline's distance_to_weir_m to within 0.3% (tests/unit/replayNetwork.test.ts).
import type { ReplayFile } from '../../data/schemas';

export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

export interface NetworkNode extends LonLat {
  /** Along-river metres to the weir. */
  readonly toWeirM: number;
}

export interface OverflowPath {
  readonly key: string;
  /** The overflow's own position (the pipe), which can sit off the river line. */
  readonly pipe: LonLat;
  /** Node indices from the river vertex nearest the pipe down to the weir. */
  readonly nodes: readonly number[];
  /** Metres from the first node along the path, one per node. */
  readonly cum: Float64Array;
  readonly lengthM: number;
  /** Straight-line metres from the pipe to the first node. */
  readonly snapM: number;
}

export interface Segment {
  readonly a: number;
  readonly b: number;
}

export interface RiverNetwork {
  readonly nodes: readonly NetworkNode[];
  readonly segments: readonly Segment[];
  readonly weirNode: number;
  readonly maxToWeirM: number;
  readonly paths: ReadonlyMap<string, OverflowPath>;
  /** Each of the file's river lines as node indices, in the file's order. */
  readonly lines: readonly Int32Array[];
}

const M_PER_DEG_LAT = 110_540;
export const metresPerDegLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

export const distM = (a: LonLat, b: LonLat): number => {
  const kx = metresPerDegLon((a.lat + b.lat) / 2);
  return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * M_PER_DEG_LAT);
};

export function buildNetwork(pack: ReplayFile): RiverNetwork {
  const steps = networkSteps(pack);
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value;
}

/** buildNetwork with a pause between its three stages (vertices, distances, paths), for a mount on a phone. */
export async function buildNetworkSliced(pack: ReplayFile, pause: () => Promise<void>): Promise<RiverNetwork> {
  const steps = networkSteps(pack);
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value;
    await pause();
  }
}

function* networkSteps(pack: ReplayFile): Generator<void, RiverNetwork> {
  // vertices shared by two lines are the same point: keyed by their exact coordinates (a map of maps, no strings)
  const index = new Map<number, Map<number, number>>();
  const pts: LonLat[] = [];
  const adj: { to: number; m: number }[][] = [];
  const segments: Segment[] = [];
  const node = (c: readonly number[]): number => {
    const lon = c[0]!;
    const lat = c[1]!;
    let row = index.get(lon);
    if (!row) index.set(lon, (row = new Map()));
    let i = row.get(lat);
    if (i === undefined) {
      i = pts.length;
      row.set(lat, i);
      pts.push({ lon, lat });
      adj.push([]);
    }
    return i;
  };
  const lines: Int32Array[] = [];
  for (const line of pack.river) {
    const c = line.coordinates;
    const ids = new Int32Array(c.length);
    for (let k = 0; k < c.length; k++) ids[k] = node(c[k]!);
    lines.push(ids);
    for (let k = 1; k < c.length; k++) {
      const a = ids[k - 1]!;
      const b = ids[k]!;
      if (a === b) continue;
      const m = distM(pts[a]!, pts[b]!);
      adj[a]!.push({ to: b, m });
      adj[b]!.push({ to: a, m });
      segments.push({ a, b });
    }
  }
  if (pts.length === 0) throw new Error('the replay file has no river geometry');

  // the nearest vertex by a local plane (one cosine for the whole river), then its true distance
  const kx = metresPerDegLon(pts[0]!.lat);
  const px = new Float64Array(pts.length);
  const py = new Float64Array(pts.length);
  pts.forEach((q, i) => {
    px[i] = q.lon * kx;
    py[i] = q.lat * M_PER_DEG_LAT;
  });
  const nearest = (p: LonLat): { i: number; m: number } => {
    const x = p.lon * kx;
    const y = p.lat * M_PER_DEG_LAT;
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < px.length; i++) {
      const dx = px[i]! - x;
      const dy = py[i]! - y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return { i: bi, m: distM(pts[bi]!, p) };
  };

  yield;
  const weir = nearest({ lon: pack.site.lon, lat: pack.site.lat });
  if (weir.m > 200) throw new Error(`no river vertex within 200 m of the weir (nearest ${weir.m.toFixed(0)} m)`);

  // Dijkstra with a binary heap of (distance, vertex): the mount runs on a phone underneath another scene.
  const dist = new Float64Array(pts.length).fill(Infinity);
  const prev = new Int32Array(pts.length).fill(-1);
  const done = new Uint8Array(pts.length);
  dist[weir.i] = 0;
  const heap = new MinHeap();
  heap.push(0, weir.i);
  while (heap.size) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    for (const e of adj[i]!) {
      const d = dist[i]! + e.m;
      if (d < dist[e.to]!) {
        dist[e.to] = d;
        prev[e.to] = i;
        heap.push(d, e.to);
      }
    }
  }

  yield;
  const nodes: NetworkNode[] = pts.map((p, i) => ({ ...p, toWeirM: dist[i]! }));
  const unreachable = nodes.filter((n) => !Number.isFinite(n.toWeirM)).length;
  if (unreachable) throw new Error(`${unreachable} river vertices are not connected to the weir`);

  const paths = new Map<string, OverflowPath>();
  for (const o of pack.overflows) {
    const pipe = { lon: o.lon, lat: o.lat };
    const s = nearest(pipe);
    const ids: number[] = [];
    for (let i = s.i; i !== -1; i = prev[i]!) ids.push(i);
    const cum = new Float64Array(ids.length);
    for (let k = 1; k < ids.length; k++) cum[k] = cum[k - 1]! + distM(pts[ids[k - 1]!]!, pts[ids[k]!]!);
    paths.set(o.overflow, { key: o.overflow, pipe, nodes: ids, cum, lengthM: cum[cum.length - 1]!, snapM: s.m });
  }

  return { nodes, segments, weirNode: weir.i, maxToWeirM: Math.max(...nodes.map((n) => n.toWeirM)), paths, lines };
}

/** A binary min-heap of vertices keyed by their distance to the weir. */
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, val: number): void {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const { k, v } = this;
    const top = v[0]!;
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const c = l + 1 < n && k[l + 1]! < k[l]! ? l + 1 : l;
        if (k[c]! >= lastK) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

/** The position `m` metres along a path (clamped), interpolated between its nodes. */
export function pointAlong(net: RiverNetwork, path: OverflowPath, m: number): LonLat {
  const c = path.cum;
  const x = Math.min(Math.max(m, 0), path.lengthM);
  let lo = 0;
  let hi = c.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const a = net.nodes[path.nodes[lo]!]!;
  const b = net.nodes[path.nodes[hi]!]!;
  const f = c[hi]! > c[lo]! ? (x - c[lo]!) / (c[hi]! - c[lo]!) : 0;
  return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f };
}
