// The night relief under the river: a WebGL mesh of the baked elevation grid (assets/terrain.bin), shaded by
// a hillshade computed once on the GPU (one draw into a texture), fading into the night at its edges and with
// distance. Drawn only when the camera or the size changes; the moving light is all on the 2D overlay above it.
import { TERRAIN } from './assets/terrainMeta';
import type { Camera } from './camera';
import { metresPerDegLon } from './network';

export interface Dem {
  readonly nx: number;
  readonly ny: number;
  /** Elevations in metres, row 0 = north. */
  readonly h: Float32Array;
  readonly lon0: number;
  readonly lon1: number;
  readonly lat0: number;
  readonly lat1: number;
}

/** Local metres around the centre of the terrain box. */
export const LAT_C = (TERRAIN.lat0 + TERRAIN.lat1) / 2;
export const LON_C = (TERRAIN.lon0 + TERRAIN.lon1) / 2;
export const KX = metresPerDegLon(LAT_C);
export const KY = 110_540;
/** Vertical exaggeration of the relief (the scene uses 1.6). */
export const EXAGGERATION = 1.8;

export const toX = (lon: number): number => (lon - LON_C) * KX;
export const toY = (lat: number): number => (lat - LAT_C) * KY;

export function decodeDem(buf: ArrayBuffer): Dem {
  const { nx, ny } = TERRAIN;
  if (buf.byteLength !== nx * ny * 2) throw new Error(`terrain.bin holds ${buf.byteLength} bytes, expected ${nx * ny * 2}`);
  const dv = new DataView(buf);
  const h = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) h[i] = dv.getInt16(2 * i, true) / 10;
  return { nx, ny, h, lon0: TERRAIN.lon0, lon1: TERRAIN.lon1, lat0: TERRAIN.lat0, lat1: TERRAIN.lat1 };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * decodeDem in slices of rows, pausing between them, so a scene mounted underneath another never holds the main
 * thread for long (the phone freeze of round 2). The same values as decodeDem.
 */
export async function decodeDemSliced(buf: ArrayBuffer, pause: () => Promise<void>): Promise<Dem> {
  const { nx, ny } = TERRAIN;
  if (!LITTLE_ENDIAN) return decodeDem(buf);
  if (buf.byteLength !== nx * ny * 2) throw new Error(`terrain.bin holds ${buf.byteLength} bytes, expected ${nx * ny * 2}`);
  const src = new Int16Array(buf);
  const h = new Float32Array(nx * ny);
  const rows = 280;
  for (let j = 0; j < ny; j += rows) {
    const end = Math.min(ny, j + rows) * nx;
    for (let i = j * nx; i < end; i++) h[i] = src[i]! / 10;
    await pause();
  }
  return { nx, ny, h, lon0: TERRAIN.lon0, lon1: TERRAIN.lon1, lat0: TERRAIN.lat0, lat1: TERRAIN.lat1 };
}

/** Bilinear elevation in metres at a longitude and latitude (clamped to the grid). */
export function elevationAt(dem: Dem, lon: number, lat: number): number {
  const fx = ((lon - dem.lon0) / (dem.lon1 - dem.lon0)) * dem.nx - 0.5;
  const fy = ((dem.lat1 - lat) / (dem.lat1 - dem.lat0)) * dem.ny - 0.5;
  const x = Math.min(Math.max(fx, 0), dem.nx - 1.001);
  const y = Math.min(Math.max(fy, 0), dem.ny - 1.001);
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ax = x - ix;
  const ay = y - iy;
  const i = iy * dem.nx + ix;
  const h = dem.h;
  return (h[i]! * (1 - ax) + h[i + 1]! * ax) * (1 - ay) + (h[i + dem.nx]! * (1 - ax) + h[i + dem.nx + 1]! * ax) * ay;
}

/** The three lights of the soft multi-directional hillshade: azimuth and altitude in degrees, and weight. */
const LIGHTS = [
  { az: 295, alt: 32, w: 0.62 },
  { az: 245, alt: 40, w: 0.2 },
  { az: 345, alt: 40, w: 0.18 },
] as const;
/** Vertical exaggeration of the slopes for the shading only. */
const SHADE_Z = 2.2;

