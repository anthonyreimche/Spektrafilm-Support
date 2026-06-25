// Spektrafilm Support — SafeLight extension (GPL-3.0-or-later)
//
// Runs the Spektrafilm spectral film simulation LIVE per pixel on the GPU — not
// a frozen LUT. The 5-stage pipeline (expose → develop → print-expose → print-
// develop → scan) is transliterated to GLSL in film-glsl.ts (validated stage-by-
// stage against the engine), driven by per-stock spectral data (3 rgba16f
// textures + a GLSL const block) extracted by tools/extract_stock.py. Exposure
// and print exposure are live uniforms.
//
// Pair with the "Spektrafilm" display transform (registered below): the film IS
// the tone rendering, so the view transform is a plain encode with the base
// curve off.

import { FILM_HELPERS, FILM_GLSL } from "./film-glsl";
import { FILM_STOCKS, type FilmStockData } from "./stocks_data.generated";

// ─── Minimal SafeLight API surface ───────────────────────────────────────────

type GlslType = "float" | "vec2" | "vec3" | "vec4" | "sampler2D";

interface UniformDeclaration {
  key: string;
  glslType: GlslType;
  default: number;
  range?: { min: number; max: number; step?: number };
  label?: string;
}

interface TextureRequirement {
  key: string;
  kind: "lut" | "coverage" | "dynamic";
  width?: number;
  height?: number;
  format?: "rgba8" | "r8" | "rgba16f" | "r16f";
}

interface StagePass {
  glsl: string;
  helpers?: string;
  iterations?: number;
  uniforms?: UniformDeclaration[];
}

interface ProcessingStageContribution {
  id: string;
  name: string;
  phase: "tone-map" | "scene-linear" | "effects" | string;
  priority?: number;
  glsl: string;
  helpers?: string;
  uniforms: UniformDeclaration[];
  passes?: StagePass[];
  textures?: TextureRequirement[];
}

interface StageTextureData {
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
  format: "rgba8" | "r8" | "rgba16f" | "r16f";
  version: number;
}

interface PipelineContribution {
  id: string;
  name: string;
  description?: string;
  glsl?: string;
  skipBaseCurve?: boolean;
}

interface SafelightAPI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  react: any;
  registerProcessingStage(c: ProcessingStageContribution): void;
  setStageTexture(stageId: string, key: string, tex: StageTextureData | null): void;
  registerPipeline(c: PipelineContribution): void;
  registerPanel(c: {
    id: string;
    title: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component: any;
    defaultDock?: { module: "library" | "develop"; direction: "left" | "right"; order?: number; width?: number };
    onReset?: () => void;
  }): void;
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stores: Record<string, any>;
}

// ─── Stage ───────────────────────────────────────────────────────────────────

const STAGE_ID = "spektrafilm-support.film";
const HAL_ID = "spektrafilm-support.halation";
const GRAIN_ID = "spektrafilm-support.grain";

function buildStage(stock: FilmStockData): ProcessingStageContribution {
  return {
    id: STAGE_ID,
    name: "Spektrafilm",
    phase: "tone-map",
    uniforms: [
      { key: "sfExposure", glslType: "float", default: 0, range: { min: -3, max: 3, step: 0.01 }, label: "Exposure" },
      { key: "sfPrintExp", glslType: "float", default: 1, range: { min: 0.2, max: 3, step: 0.01 }, label: "Print Exposure" },
      { key: "sfCouplerAmt", glslType: "float", default: 1, range: { min: 0, max: 2, step: 0.01 }, label: "Coupler Amount" },
      { key: "sfContrast", glslType: "float", default: 1, range: { min: 0.5, max: 2, step: 0.01 }, label: "Print Contrast" },
      { key: "sfFiltM", glslType: "float", default: 0, range: { min: -100, max: 100, step: 1 }, label: "Filtration M" },
      { key: "sfFiltY", glslType: "float", default: 0, range: { min: -100, max: 100, step: 1 }, label: "Filtration Y" },
    ],
    textures: [
      { key: "filmTc", kind: "lut", format: "rgba16f" },
      { key: "filmCurves", kind: "lut", format: "rgba16f" },
      { key: "filmSpec", kind: "lut", format: "rgba16f" },
    ],
    // Per-stock spectral constants are inlined as GLSL consts; changing stock
    // re-registers (recompiles) — cheap and rare. Live params stay uniforms.
    helpers: FILM_HELPERS + "\n" + stock.consts,
    glsl: FILM_GLSL,
  };
}

