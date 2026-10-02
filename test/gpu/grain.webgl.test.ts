// The grain stage on a real GLSL ES 3.00 driver. Run via `npm run test:gpu`
// (test/gpu/run.cjs copies this file into a SafeLight checkout and runs it
// under its headless Chromium + SwiftShader rig).
//
// Grain must be stochastic everywhere in the frame. The lattice it hashes runs
// to tens of thousands of cells (frame-relative cells × aspect ÷ Size ÷ the
// per-channel scale × the second octave's 2.17), so the hash has to stay
// independent per cell at those coordinates on real float32 hardware — a CPU
// transcription cannot show that. Checked twice: the hash itself on a bare
// program, and the rendered grain through the real renderer.

import { describe, expect, it } from "vitest";
import { buildGrainStage } from "@sf/index";
import { FILM_STOCKS } from "@sf/stocks_data.generated";
import {
  LINEAR_PROBE_PIPELINE,
  buildProgram,
  builtinStages,
  floatImage,
  glHarness,
  identityParams,
  releaseProgram,
  withRenderer,
} from "@/rendering/webgl/webgl.test-support";

const FX = FILM_STOCKS[0].fx;

/** Largest |normalised autocorrelation| of a row-major field over lags in
 *  [-maxLag, maxLag]², skipping lags whose Chebyshev distance is below
 *  minLag (the noise's own interpolation footprint). */
function worstAutocorrelation(
  v: Float64Array,
  w: number,
  h: number,
  minLag: number,
  maxLag: number,
): { r: number; lag: [number, number] } {
  let mean = 0;
  for (const x of v) mean += x;
  mean /= v.length;
  let variance = 0;
  for (const x of v) variance += (x - mean) ** 2;
  variance /= v.length;
  let worst = { r: 0, lag: [0, 0] as [number, number] };
  for (let dy = 0; dy <= maxLag; dy++) {
    for (let dx = -maxLag; dx <= maxLag; dx++) {
      if (dy === 0 && dx <= 0) continue;
      if (Math.max(Math.abs(dx), dy) < minLag) continue;
      let sum = 0;
      let n = 0;
      for (let y = 0; y + dy < h; y++) {
        for (let x = Math.max(0, -dx); x < w && x + dx < w; x++) {
          sum += (v[y * w + x] - mean) * (v[(y + dy) * w + x + dx] - mean);
          n++;
        }
      }
      const r = sum / n / variance;
      if (Math.abs(r) > Math.abs(worst.r)) worst = { r, lag: [dx, dy] };
    }
  }
  return worst;
}

function meanAndSd(v: Float64Array): { mean: number; sd: number } {
  let mean = 0;
  for (const x of v) mean += x;
  mean /= v.length;
  let variance = 0;
  for (const x of v) variance += (x - mean) ** 2;
  return { mean, sd: Math.sqrt(variance / v.length) };
}

describe("Spektrafilm grain on the GPU", () => {
  it("hashes every lattice cell the grain reaches independently", () => {
    const { gl } = glHarness();
    expect(gl.getExtension("EXT_color_buffer_float")).not.toBeNull();
    const vertex = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
    const fragment = `#version 300 es
precision highp float;
${buildGrainStage(FX).helpers}
uniform vec2 uOrigin;
out vec4 fragColor;
void main() {
  fragColor = vec4(sfHash1(uOrigin + floor(gl_FragCoord.xy)), 0.0, 0.0, 1.0);
}`;
    const build = buildProgram(gl, vertex, fragment);
    expect(build.error).toBeNull();

    const N = 256;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, N, N);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, N, N);
    gl.useProgram(build.program);
    const origin = gl.getUniformLocation(build.program!, "uOrigin");

    // From the frame's top-left cell out past the far corner of a 3:1 frame at
    // the smallest Grain Size on the coarsest channel's second octave.
    const origins: [number, number][] = [
      [0, 0],
      [500, 300],
      [2000, 1500],
      [6000, 4000],
      [17000, 11000],
      [45000, 30000],
    ];
    const pixels = new Float32Array(N * N * 4);
    try {
      for (const [ox, oy] of origins) {
        gl.uniform2f(origin, ox, oy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, pixels);
        const cells = new Float64Array(N * N);
        for (let i = 0; i < N * N; i++) cells[i] = pixels[i * 4];
        const { mean, sd } = meanAndSd(cells);
        const worst = worstAutocorrelation(cells, N, N, 1, 24);
        console.log(
          `[sf-gpu] cells @ (${ox}, ${oy}): mean ${mean.toFixed(4)}, sd ${sd.toFixed(4)}, ` +
            `worst autocorrelation ${worst.r.toFixed(4)} at lag (${worst.lag.join(", ")})`,
        );
        // Uniform on [0, 1): mean 1/2, sd 1/√12 ≈ 0.2887. White noise over
        // 65k cells keeps every lag's |r| near 0.004; 0.03 is ~7σ.
        expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
        expect(Math.abs(sd - 1 / Math.sqrt(12))).toBeLessThan(0.01);
        expect(Math.abs(worst.r)).toBeLessThan(0.03);
      }
    } finally {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      releaseProgram(gl, build);
    }
  });

  it("renders grain without repeating structure through the real renderer", () => {
    // 3:2 at Grain Size 5 puts roughly one first-octave cell on each pixel, so
    // any lattice structure in the hash shows up in the rendered residual.
    const W = 768;
    const H = 512;
    const grey = floatImage(W, H, () => [0.5, 0.5, 0.5]);
    const stage = buildGrainStage(FX);
    const frames = withRenderer(
      { stages: [...builtinStages(), stage], pipeline: LINEAR_PROBE_PIPELINE },
      (renderer) => {
        renderer.setImage(grey);
        renderer.setParams(identityParams());
        renderer.setContributedParams({});
        const off = renderer.captureFloatFrame();
        renderer.setContributedParams({
          [`${stage.id}.sfGrainAmount`]: 0.5,
          [`${stage.id}.sfGrainSize`]: 5,
        });
        const on = renderer.captureFloatFrame();
        return { off, on };
      },
    );
    expect(frames.off).not.toBeNull();
    expect(frames.on).not.toBeNull();
    const { off, on } = frames as { off: NonNullable<typeof frames.off>; on: NonNullable<typeof frames.on> };
    expect(on.width).toBe(W);
    expect(on.height).toBe(H);

    // A corner on the far side of the frame from the lattice origin in x, where
    // the coordinates the hash sees are large.
    const C = 256;
    for (let ch = 0; ch < 3; ch++) {
      const residual = new Float64Array(C * C);
      for (let y = 0; y < C; y++) {
        for (let x = 0; x < C; x++) {
          const i = ((H - C + y) * W + (W - C + x)) * 4 + ch;
          residual[y * C + x] = on.data[i] - off.data[i];
        }
      }
      const { sd } = meanAndSd(residual);
      // Value noise interpolates across a cell (~1–2 px here), so neighbours
      // within 3 px correlate by design; past that, a stochastic field doesn't.
      const worst = worstAutocorrelation(residual, C, C, 3, 24);
      console.log(
        `[sf-gpu] rendered grain ch${ch}: residual sd ${sd.toFixed(4)}, ` +
          `worst autocorrelation ${worst.r.toFixed(4)} at lag (${worst.lag.join(", ")})`,
      );
      expect(sd).toBeGreaterThan(0.02);
      expect(Math.abs(worst.r)).toBeLessThan(0.05);
    }
  });
});