const SHADE_VS = `#version 300 es
void main(){
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Horn's method on the elevation grid, one fragment per grid cell (row 0 = north, so north is -y), exactly as
// the CPU pass it replaces: the relief is shaded in one draw instead of 0.1-0.5 s of script before first paint.
const SHADE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uH;
uniform ivec2 uSize;
uniform vec2 uCell;
uniform float uZ;
uniform vec4 uL[3];
out vec4 frag;
float at(ivec2 p){ return texelFetch(uH, clamp(p, ivec2(0), uSize - 1), 0).r; }
void main(){
  ivec2 q = ivec2(gl_FragCoord.xy);
  float nw = at(q + ivec2(-1, -1)), n = at(q + ivec2(0, -1)), ne = at(q + ivec2(1, -1));
  float w = at(q + ivec2(-1, 0)), e = at(q + ivec2(1, 0));
  float sw = at(q + ivec2(-1, 1)), s = at(q + ivec2(0, 1)), se = at(q + ivec2(1, 1));
  float dzdx = ((ne + 2.0 * e + se) - (nw + 2.0 * w + sw)) / (8.0 * uCell.x);
  float dzdy = ((nw + 2.0 * n + ne) - (sw + 2.0 * s + se)) / (8.0 * uCell.y);
  vec3 nrm = normalize(vec3(-dzdx * uZ, -dzdy * uZ, 1.0));
  float v = 0.0;
  for (int i = 0; i < 3; i++) v += uL[i].w * max(0.0, dot(nrm, uL[i].xyz));
  frag = vec4(clamp(v, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/** The hillshade (0..1 in an R8 texture, one texel per grid cell), computed on the GPU in one draw. */
export function bakeShade(gl: WebGL2RenderingContext, dem: Dem): WebGLTexture {
  const { nx, ny } = dem;
  const sh = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`terrain shade shader: ${gl.getShaderInfoLog(s) ?? ''}`);
    return s;
  };
  const prog = gl.createProgram()!;
  const vs = sh(gl.VERTEX_SHADER, SHADE_VS);
  const fs = sh(gl.FRAGMENT_SHADER, SHADE_FS);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`terrain shade program: ${gl.getProgramInfoLog(prog) ?? ''}`);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const heights = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, heights);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, dem.h);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
    [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v);

  const shade = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, shade);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, nx, ny, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shade, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('terrain shade: the R8 target is not renderable');

  gl.viewport(0, 0, nx, ny);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, heights);
  gl.uniform1i(gl.getUniformLocation(prog, 'uH'), 0);
  gl.uniform2i(gl.getUniformLocation(prog, 'uSize'), nx, ny);
  gl.uniform2f(gl.getUniformLocation(prog, 'uCell'), ((dem.lon1 - dem.lon0) * KX) / nx, ((dem.lat1 - dem.lat0) * KY) / ny);
  gl.uniform1f(gl.getUniformLocation(prog, 'uZ'), SHADE_Z);
  const L = new Float32Array(12);
  LIGHTS.forEach((l, i) => {
    const a = (l.az * Math.PI) / 180;
    const e = (l.alt * Math.PI) / 180;
    L.set([Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e), l.w], 4 * i);
  });
  gl.uniform4fv(gl.getUniformLocation(prog, 'uL'), L);
  gl.bindVertexArray(null);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(heights);
  gl.deleteProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return shade;
}

export interface TerrainPalette {
  readonly low: readonly [number, number, number];
  readonly high: readonly [number, number, number];
  readonly bg: readonly [number, number, number];
  /** Exponent on the hillshade before mixing low to high. */
  readonly gamma: number;
}

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
uniform mat4 uVP;
uniform vec3 uEye;
out vec2 vUv;
out float vDist;
out float vH;
void main(){
  vUv = aUv;
  vDist = distance(aPos, uEye);
  vH = aPos.z;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vDist;
in float vH;
uniform sampler2D uShade;
uniform vec3 uLow, uHigh, uBg;
uniform float uGamma, uFogNear, uFogFar, uHmin, uHmax;
out vec4 frag;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  float s = pow(texture(uShade, vUv).r, uGamma);
  float e = clamp((vH - uHmin) / (uHmax - uHmin), 0.0, 1.0);
  vec3 c = mix(uLow, uHigh, s) * mix(0.78, 1.12, e);
  float fog = smoothstep(uFogNear, uFogFar, vDist);
  vec2 m = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, 0.16, min(m.x, m.y));
  c = mix(uBg, c, edge * (1.0 - fog));
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  frag = vec4(c, 1.0);
}`;

const UNIFORMS = ['uVP', 'uEye', 'uShade', 'uLow', 'uHigh', 'uBg', 'uGamma', 'uFogNear', 'uFogFar', 'uHmin', 'uHmax'] as const;

