// The film stage inside a local-adjustment mask on the real renderer. Run via
// `npm run test:gpu` (run.cjs copies the specs into a SafeLight checkout and
// runs them under its headless Chromium + SwiftShader rig).
//
// A mask's copy of a stage runs right after it, on what the stage left: here a
// developed print. Developing that print again would be a film of a film, so
// the copy takes the scene the stage developed and the photo's settings from
// the stage, and develops it with the mask's settings on top: exposure and
// filtration add, print exposure, coupler amount and contrast multiply. Inside
// the mask the frame must therefore be the photo developed with the combined
// settings, which the stage itself renders unmasked; outside it, the photo's
// own frame, bit for bit. The settings below combine exactly in binary, so the
// copy's uniforms and the combined photo's are the same floats.

import { describe, expect, it } from "vitest";
import { defaultMaskAdjustments, type Mask } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import {
  LINEAR_PROBE_PIPELINE,
  builtinStages,
  floatImage,
  identityParams,
  withRenderer,
  type Frame,
} from "@/rendering/webgl/webgl.test-support";
import { buildStage } from "@sf/index";
import { FILM_STOCKS } from "@sf/stocks_data.generated";

const W = 256;
const H = 48;
const FILM = "spektrafilm-support.film";
const STOCK = FILM_STOCKS.find((s) => s.kind === "negative")!;

// The spectral table marks opaque bins with a base density of 1e6, past
// binary16's largest value, so the upload stores infinity; SwiftShader's
// linear filter turns a zero weight on it into NaN and the film renders
// black. Any density in the thousands transmits exactly nothing in float32,
// so the rig stores binary16's largest value there instead: the same film.
const HALF_MAX = 65504;
const filmSpec = STOCK.filmSpec().map((v) => Math.min(v, HALF_MAX));

const TEXTURES = {
  [`${FILM}.filmTc`]: { data: STOCK.filmTc(), width: STOCK.tcSize, height: STOCK.tcSize, format: "rgba16f" as const, version: 1 },
  [`${FILM}.filmCurves`]: { data: STOCK.filmCurves(), width: 256, height: 3, format: "rgba16f" as const, version: 1 },
  [`${FILM}.filmSpec`]: { data: filmSpec, width: 81, height: 4, format: "rgba16f" as const, version: 1 },
};

/** A hue sweep by column over three brightness bands, in scene-linear light. */
const SCENE = floatImage(W, H, (x, y) => {
  const t = (6 * x) / W;
  const k = Math.floor(t) % 6;
  const f = t - Math.floor(t);
  const hue: [number, number, number][] = [
    [1, f, 0],
    [1 - f, 1, 0],
    [0, 1, f],
    [0, 1 - f, 1],
    [f, 0, 1],
    [1, 0, 1 - f],
  ];
  const level = [0.04, 0.18, 0.6][Math.floor((3 * y) / H)];
  const [r, g, b] = hue[k];
  return [level * (0.25 + 0.75 * r), level * (0.25 + 0.75 * g), level * (0.25 + 0.75 * b)];
});

type Settings = Record<"sfExposure" | "sfPrintExp" | "sfCouplerAmt" | "sfContrast" | "sfFiltM" | "sfFiltY", number>;

const bag = (s: Settings): Record<string, number> =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [`${FILM}.${k}`, v]));

const PHOTO: Settings = { sfExposure: 0.25, sfPrintExp: 1.25, sfCouplerAmt: 0.75, sfContrast: 1, sfFiltM: 5, sfFiltY: -4 };
const MASK: Settings = { sfExposure: 0.75, sfPrintExp: 0.75, sfCouplerAmt: 1.25, sfContrast: 1.25, sfFiltM: 10, sfFiltY: 8 };
const COMBINED: Settings = { sfExposure: 1, sfPrintExp: 0.9375, sfCouplerAmt: 0.9375, sfContrast: 1.25, sfFiltM: 15, sfFiltY: 4 };
const AT_REST: Settings = { sfExposure: 0, sfPrintExp: 1, sfCouplerAmt: 1, sfContrast: 1, sfFiltM: 0, sfFiltY: 0 };

// A linear gradient whose step sits at u = 0.5: the right half is covered.
const rightHalf = (settings: Settings): Mask => ({
  id: "m",
  name: "Mask",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: ["spektrafilm-support.panel"],
  bag: bag(settings),
  components: [{ id: "right", kind: "linear", mode: "add", invert: false, linear: { x0: 0.5, y0: 0, x1: 0.5001, y1: 0 } }],
});

// Columns either side of the step, clear of the three its baked coverage ramps
// over at this width (about 0.2, 0.6 and 0.98 from column 128).
const left = (x: number) => x < W / 2 - 1;
const right = (x: number) => x > W / 2 + 2;

/** Frames in sequence on one renderer: renderers share one context, and a
 *  nested one's dispose() tears down GL state the outer one relies on. */
function frames(runs: { photo: Settings; masks: Mask[] }[]): Frame[] {
  const stages = [...builtinStages(), buildStage(STOCK) as ProcessingStageContribution];
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(SCENE);
    r.setStageTextures(TEXTURES);
    return runs.map(({ photo, masks }) => {
      r.setContributedParams(bag(photo));
      r.setParams(identityParams({ processVersion: 2, masks }));
      const f = r.captureFloatFrame();
      if (!f) throw new Error("captureFloatFrame returned null");
      return f;
    });
  });
}

/** Largest difference and rms over the columns `inside` picks. */
function difference(a: Frame, b: Frame, inside: (x: number) => boolean): { max: number; rms: number; worst: string } {
  let max = 0;
  let se = 0;
  let n = 0;
  let worst = "";
  for (let p = 0; p < W * H; p++) {
    if (!inside(p % W)) continue;
    for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(a.data[p * 4 + ch] - b.data[p * 4 + ch]);
      se += d * d;
      n++;
      if (d > max) {
        max = d;
        worst = `x=${p % W} y=${Math.floor(p / W)} ch=${ch} a=${a.data[p * 4 + ch]} b=${b.data[p * 4 + ch]}`;
      }
    }
  }
  return { max, rms: Math.sqrt(se / Math.max(1, n)), worst };
}

describe("Spektrafilm's film stage in a mask", () => {
  it("develops the photo's scene with the mask's settings on top inside the mask, and leaves the rest as it was", () => {
    const [off, on, combined] = frames([
      { photo: PHOTO, masks: [] },
      { photo: PHOTO, masks: [rightHalf(MASK)] },
      { photo: COMBINED, masks: [] },
    ]);
    const outside = difference(on, off, left);
    const change = difference(on, off, right);
    const inside = difference(on, combined, right);
    console.log(
      `[sf-gpu] masked film: change rms ${change.rms.toExponential(2)}; against the combined photo ` +
        `rms ${inside.rms.toExponential(2)}, max ${inside.max.toExponential(2)} at ${inside.worst}`,
    );
    expect(outside.max).toBe(0);
    expect(change.rms).toBeGreaterThan(1e-2);
    expect(inside.max).toBeLessThanOrEqual(1e-6);
  });

  it("changes nothing while the mask's settings are at rest", () => {
    const [off, idle] = frames([
      { photo: PHOTO, masks: [] },
      { photo: PHOTO, masks: [rightHalf(AT_REST)] },
    ]);
    const all = difference(idle, off, () => true);
    console.log(`[sf-gpu] mask at rest: worst ${all.max.toExponential(2)} at ${all.worst}`);
    expect(all.max).toBeLessThanOrEqual(1e-6);
  });
});
