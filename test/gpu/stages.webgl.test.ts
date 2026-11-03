// The film, Halation and Grain on the real renderer: at rest, over range, per
// photo and at any render size. Run via `npm run test:gpu` (run.cjs copies the
// specs into a SafeLight checkout and runs them under its headless Chromium +
// SwiftShader rig).
//
// The stages stay registered whatever the photo open in Develop uses, and the
// spectral textures hold every stock, so a photo's own bag picks its stock in
// whichever renderer draws it. With no stock picked all three must leave the
// frame bit-exact. On process version 2 the host clips a display stage that
// declares no space to [0, 1] ahead of its block, for as long as the stage is
// registered. A downstream output-encode stage that halves c (declaring a
// space, so it adds no clip of its own) makes a clip anywhere upstream show in
// the capture, even behind the core Vignette and Grain. A no-space stage at the
// same phase and priority is the positive control: it must change the frame,
// or the scene doesn't reach the effects phase over range.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, DEFAULT_GRAIN, DEFAULT_VIGNETTE } from "@/catalog/types";
import type { PipelineContribution, ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import {
  LINEAR_PROBE_PIPELINE,
  builtinStages,
  floatImage,
  identityParams,
  withRenderer,
  type Frame,
} from "@/rendering/webgl/webgl.test-support";
import { activate, buildAtlases, buildGrainStage, buildHalationStage, buildStage, deactivate } from "@sf/index";
import { FILM_STOCKS, type FilmStockData } from "@sf/stocks_data.generated";

const W = 96;
const H = 64;
const FILM = "spektrafilm-support.film";
const HAL = "spektrafilm-support.halation";
const GRAIN = "spektrafilm-support.grain";
const STOCK = `${FILM}.sfStock`;
const NEGATIVE = FILM_STOCKS.findIndex((s) => s.kind === "negative");
const SLIDE = FILM_STOCKS.findIndex((s) => s.kind === "slide");
const BW = FILM_STOCKS.findIndex((s) => s.kind === "bw");
const OPEN_PROBE = { ...LINEAR_PROBE_PIPELINE, id: "test.open-probe", sig: "test.open-probe", skipToneShoulder: true };
const CURRENT = { processVersion: CURRENT_PROCESS_VERSION };
const OVER = {
  processVersion: CURRENT_PROCESS_VERSION,
  vignette: { ...DEFAULT_VIGNETTE, amount: 30 },
  grain: { ...DEFAULT_GRAIN, amount: 100 },
};
const HALVE: ProcessingStageContribution = {
  id: "test.halve",
  name: "Halve",
  phase: "output-encode",
  priority: 1000,
  glsl: "c *= 0.5;",
  uniforms: [],
  space: { encoding: "perceptual" },
};
// Spreads the film's print past both ends of [0, 1] ahead of the effects,
// declaring a space so it adds no clip of its own.
const STRETCH: ProcessingStageContribution = {
  id: "test.stretch",
  name: "Stretch",
  phase: "display-adjust",
  glsl: "c = c * 4.0 - 1.5;",
  uniforms: [],
  space: { encoding: "perceptual" },
};

// The spectral table marks opaque bins with a base density of 1e6, past
// binary16's largest value, so the upload stores infinity. Any density in the
// thousands transmits exactly nothing in float32, so the rig stores binary16's
// largest value there instead: the same film.
const HALF_MAX = 65504;

function textures(stocks: readonly FilmStockData[] = FILM_STOCKS): Record<string, StageTextureData> {
  const atlases = buildAtlases(stocks);
  return {
    [`${FILM}.filmTc`]: { ...atlases.filmTc, version: 1 },
    [`${FILM}.filmCurves`]: { ...atlases.filmCurves, version: 1 },
    [`${FILM}.filmSpec`]: { ...atlases.filmSpec, data: atlases.filmSpec.data.map((v) => Math.min(v, HALF_MAX)), version: 1 },
  };
}

const extension = (stocks: readonly FilmStockData[] = FILM_STOCKS): ProcessingStageContribution[] =>
  [buildStage(stocks), buildHalationStage(stocks), buildGrainStage(stocks)] as ProcessingStageContribution[];

/** Channels past white and colours outside sRGB, with strongly negative channels. */
const WIDE_SCENE = floatImage(W, H, (x, y) => {
  const u = x / (W - 1);
  const v = y / (H - 1);
  if (y < H / 4) return [0.5 + 3.5 * u, 0.3 + 2.2 * u, 0.2 + 1.4 * u];
  if (y < H / 2) return [0.2 + 1.2 * u, -0.05 - 0.45 * v, 0.1 + 0.9 * u];
  if (y < (3 * H) / 4) return [-0.2 - 0.3 * u, 0.4 + 0.8 * v, -0.1 - 0.4 * v];
  return [0.05 + 0.8 * u, 0.05 + 0.8 * u, 0.05 + 0.8 * u];
});

/** Frames in sequence on one renderer, one per bag: renderers share one
 *  context, and a nested one's dispose() tears down GL state the outer one
 *  relies on. By default the capture is the output, binary16 and held to
 *  [0, 1], behind HALVE. `signed` reads `c` as the output stage receives it
 *  instead, in float32 with its sign and headroom, for checks that need to see
 *  past both ends or below the capture's half-float step. */
function frames(
  stages: ProcessingStageContribution[],
  bags: Record<string, unknown>[],
  {
    tex = textures(),
    signed = false,
    params = OVER,
  }: { tex?: Record<string, StageTextureData>; signed?: boolean; params?: Parameters<typeof identityParams>[0] } = {},
): Frame[] {
  const all = [...builtinStages(), ...(signed ? [] : [HALVE]), ...stages];
  return withRenderer({ stages: all, pipeline: OPEN_PROBE }, (r) => {
    r.setImage(WIDE_SCENE);
    r.setStageTextures(tex);
    return bags.map((bag) => {
      r.setParams(identityParams(params));
      r.setContributedParams(bag);
      const f = signed
        ? r.readFloatFrame("pre-output", Infinity, { encoding: "perceptual" })
        : r.captureFloatFrame();
      if (!f) throw new Error("the frame couldn't be read");
      return f;
    });
  });
}
const frame = (stages: ProcessingStageContribution[], bag: Record<string, unknown> = {}): Frame => frames(stages, [bag])[0];

const differing = (a: Frame, b: Frame): number => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};
const largest = (a: Frame, b: Frame): number => {
  let m = 0;
  for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  return m;
};

