// Shared film-LUT conventions. The runtime lookup (this file + the stage glsl in
// index.ts) and the bake converter (tools/cube_to_stocks.mjs) MUST agree on the
// input encoding and the atlas layout, or baked film stocks won't line up with
// what the shader samples.
//
// Input domain: sRGB-encoded [0,1]. We bake LUTs with spektrafilm-lut using
// `--input srgb --output srgb`, so the .cube maps sRGB-encoded input → sRGB-
// encoded film output. The shader sRGB-encodes scene-linear `lin` before the
// lookup (the develop shader's linearToSrgb) and decodes the result back to
// linear. sRGB encoding gives perceptual precision for an 8-bit LUT.
//
// A 3D LUT is stored as a 2D "tiled" atlas: the blue axis is sliced along x, so
// the texture is (N*N) wide by N tall. Slice b occupies columns [b*N, b*N+N);
// within a slice, x = red index, y = green index.

export const LUT_SIZE = 33; // cube edge — 33^3 = 35937 nodes
export const ATLAS_W = LUT_SIZE * LUT_SIZE; // slices laid along x
export const ATLAS_H = LUT_SIZE;

export interface Stock {
  id: string;
  name: string;
  /** Lazily builds the rgba8 atlas bytes (ATLAS_W * ATLAS_H * 4). */
  atlas: () => Uint8Array;
}

/** A neutral placeholder atlas: an identity LUT in sRGB code space (output code
 *  == input code), so with no film stock baked yet the stage is a pass-through
 *  and the image renders normally. Replace by baking real stocks — see README. */
export function buildIdentityAtlas(): Uint8Array {
  const n = LUT_SIZE;
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const idx = (g * ATLAS_W + (b * n + r)) * 4;
        data[idx] = Math.round((r / (n - 1)) * 255);
        data[idx + 1] = Math.round((g / (n - 1)) * 255);
        data[idx + 2] = Math.round((b / (n - 1)) * 255);
        data[idx + 3] = 255;
      }
    }
  }
  return data;
}

/** Decode a base64 atlas (as emitted by tools/cube_to_stocks.mjs) to bytes. */
export function decodeBase64Atlas(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// GLSL helpers for the film stage: a grain hash and the tiled-atlas trilinear
// sampler. The input shaper is just the develop shader's `linearToSrgb` (used
// directly in the inline glsl), so it isn't redefined here.
export const LUT_GLSL_HELPERS = `
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
