// Halation and Grain at rest on the real renderer, and what activate()
// registers with no stock picked. Run via `npm run test:gpu` (run.cjs copies
// the specs into a SafeLight checkout and runs them under its headless
// Chromium + SwiftShader rig).
//
// On process version 2 the host clips a display stage that declares no space
// to [0, 1] ahead of its block, outside its own gate, for as long as the stage
// is registered. A downstream output-encode stage that halves c (declaring a
// space, so it adds no clip of its own) makes a clip anywhere upstream show in
// the capture, even behind the core Vignette and Grain. A no-space stage at the
// same phase and priority is the positive control: it must change the frame,
// or the scene doesn't reach the effects phase over range.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, DEFAULT_GRAIN, DEFAULT_VIGNETTE } from "@/catalog/types";
import type { PipelineContribution, ProcessingStageContribution } from "@/extensions/types";
import {
  LINEAR_PROBE_PIPELINE,
  builtinStages,
  floatImage,
  identityParams,
  withRenderer,
  type Frame,
} from "@/rendering/webgl/webgl.test-support";
import { activate, buildGrainStage, buildHalationStage, deactivate } from "@sf/index";
import { FILM_STOCKS } from "@sf/stocks_data.generated";

const W = 96;
const H = 64;
const FX = FILM_STOCKS[0].fx;
const OPEN_PROBE = { ...LINEAR_PROBE_PIPELINE, id: "test.open-probe", sig: "test.open-probe", skipToneShoulder: true };
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

/** Channels past white and colours outside sRGB, with strongly negative channels. */
const WIDE_SCENE = floatImage(W, H, (x, y) => {
  const u = x / (W - 1);
  const v = y / (H - 1);
  if (y < H / 4) return [0.5 + 3.5 * u, 0.3 + 2.2 * u, 0.2 + 1.4 * u];
  if (y < H / 2) return [0.2 + 1.2 * u, -0.05 - 0.45 * v, 0.1 + 0.9 * u];
  if (y < (3 * H) / 4) return [-0.2 - 0.3 * u, 0.4 + 0.8 * v, -0.1 - 0.4 * v];
  return [0.05 + 0.8 * u, 0.05 + 0.8 * u, 0.05 + 0.8 * u];
});

function frame(stages: ProcessingStageContribution[]): Frame {
  return withRenderer({ stages: [...builtinStages(), HALVE, ...stages], pipeline: OPEN_PROBE }, (r) => {
    r.setImage(WIDE_SCENE);
    r.setParams(identityParams(OVER));
    r.setContributedParams({});
    const f = r.captureFloatFrame();
    if (!f) throw new Error("captureFloatFrame returned null");
    return f;
  });
}

const differing = (a: Frame, b: Frame): number => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

const idle: [string, ProcessingStageContribution][] = [
  ["Halation", buildHalationStage(FX) as ProcessingStageContribution],
  ["Halation (B&W)", buildHalationStage(FX, true) as ProcessingStageContribution],
  ["Grain", buildGrainStage(FX) as ProcessingStageContribution],
  ["Grain (B&W)", buildGrainStage(FX, true) as ProcessingStageContribution],
];

describe("Spektrafilm effects at rest on version 2", () => {
  for (const [name, stage] of idle) {
    it(`${name} at amount 0 leaves values outside [0, 1] bit-exact`, () => {
      const bare = frame([]);
      const control: ProcessingStageContribution = {
        id: "test.clips-ahead",
        name: "Clips ahead",
        phase: stage.phase,
        priority: stage.priority,
        glsl: "c = c;",
        uniforms: [],
      };
      expect(differing(frame([control]), bare)).toBeGreaterThan(W * H * 0.1);
      expect(differing(frame([stage]), bare)).toBe(0);
    });
  }
});

describe("activate with no stock picked", () => {
  it("leaves no stage registered and gives the film transform its own highlights", () => {
    const registered = new Map<string, unknown>();
    const unregistered: string[] = [];
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
      setStageTexture: () => {},
      registerPipeline: (p: PipelineContribution) => pipelines.push(p),
      registerPanel: () => {},
      settings: { get: <T,>(_k: string, fallback: T) => fallback, set: () => {} },
      components: {},
      stores: { useDevelopStore },
    } as unknown as Parameters<typeof activate>[0]);
    try {
      expect([...registered.keys()]).toEqual([]);
      expect(unregistered).toEqual(
        expect.arrayContaining(["spektrafilm-support.film", "spektrafilm-support.halation", "spektrafilm-support.grain"]),
      );
      expect(pipelines).toHaveLength(1);
      expect(pipelines[0]).toMatchObject({ skipBaseCurve: true, skipToneShoulder: true });
    } finally {
      deactivate();
    }
  });
});
