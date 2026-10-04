// A perspective camera over local metres (x east, y north, z up), and a fit that frames a set of points in a
// screen rectangle. The terrain shader and the 2D overlay share its matrix, so lines sit on the relief.

export type Mat4 = Float32Array;

export interface CameraPose {
  /** The point looked at, metres. */
  readonly tx: number;
  readonly ty: number;
  readonly tz: number;
  /** Distance from the eye to the target, metres. */
  readonly dist: number;
  /** Compass direction the camera faces, degrees clockwise from north. */
  readonly bearing: number;
  /** Tilt from straight down, degrees. */
  readonly pitch: number;
  /** Vertical field of view, degrees. */
  readonly fov: number;
}

export interface Camera {
  readonly pose: CameraPose;
  readonly width: number;
  readonly height: number;
  readonly viewProj: Mat4;
  readonly eye: readonly [number, number, number];
}

const rad = (d: number): number => (d * Math.PI) / 180;

function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const [ex, ey, ez] = eye as [number, number, number];
  let zx = ex - target[0]!;
  let zy = ey - target[1]!;
  let zz = ez - target[2]!;
  let l = Math.hypot(zx, zy, zz);
  zx /= l;
  zy /= l;
  zz /= l;
  let xx = up[1]! * zz - up[2]! * zy;
  let xy = up[2]! * zx - up[0]! * zz;
  let xz = up[0]! * zy - up[1]! * zx;
  l = Math.hypot(xx, xy, xz);
  xx /= l;
  xy /= l;
  xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * ex + xy * ey + xz * ez), -(yx * ex + yy * ey + yz * ez), -(zx * ex + zy * ey + zz * ez), 1,
  ]);
}

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}

export function makeCamera(pose: CameraPose, width: number, height: number): Camera {
  const b = rad(pose.bearing);
  const p = rad(pose.pitch);
  const f = [Math.sin(b) * Math.sin(p), Math.cos(b) * Math.sin(p), -Math.cos(p)];
  const eye: [number, number, number] = [pose.tx - f[0]! * pose.dist, pose.ty - f[1]! * pose.dist, pose.tz - f[2]! * pose.dist];
  const up = [Math.sin(b) * Math.cos(p), Math.cos(b) * Math.cos(p), Math.sin(p)];
  const view = lookAt(eye, [pose.tx, pose.ty, pose.tz], up);
  const proj = perspective(rad(pose.fov), width / height, pose.dist * 0.05, pose.dist * 6);
  return { pose, width, height, viewProj: mul(proj, view), eye };
}

/** Projects a world point to CSS pixels; w <= 0 means behind the camera (x and y are then NaN). */
export function project(cam: Camera, x: number, y: number, z: number, out: Float64Array | number[], o = 0): void {
  const m = cam.viewProj;
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (cw <= 1e-6) {
    out[o] = NaN;
    out[o + 1] = NaN;
    return;
  }
  out[o] = ((cx / cw) * 0.5 + 0.5) * cam.width;
  out[o + 1] = (1 - ((cy / cw) * 0.5 + 0.5)) * cam.height;
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Moves the target and distance of `pose` until the points' projected bounding box fills `rect` (in CSS
 * pixels) as tightly as the aspect allows, centred in it.
 */
export function fitPose(base: Omit<CameraPose, 'tx' | 'ty' | 'dist'>, pts: Float64Array, width: number, height: number, rect: Rect): CameraPose {
  let cx = 0;
  let cy = 0;
  let minx = Infinity;
  let maxx = -Infinity;
  let miny = Infinity;
  let maxy = -Infinity;
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i]!;
    const y = pts[3 * i + 1]!;
    cx += x / n;
    cy += y / n;
    minx = Math.min(minx, x);
    maxx = Math.max(maxx, x);
    miny = Math.min(miny, y);
    maxy = Math.max(maxy, y);
  }
  let pose: CameraPose = { ...base, tx: cx, ty: cy, dist: Math.hypot(maxx - minx, maxy - miny) * 1.6 };
  const tmp = [0, 0];
  const rw = rect.right - rect.left;
  const rh = rect.bottom - rect.top;
  const b = rad(base.bearing);
  const right = [Math.cos(b), -Math.sin(b)];
  const fwd = [Math.sin(b), Math.cos(b)];
  for (let it = 0; it < 60; it++) {
    const cam = makeCamera(pose, width, height);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      project(cam, pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!, tmp);
      x0 = Math.min(x0, tmp[0]!);
      x1 = Math.max(x1, tmp[0]!);
      y0 = Math.min(y0, tmp[1]!);
      y1 = Math.max(y1, tmp[1]!);
    }
    const s = Math.max((x1 - x0) / rw, (y1 - y0) / rh);
    const wpp = (2 * pose.dist * Math.tan(rad(pose.fov) / 2)) / height; // metres per pixel at the target
    const dx = (x0 + x1) / 2 - (rect.left + rect.right) / 2;
    const dy = (y0 + y1) / 2 - (rect.top + rect.bottom) / 2;
    const k = 0.7;
    pose = {
      ...pose,
      tx: pose.tx + k * (dx * wpp * right[0]! - (dy * wpp * fwd[0]!) / Math.cos(rad(pose.pitch))),
      ty: pose.ty + k * (dx * wpp * right[1]! - (dy * wpp * fwd[1]!) / Math.cos(rad(pose.pitch))),
      dist: pose.dist * (1 + k * (s - 1)),
    };
  }
  return pose;
}