describe("Spektrafilm at rest on version 2", () => {
  it("a no-space effects stage clips the wide scene (positive control)", () => {
    const control: ProcessingStageContribution = {
      id: "test.clips-ahead",
      name: "Clips ahead",
      phase: "effects",
      priority: 50,
      glsl: "c = c;",
      uniforms: [],
    };
    expect(differing(frame([control]), frame([]))).toBeGreaterThan(W * H * 0.1);
  });

  it("with no stock picked the film, Halation and Grain leave values outside [0, 1] bit-exact", () => {
    const bare = frame([]);
    const [off, effectsUp] = frames(extension(), [
      {},
      { [`${HAL}.sfHalAmount`]: 0.5, [`${GRAIN}.sfGrainAmount`]: 0.5 },
    ]);
    expect(differing(off, bare)).toBe(0);
    expect(differing(effectsUp, bare)).toBe(0);
  });

  for (const [name, k] of [["a negative", NEGATIVE], ["a slide", SLIDE], ["B&W", BW]] as const) {
    it(`Halation and Grain at amount 0 leave ${name}'s print bit-exact`, () => {
      const filmOnly = frame([buildStage() as ProcessingStageContribution], { [STOCK]: k });
      const all = frame(extension(), { [STOCK]: k });
      expect(differing(filmOnly, frame([]))).toBeGreaterThan(W * H * 0.1);
      expect(differing(all, filmOnly)).toBe(0);
    });
  }
});