export class TerrainRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly count: number;
  private readonly u: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly tex: WebGLTexture;
  private readonly hmin: number;
  private readonly hmax: number;

  /**
   * Builds the mesh and uploads it in slices, pausing between them (`pause` yields to the browser), so the
   * mount never holds the main thread for long; the pixels are the same as one synchronous build.
   */
  static async create(canvas: HTMLCanvasElement, dem: Dem, pause: () => Promise<void>): Promise<TerrainRenderer> {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available for the terrain');
    // the shaders compile in the GPU process while the mesh is built here
    const par = gl.getExtension('KHR_parallel_shader_compile');
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    const vs = sh(gl.VERTEX_SHADER, VS);
    const fs = sh(gl.FRAGMENT_SHADER, FS);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    await pause();

    // mesh: every second grid point
    const step = 2;
    const mx = Math.floor((dem.nx - 1) / step) + 1;
    const my = Math.floor((dem.ny - 1) / step) + 1;
    const pos = new Float32Array(mx * my * 5);
    let hmin = Infinity;
    let hmax = -Infinity;
    const band = 64;
    for (let j0 = 0; j0 < my; j0 += band) {
      for (let j = j0; j < Math.min(my, j0 + band); j++)
        for (let i = 0; i < mx; i++) {
          const gx = Math.min(dem.nx - 1, i * step);
          const gy = Math.min(dem.ny - 1, j * step);
          const lon = dem.lon0 + ((gx + 0.5) / dem.nx) * (dem.lon1 - dem.lon0);
          const lat = dem.lat1 - ((gy + 0.5) / dem.ny) * (dem.lat1 - dem.lat0);
          const hz = dem.h[gy * dem.nx + gx]!;
          hmin = Math.min(hmin, hz);
          hmax = Math.max(hmax, hz);
          const k = (j * mx + i) * 5;
          pos[k] = toX(lon);
          pos[k + 1] = toY(lat);
          pos[k + 2] = hz * EXAGGERATION;
          pos[k + 3] = (gx + 0.5) / dem.nx;
          pos[k + 4] = (gy + 0.5) / dem.ny;
        }
      await pause();
    }
    const idx = new Uint32Array((mx - 1) * (my - 1) * 6);
    let q = 0;
    for (let j0 = 0; j0 < my - 1; j0 += band * 2) {
      for (let j = j0; j < Math.min(my - 1, j0 + band * 2); j++)
        for (let i = 0; i < mx - 1; i++) {
          const a = j * mx + i;
          idx[q++] = a;
          idx[q++] = a + mx;
          idx[q++] = a + 1;
          idx[q++] = a + 1;
          idx[q++] = a + mx;
          idx[q++] = a + mx + 1;
        }
      await pause();
    }
    if (par) for (let k = 0; k < 60 && !gl.getProgramParameter(prog, 0x91b1 /* COMPLETION_STATUS_KHR */); k++) await pause();
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(`terrain shader: ${gl.getShaderInfoLog(vs) ?? ''}`);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(`terrain shader: ${gl.getShaderInfoLog(fs) ?? ''}`);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`terrain program: ${gl.getProgramInfoLog(prog) ?? ''}`);
    // the uniforms are looked up now, before the big uploads: each lookup waits on the GPU process
    const u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    await pause();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    await pause();
    gl.bindVertexArray(vao);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    await pause();
    const tex = bakeShade(gl, dem);
    await pause();
    return new TerrainRenderer(gl, prog, u, vao, q, tex, hmin * EXAGGERATION, hmax * EXAGGERATION);
  }

  private constructor(
    gl: WebGL2RenderingContext,
    prog: WebGLProgram,
    u: Record<string, WebGLUniformLocation | null>,
    vao: WebGLVertexArrayObject,
    count: number,
    tex: WebGLTexture,
    hmin: number,
    hmax: number,
  ) {
    this.gl = gl;
    this.prog = prog;
    this.u = u;
    this.vao = vao;
    this.count = count;
    this.tex = tex;
    this.hmin = hmin;
    this.hmax = hmax;
  }

  private get canvas(): HTMLCanvasElement {
    return this.gl.canvas as HTMLCanvasElement;
  }

  render(cam: Camera, dpr: number, pal: TerrainPalette): void {
    const { gl, canvas } = this;
    const w = Math.round(cam.width * dpr);
    const h = Math.round(cam.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(pal.bg[0], pal.bg[1], pal.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u['uVP']!, false, cam.viewProj);
    gl.uniform3f(this.u['uEye']!, cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform3f(this.u['uLow']!, ...pal.low);
    gl.uniform3f(this.u['uHigh']!, ...pal.high);
    gl.uniform3f(this.u['uBg']!, ...pal.bg);
    gl.uniform1f(this.u['uGamma']!, pal.gamma);
    gl.uniform1f(this.u['uFogNear']!, cam.pose.dist * 0.9);
    gl.uniform1f(this.u['uFogFar']!, cam.pose.dist * 2.1);
    gl.uniform1f(this.u['uHmin']!, this.hmin);
    gl.uniform1f(this.u['uHmax']!, this.hmax);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u['uShade']!, 0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
