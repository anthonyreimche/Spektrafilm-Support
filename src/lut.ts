// Shared film-LUT conventions. The runtime lookup (this file + the stage glsl in
// index.ts) and the offline bake tool (tools/bake_luts.py) MUST agree on every
// number here — the input shaper and the atlas layout — or baked film stocks
// won't line up with what the shader samples.
//
// A 3D LUT is stored as a 2D "tiled" atlas: the blue axis is sliced along x, so
// the texture is (N*N) wide by N tall. Slice b occupies columns [b*N, b*N+N);
// within a slice, x = red index, y = green index. The input is shaped to [0,1]
// by a log2 allocation over a fixed stop window before the lookup.

export const LUT_SIZE = 33; // cube edge — 33^3 = 35937 nodes
export const SHAPER_MIN_EV = -10.0; // darkest stop the LUT domain covers
export const SHAPER_MAX_EV = 6.0; // brightest stop
export const ATLAS_W = LUT_SIZE * LUT_SIZE; // slices laid along x
export const ATLAS_H = LUT_SIZE;

export interface Stock {
  id: string;
  name: string;
  /** Lazily builds the rgba8 atlas bytes (ATLAS_W * ATLAS_H * 4). */
  atlas: () => Uint8Array;
}

// sRGB encode matching the develop shader's linearToSrgb (used for the neutral
// placeholder atlas only — baked stocks ship their own measured values).
function linToSrgb(x: number): number {
  x = Math.min(1, Math.max(0, x));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Inverse of the GLSL shaper: shaped coord [0,1] → scene-linear value. */
function unshape(s: number): number {
  return Math.pow(2, s * (SHAPER_MAX_EV - SHAPER_MIN_EV) + SHAPER_MIN_EV);
}

/** A neutral placeholder atlas: output = plain sRGB encode of the shaped input,
 *  so with no film stock baked yet the image renders ~normally (the stage is a
 *  near no-op view transform). Replace by running tools/bake_luts.py. */
export function buildIdentityAtlas(): Uint8Array {
  const n = LUT_SIZE;
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const x = b * n + r;
        const y = g;
        const idx = (y * ATLAS_W + x) * 4;
        data[idx] = Math.round(linToSrgb(unshape(r / (n - 1))) * 255);
        data[idx + 1] = Math.round(linToSrgb(unshape(g / (n - 1))) * 255);
        data[idx + 2] = Math.round(linToSrgb(unshape(b / (n - 1))) * 255);
        data[idx + 3] = 255;
      }
    }
  }
  return data;
}

/** Decode a base64 atlas (as emitted by the bake tool) to bytes. */
export function decodeBase64Atlas(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// GLSL helpers for the film stage: the input shaper, a grain hash, and the
// tiled-atlas trilinear sampler. The shader does bilinear (r,g) via the
// texture's LINEAR filter within each slice and lerps the two blue slices.
export const LUT_GLSL_HELPERS = `
const float SF_MIN_EV = ${SHAPER_MIN_EV.toFixed(1)};
const float SF_MAX_EV = ${SHAPER_MAX_EV.toFixed(1)};
vec3 sfShaper(vec3 lv) {
  return clamp((log2(max(lv, vec3(1e-10))) - SF_MIN_EV) / (SF_MAX_EV - SF_MIN_EV), 0.0, 1.0);
}
float sfHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
vec3 sfSampleLut(sampler2D atlas, vec3 rgb, float n) {
  rgb = clamp(rgb, 0.0, 1.0);
  float bf = rgb.b * (n - 1.0);
  float b0 = floor(bf);
  float b1 = min(b0 + 1.0, n - 1.0);
  float fb = bf - b0;
  float gx = rgb.r * (n - 1.0);
  float gy = rgb.g * (n - 1.0);
  float u0 = (b0 * n + gx + 0.5) / (n * n);
  float u1 = (b1 * n + gx + 0.5) / (n * n);
  float v  = (gy + 0.5) / n;
  vec3 c0 = texture(atlas, vec2(u0, v)).rgb;
  vec3 c1 = texture(atlas, vec2(u1, v)).rgb;
  return mix(c0, c1, fb);
}
`;