describe("Spektrafilm effects keep the full range on version 2", () => {
  const stretched = (over: Record<string, number>) =>
    frames([STRETCH, ...extension()], [{ [STOCK]: NEGATIVE, ...over }], { signed: true, params: CURRENT })[0];

  // Without the core Vignette and Grain, each channel reaches the effects as
  // the frame shows it. Read signed: the output capture holds everything to
  // [0, 1], so it can't show a value below black. Grain moves a channel by at
  // most Amount / 2, so channels well past either end stay past it unless
  // something clipped them.
  for (const [name, amounts] of [
    ["Halation", { [`${HAL}.sfHalAmount`]: 0.8, [`${HAL}.sfHalThreshold`]: 0.2 }],
    ["Grain", { [`${GRAIN}.sfGrainAmount`]: 0.8 }],
  ] as const) {
    it(`${name} hands channels outside [0, 1] on unclipped`, () => {
      const ref = stretched({});
      const on = stretched(amounts);
      let over = 0;
      let overClipped = 0;
      let overMoved = 0;
      let under = 0;
      let underClipped = 0;
      let moved = 0;
      for (let i = 0; i < ref.data.length; i++) {
        if (i % 4 === 3) continue;
        if (on.data[i] !== ref.data[i]) moved++;
        if (ref.data[i] > 1.5) {
          over++;
          if (!(on.data[i] > 1)) overClipped++;
          if (on.data[i] !== ref.data[i]) overMoved++;
        }
        if (ref.data[i] < -0.5) {
          under++;
          if (!(on.data[i] < 0)) underClipped++;
        }
      }
      console.log(
        `[sf-gpu] ${name} over range: ${over} past white (${overClipped} clipped, ${overMoved} moved), ` +
          `${under} below black (${underClipped} clipped), ${moved} moved in all`,
      );
      expect(over).toBeGreaterThan(W * H * 0.1);
      expect(under).toBeGreaterThan(W * H * 0.1);
      expect(moved).toBeGreaterThan(W * H * 0.05);
      expect(overClipped).toBe(0);
      // The screen blend has nothing left to add to a channel already past white.
      if (name === "Halation") expect(overMoved).toBe(0);
      else expect(underClipped).toBe(0);
    });
  }
});

// Version 1 photos keep the look they were edited with: the screen blend works
// on c held to [0, 1] and replaces it, so nothing it hands on lies outside
// [0, 1], whatever reaches it. The signed read would show a value past either
// end; the count handed in says whether the host had already held them there.
describe("Spektrafilm effects keep version 1's look", () => {
  it("Halation's screen blend stays inside [0, 1] on version 1", () => {
    const V1 = { processVersion: 1 };
    const halo = { [STOCK]: NEGATIVE, [`${HAL}.sfHalAmount`]: 0.8, [`${HAL}.sfHalThreshold`]: 0.2 };
    const [ref, on] = frames([STRETCH, ...extension()], [{ [STOCK]: NEGATIVE }, halo], { signed: true, params: V1 });
    let outside = 0;
    let refOutside = 0;
    for (let i = 0; i < on.data.length; i++) {
      if (i % 4 === 3) continue;
      if (on.data[i] < 0 || on.data[i] > 1) outside++;
      if (ref.data[i] < 0 || ref.data[i] > 1) refOutside++;
    }
    console.log(`[sf-gpu] version 1 halation: ${differing(on, ref)} values moved, ${outside} outside [0, 1], ${refOutside} handed in outside it`);
    expect(differing(on, ref)).toBeGreaterThan(W * H * 0.05);
    expect(outside).toBe(0);
  });
});

describe("Spektrafilm stock per photo", () => {
  it("one renderer develops each photo with its own stock, whatever came before", () => {
    const bare = frame([]);
    const [a, none, c, again] = frames(extension(), [{ [STOCK]: SLIDE }, {}, { [STOCK]: BW }, { [STOCK]: SLIDE }]);
    expect(differing(a, bare)).toBeGreaterThan(W * H * 0.1);
    expect(differing(none, bare)).toBe(0);
    expect(differing(c, a)).toBeGreaterThan(W * H * 0.1);
    expect(differing(again, a)).toBe(0);
  });

  it("a stock renders from the full table as it does from a table of its own", () => {
    for (const k of [0, NEGATIVE, SLIDE, BW, FILM_STOCKS.length - 1]) {
      const alone = [FILM_STOCKS[k]];
      const own = frames([buildStage(alone) as ProcessingStageContribution], [{ [STOCK]: 0 }], { tex: textures(alone), signed: true })[0];
      const full = frames([buildStage() as ProcessingStageContribution], [{ [STOCK]: k }], { signed: true })[0];
      const d = largest(own, full);
      console.log(`[sf-gpu] ${FILM_STOCKS[k].id}: full table against its own, worst ${d.toExponential(2)}`);
      expect(differing(full, frame([]))).toBeGreaterThan(W * H * 0.1);
      expect(d).toBeLessThanOrEqual(1e-4);
    }
  });

  it("an index past the bundled stocks develops nothing", () => {
    const bare = frame([]);
    expect(differing(frame(extension(), { [STOCK]: FILM_STOCKS.length }), bare)).toBe(0);
    expect(differing(frame(extension(), { [STOCK]: -1 }), bare)).toBe(0);
  });
});