// ─── Halation (post-effect) ────────────────────────────────────────────────
// Back-reflection halation: bright scene light scatters through the film base
// and reflects back, blooming a RED-dominant glow around highlights (engine
// strength ratio ~0.05:0.015:0 ≈ 1:0.3:0). Two separable Gaussian prepasses
// blur the source highlights (scatter follows scene light, so the source is the
// right driver); the inline effects pass adds the red-tinted glow to display
// colour `c`. Default amount 0 → off until dialled in.
function buildHalationStage(): ProcessingStageContribution {
  const blur = (axis: "x" | "y", extract: boolean) => `
    float r = max(sfHalSize, 0.0);
    vec3 sum = vec3(0.0); float wsum = 0.0;
    for (int k = -8; k <= 8; k++) {
      float fk = float(k);
      float w = exp(-fk * fk / 32.0);
      vec3 s = readPrev(vUv + vec2(${axis === "x" ? "fk * r * uTexel.x, 0.0" : "0.0, fk * r * uTexel.y"}));
      sum += ${extract ? "max(s - sfHalThreshold, 0.0)" : "s"} * w;
      wsum += w;
    }
    c = sum / wsum;`;
  return {
    id: HAL_ID,
    name: "Halation",
    phase: "effects",
    priority: 50,
    uniforms: [
      { key: "sfHalAmount", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Halation" },
    ],
    passes: [
      { glsl: blur("x", true), uniforms: [
        { key: "sfHalSize", glslType: "float", default: 3, range: { min: 0, max: 8, step: 0.1 } },
        { key: "sfHalThreshold", glslType: "float", default: 0.6, range: { min: 0, max: 1, step: 0.01 } },
      ] },
      { glsl: blur("y", false), uniforms: [
        { key: "sfHalSize", glslType: "float", default: 3, range: { min: 0, max: 8, step: 0.1 } },
      ] },
    ],
    // stageResult = blurred highlights (scene-linear); approx-encode to display
    // before adding the red-dominant glow to `c`.
    glsl: "c += sfHalAmount * vec3(1.0, 0.3, 0.0) * pow(max(stageResult, 0.0), vec3(0.4545));",
  };
}

// ─── Grain (post-effect) ───────────────────────────────────────────────────
// Film grain as a particle-statistics approximation: amplitude ∝ sqrt(p(1-p))
// so it peaks in MIDTONES (matches the engine's binomial model), value noise
// sized by sfGrainSize, per-channel (blue grain coarser/stronger). Inline only
// (per-pixel, no neighbourhood). Default amount 0 → off until dialled in.
function buildGrainStage(): ProcessingStageContribution {
  return {
    id: GRAIN_ID,
    name: "Grain",
    phase: "effects",
    priority: 60,
    uniforms: [
      { key: "sfGrainAmount", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Grain" },
      { key: "sfGrainSize", glslType: "float", default: 1.5, range: { min: 0.5, max: 5, step: 0.1 }, label: "Grain Size" },
    ],
    helpers: `
      vec3 sfHash3(vec2 p) {
        vec3 q = vec3(dot(p, vec2(127.1, 311.7)),
                      dot(p, vec2(269.5, 183.3)),
                      dot(p, vec2(419.2, 371.9)));
        return fract(sin(q) * 43758.5453);
      }`,
    glsl: `
      vec2 gp = gl_FragCoord.xy / max(sfGrainSize, 0.5);
      vec2 gi = floor(gp); vec2 gf = fract(gp);
      gf = gf * gf * (3.0 - 2.0 * gf);
      vec3 gn = mix(mix(sfHash3(gi), sfHash3(gi + vec2(1.0, 0.0)), gf.x),
                    mix(sfHash3(gi + vec2(0.0, 1.0)), sfHash3(gi + vec2(1.0, 1.0)), gf.x),
                    gf.y) - 0.5;
      float glum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float genv = 2.0 * sqrt(max(glum * (1.0 - glum), 0.0));
      c += sfGrainAmount * genv * gn * vec3(1.0, 0.9, 1.3);`,
  };
}

let theApi: SafelightAPI | null = null;
let texVersion = 1;
let setPanelStock: ((id: string) => void) | null = null;

function applyStock(api: SafelightAPI, id: string): void {
  const stock = FILM_STOCKS.find((s) => s.id === id) ?? FILM_STOCKS[0];
  api.registerProcessingStage(buildStage(stock));
  const v = ++texVersion;
  api.setStageTexture(STAGE_ID, "filmTc", { data: stock.filmTc(), width: stock.tcSize, height: stock.tcSize, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmCurves", { data: stock.filmCurves(), width: 256, height: 3, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmSpec", { data: stock.filmSpec(), width: 81, height: 4, format: "rgba16f", version: v });
}

function resetPanel(api: SafelightAPI): void {
  api.stores.useDevelopStore.getState().setDynParams({
    [`${STAGE_ID}.sfExposure`]: 0,
    [`${STAGE_ID}.sfPrintExp`]: 1,
    [`${STAGE_ID}.sfCouplerAmt`]: 1,
    [`${STAGE_ID}.sfContrast`]: 1,
    [`${STAGE_ID}.sfFiltM`]: 0,
    [`${STAGE_ID}.sfFiltY`]: 0,
    [`${HAL_ID}.sfHalAmount`]: 0,
    [`${HAL_ID}.sfHalSize`]: 3,
    [`${HAL_ID}.sfHalThreshold`]: 0.6,
    [`${GRAIN_ID}.sfGrainAmount`]: 0,
    [`${GRAIN_ID}.sfGrainSize`]: 1.5,
  });
  const def = FILM_STOCKS[0].id;
  api.settings.set("stock", def);
  applyStock(api, def);
  setPanelStock?.(def);
  // Persist the reset so it survives a library round-trip / reload.
  void api.stores.useDevelopStore.getState().commitEdit("Spektrafilm Reset");
}

const ENGINE_URL = "https://github.com/andreavolpato/spektrafilm";
const GUIDE_URL =
  "https://github.com/anthonyreimche/Spektrafilm-Support-for-Safelight#adding-your-own-stocks";
const REGEN_CMD = "python tools/extract_stock.py --emit\nnpm run build";

// Shown in place of the controls when no film-stock data is bundled. The looks
// are generated offline from Andrea Volpato's spectral engine (GPLv3) and baked
// into the extension; this guides the user through producing them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function GettingStarted({ React }: { React: any }) {
  const [copied, setCopied] = React.useState(false);
  const h = React.createElement;
  // Reuse only class tokens already present in this panel (so they're in the
  // scanned bundle); everything else is inline styles per the runtime-extension
  // styling constraint.
  const actionStyle = {
    display: "block", width: "100%", textAlign: "left" as const, textDecoration: "none",
    cursor: "pointer", border: "none", marginTop: 2,
  };
  const link = (href: string, label: string) =>
    h("a", { href, target: "_blank", rel: "noreferrer",
      className: "rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary hover:bg-surface-3",
      style: actionStyle }, label);
  const step = (n: number, text: string) =>
    h("div", { style: { display: "flex", gap: 6 } },
      h("span", { className: "text-text-secondary" }, `${n}.`),
      h("span", { className: "text-text-primary" }, text));
  return h(
    "div",
    { className: "flex flex-col gap-1.5 p-2 text-[11px] text-text-secondary" },
    h("div", { className: "text-text-primary", style: { fontWeight: 600 } }, "Spektrafilm not set up"),
    h("p", { style: { lineHeight: 1.4, margin: 0 } },
      "No film-stock data is bundled. Spektrafilm's looks are generated offline from the spectral engine, then baked into the extension. To get started:"),
    step(1, "Install the Spektrafilm engine (pip-installable, Python 3.13)."),
    step(2, "Run the extractor to generate the film stocks."),
    step(3, "Rebuild the extension and reload it."),
    h("button",
      {
        className: "rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary hover:bg-surface-3",
        style: actionStyle,
        onClick: () => {
          void navigator.clipboard?.writeText(REGEN_CMD);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
      },
      copied ? "Copied ✓" : "Copy generate command"),
    link(ENGINE_URL, "Spektrafilm engine (GitHub) ↗"),
    link(GUIDE_URL, "Setup guide ↗"),
  );
}

export function activate(api: SafelightAPI): void {
  theApi = api;
  const React = api.react;

  // No bundled film-stock data → don't register the film stage (it can't be
  // built); the panel shows a getting-started view instead. Post-effects still
  // register but stay inert at their 0 defaults.
  if (FILM_STOCKS.length > 0) {
    applyStock(api, api.settings.get("stock", FILM_STOCKS[0].id));
  }

  // Post-effects (stock-independent): registered once. Both default to amount 0,
  // so they're inert until the user dials them in.
  api.registerProcessingStage(buildHalationStage());
  api.registerProcessingStage(buildGrainStage());

  api.registerPipeline({
    id: "spektrafilm-support.transform",
    name: "Spektrafilm",
    description:
      "Plain sRGB encode with the RAW base curve off — the correct view transform for the Spektrafilm film stage (the film provides the tone rendering).",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return linearToSrgbU(lin); }",
    skipBaseCurve: true,
  });

  function SpektrafilmPanel() {
    const Slider = api.components.Slider;
    const useDevelopStore = api.stores.useDevelopStore;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paramBag: Record<string, unknown> = useDevelopStore((s: any) => s.paramBag);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setDynParam: (k: string, v: number) => void = useDevelopStore((s: any) => s.setDynParam);
    const [stock, setStock] = React.useState(() => api.settings.get("stock", FILM_STOCKS[0]?.id ?? ""));

    React.useEffect(() => {
      setPanelStock = setStock;
      return () => { if (setPanelStock === setStock) setPanelStock = null; };
    }, []);

    // No bundled film-stock data → the film controls are useless; show a
    // getting-started view instead (the looks are generated offline from the
    // Spektrafilm engine, then baked into the extension).
    if (FILM_STOCKS.length === 0) {
      return React.createElement(GettingStarted, { React });
    }

    const valOf = (stageId: string, k: string, d: number): number => {
      const v = paramBag[`${stageId}.${k}`];
      return typeof v === "number" ? v : d;
    };
    const sliderFor = (stageId: string) =>
      (key: string, label: string, min: number, max: number, dflt: number, step = 0.01) =>
        React.createElement(Slider, {
          label, value: valOf(stageId, key, dflt), min, max, step, defaultValue: dflt,
          onChange: (v: number) => setDynParam(`${stageId}.${key}`, v),
          // Persist on gesture end (mirrors core panels): setDynParam only mutates
          // the in-memory bag, so without committing the values reset on a
          // library round-trip / reload.
          onCommit: () => { void useDevelopStore.getState().commitEdit("Spektrafilm"); },
        });
    const slider = sliderFor(STAGE_ID);
    const halSlider = sliderFor(HAL_ID);
    const grainSlider = sliderFor(GRAIN_ID);
    const heading = (text: string) =>
      React.createElement("label", { className: "mt-1 text-[11px] text-text-secondary" }, text);

    return React.createElement(
      "div",
      { className: "flex flex-col gap-1.5 p-2" },
      React.createElement("label", { className: "text-[11px] text-text-secondary" }, "Film stock"),
      React.createElement(
        "select",
        {
          value: stock,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (e: any) => {
            const id = e.target.value as string;
            setStock(id);
            api.settings.set("stock", id);
            applyStock(api, id);
          },
          className: "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3",
        },
        FILM_STOCKS.map((s) => React.createElement("option", { key: s.id, value: s.id }, s.name)),
      ),
      slider("sfExposure", "Exposure", -3, 3, 0),
      slider("sfPrintExp", "Print Exposure", 0.2, 3, 1),
      slider("sfCouplerAmt", "Coupler Amount", 0, 2, 1),
      slider("sfContrast", "Print Contrast", 0.5, 2, 1),
      slider("sfFiltM", "Filtration M", -100, 100, 0, 1),
      slider("sfFiltY", "Filtration Y", -100, 100, 0, 1),
      heading("Halation"),
      halSlider("sfHalAmount", "Amount", 0, 1, 0),
      halSlider("sfHalSize", "Size", 0, 8, 3, 0.1),
      halSlider("sfHalThreshold", "Threshold", 0, 1, 0.6),
      heading("Grain"),
      grainSlider("sfGrainAmount", "Amount", 0, 1, 0),
      grainSlider("sfGrainSize", "Size", 0.5, 5, 1.5, 0.1),
    );
  }

  api.registerPanel({
    id: "spektrafilm-support.panel",
    title: "Spektrafilm",
    component: SpektrafilmPanel,
    defaultDock: { module: "develop", direction: "right", order: 6, width: 260 },
    onReset: () => resetPanel(api),
  });
}

export function deactivate(): void {
  theApi?.setStageTexture(STAGE_ID, "filmTc", null);
  theApi?.setStageTexture(STAGE_ID, "filmCurves", null);
  theApi?.setStageTexture(STAGE_ID, "filmSpec", null);
  theApi = null;
}