describe("Spektrafilm halation at any render size", () => {
  // A bright bar on a dark ground, at two sizes of the same frame. The halo is
  // the glow Halation adds; its extent is the share of columns it reaches.
  const bar = (w: number, h: number) =>
    floatImage(w, h, (x) => (Math.abs(x - w / 2) < w / 32 ? [4, 4, 4] : [0.02, 0.02, 0.02]));
  const HALO = { [STOCK]: NEGATIVE, [`${HAL}.sfHalAmount`]: 0.6, [`${HAL}.sfHalSize`]: 6, [`${HAL}.sfHalThreshold`]: 0.6 };

  function extent(w: number, h: number, processVersion: number = CURRENT_PROCESS_VERSION, threshold = 0.6): number {
    const [off, on] = withRenderer({ stages: [...builtinStages(), ...extension()], pipeline: OPEN_PROBE }, (r) => {
      r.setImage(bar(w, h));
      r.setStageTextures(textures());
      r.setParams(identityParams({ processVersion }));
      const halo = { ...HALO, [`${HAL}.sfHalThreshold`]: threshold };
      return [{ ...halo, [`${HAL}.sfHalAmount`]: 0 }, halo].map((b) => {
        r.setContributedParams(b);
        const f = r.captureFloatFrame();
        if (!f) throw new Error("captureFloatFrame returned null");
        return f;
      });
    });
    let reached = 0;
    for (let x = 0; x < w; x++) {
      let glow = 0;
      for (let y = 0; y < h; y++) glow += on.data[(y * w + x) * 4] - off.data[(y * w + x) * 4];
      if (glow / h > 1e-3) reached++;
    }
    return reached / w;
  }

  it("spreads the halo over the same share of the frame at 1024 and 256 pixels", () => {
    const large = extent(1024, 64);
    const small = extent(256, 16);
    console.log(`[sf-gpu] halo extent: ${(large * 100).toFixed(1)}% at 1024, ${(small * 100).toFixed(1)}% at 256`);
    expect(large).toBeGreaterThan(0.02);
    expect(small).toBeLessThan(0.3);
    expect(Math.abs(large - small)).toBeLessThan(0.06);
  });

  // Version 1 read the level Size names at any source size, so the same Size
  // blurs the same number of texels, and a small render glows over a wider
  // share of its frame. At level 6 a 256-pixel frame is four texels wide, so
  // the bar averages to about 0.5 there, under the default Threshold; a low
  // Threshold lets that wide, faint glow through at both sizes.
  it("keeps version 1's level, which spreads wider at 256 pixels", () => {
    const large = extent(1024, 64, 1, 0.1);
    const small = extent(256, 16, 1, 0.1);
    console.log(`[sf-gpu] version 1 halo extent: ${(large * 100).toFixed(1)}% at 1024, ${(small * 100).toFixed(1)}% at 256`);
    expect(large).toBeGreaterThan(0.02);
    expect(small - large).toBeGreaterThan(0.1);
  });
});

describe("activate", () => {
  it("registers the film, Halation and Grain once, uploads every stock, and gives the film transform its own highlights", () => {
    const registered = new Map<string, unknown>();
    const unregistered: string[] = [];
    const uploads = new Map<string, StageTextureData | null>();
    const pipelines: PipelineContribution[] = [];
    const state = { paramBag: {} };
    const useDevelopStore = Object.assign(() => undefined, {
      getState: () => state,
      subscribe: () => () => {},
    });
    activate({
      react: { createElement: () => null, useState: <T,>(v: T) => [v, () => {}] },
      registerProcessingStage: (s: { id: string }) => registered.set(s.id, s),
      unregisterProcessingStage: (id: string) => {
        unregistered.push(id);
        registered.delete(id);
      },
      setStageTexture: (stageId: string, key: string, tex: StageTextureData | null) => uploads.set(`${stageId}.${key}`, tex),
      registerPipeline: (p: PipelineContribution) => pipelines.push(p),
      registerPanel: () => {},
      settings: { get: <T,>(_k: string, fallback: T) => fallback, set: () => {} },
      components: {},
      ui: {},
      stores: { useDevelopStore },
    } as unknown as Parameters<typeof activate>[0]);
    try {
      expect([...registered.keys()].sort()).toEqual([FILM, GRAIN, HAL].sort());
      expect(unregistered).toEqual([]);
      expect(uploads.get(`${FILM}.filmTc`)?.height).toBe(FILM_STOCKS[0].tcSize * FILM_STOCKS.length);
      expect(pipelines).toHaveLength(1);
      expect(pipelines[0]).toMatchObject({ skipBaseCurve: true, skipToneShoulder: true });
    } finally {
      deactivate();
    }
  });
});
