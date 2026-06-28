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
import { FILM_STOCKS, type FilmStockData, type FilmFx } from "./stocks_data.generated";

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

// Sentinel stock id meaning "off": the film stage becomes a passthrough, the
// effects go inert, and the spectral textures are dropped, so the extension
// costs nothing when you're not using it. See applyStock + the panel's picker.
const NONE_ID = "none";

// Reference long edge (px) the halation blur radius is anchored to, so the glow
// covers a CONSTANT fraction of the image at any render resolution. Matches the
// default developMaxEdge, so the Develop preview of a full-size photo is
// unchanged; thumbnails (≤960 px) and reduced exports now match it instead of
// blooming ~6× wider. See buildHalationStage.
const HAL_REF_EDGE = 4096;

// Grain cells across the frame HEIGHT at size 1.0 — the anchor that makes grain a
// constant physical size at any output resolution (see buildGrainStage). Chosen
// to look film-like at the default size; the Size slider tunes from there.
const GRAIN_REF = 2700;

// Effect character used when no stock data is bundled, so the halation/grain
// stages still compile (the panel shows the getting-started view in that case).
// Mirrors a typical negative: red-dominant halo, slightly coarser blue grain.
const DEFAULT_FX: FilmFx = {
  halTint: [1, 0.33, 0], halStrength: 0.015, halSizeFrac: 0.0019, halBounceDecay: 0.5,
  grainScale: [1, 1, 1.5], grainAreaUm2: 0.2, grainBlur: 0.65, glare: 0.03,
};

// Format a JS number triple as a GLSL vec3 literal (baked per-stock constants).
const vec3lit = (v: readonly [number, number, number]) =>
  `vec3(${v.map((x) => x.toFixed(4)).join(", ")})`;

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
// and reflects back, blooming a glow around highlights whose HUE is the stock's
// own anti-halation balance (Portra ≈ (1,0.33,0); other stocks differ — extracted
// per stock into fx.halTint). Two separable Gaussian prepasses blur the source
// highlights (scatter follows scene light, so the source is the right driver);
// the inline effects pass adds the tinted glow to display colour `c`. Default
// amount 0 → off until dialled in.
//
// The blur radius is anchored to HAL_REF_EDGE so the halo spans a constant
// FRACTION of the image regardless of the prepass resolution. uTexel = 1/dim,
// so the radius is a fixed texel count only at the reference size; at other
// sizes it scales by (long edge / reference). Without this, the same texel-count
// blur spread ~6× wider on a 640 px grid thumbnail than on the 4096 px Develop
// preview, pushing the glow far further into the surrounds — which read as a
// different colour between Develop and thumbnails/exports.
function buildHalationStage(fx: FilmFx): ProcessingStageContribution {
  const blur = (axis: "x" | "y", extract: boolean) => `
    float halLong = max(1.0 / uTexel.x, 1.0 / uTexel.y);
    float r = max(sfHalSize, 0.0) * (halLong / ${HAL_REF_EDGE}.0);
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
    // before adding the stock-tinted glow to `c`. Tint is baked per stock.
    glsl: `c += sfHalAmount * ${vec3lit(fx.halTint)} * pow(max(stageResult, 0.0), vec3(0.4545));`,
  };
}

// ─── Grain (post-effect) ───────────────────────────────────────────────────
// Film grain as a particle-statistics approximation: amplitude ∝ sqrt(p(1-p)) so
// it peaks in MIDTONES (matches the engine's binomial model). Per-channel,
// DECORRELATED value noise (independent grain per channel, not a tinted luma
// grain) at per-channel coarseness from the stock's particle scale (fx.grainScale
// — blue is physically coarser). Grain cells are placed in frame-relative,
// aspect-corrected coordinates (srcUv × uImageAspect) anchored to GRAIN_REF, so
// the grain is a CONSTANT size at any output resolution — Develop, thumbnail and
// export match (gl_FragCoord, the old coordinate, scaled with the render size and
// made grain coarser on small thumbnails). Default amount 0 → off until dialled in.
function buildGrainStage(fx: FilmFx): ProcessingStageContribution {
  // Normalise per-channel scale to mean 1 so it only sets RELATIVE coarseness
  // (overall size stays on the Size slider); larger scale → coarser → fewer cells.
  const gm = (fx.grainScale[0] + fx.grainScale[1] + fx.grainScale[2]) / 3 || 1;
  const gs = fx.grainScale.map((x) => (x / gm).toFixed(4));
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
      float sfHash1(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float sfValNoise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sfHash1(i), sfHash1(i + vec2(1.0, 0.0)), f.x),
                   mix(sfHash1(i + vec2(0.0, 1.0)), sfHash1(i + vec2(1.0, 1.0)), f.x), f.y);
      }`,
    glsl: `
      // Frame-relative, square-celled, resolution-independent grain coordinate.
      vec2 gbase = vec2(srcUv.x * uImageAspect, srcUv.y) * (${GRAIN_REF}.0 / max(sfGrainSize, 0.5));
      // Per-channel coarseness (÷scale) + a per-channel offset so the three
      // channels are independent (coloured grain), not one luminance grain tinted.
      vec3 gn = vec3(
        sfValNoise(gbase / ${gs[0]}),
        sfValNoise(gbase / ${gs[1]} + vec2(37.0, 11.0)),
        sfValNoise(gbase / ${gs[2]} + vec2(91.0, 53.0))
      ) - 0.5;
      float glum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float genv = 2.0 * sqrt(max(glum * (1.0 - glum), 0.0));
      c += sfGrainAmount * genv * gn;`,
  };
}

let theApi: SafelightAPI | null = null;
let texVersion = 1;
let setPanelStock: ((id: string) => void) | null = null;

function applyStock(api: SafelightAPI, id: string): void {
  if (id === NONE_ID) {
    // Off: re-register all three stages as no-ops (empty glsl leaves scene-linear
    // `lin` untouched, regardless of any slider values) and drop the spectral
    // textures so nothing stays resident. The extension is fully inert until a
    // stock is chosen again.
    api.registerProcessingStage({ id: STAGE_ID, name: "Spektrafilm", phase: "tone-map", uniforms: [], glsl: "" });
    api.registerProcessingStage({ id: HAL_ID, name: "Halation", phase: "effects", priority: 50, uniforms: [], glsl: "" });
    api.registerProcessingStage({ id: GRAIN_ID, name: "Grain", phase: "effects", priority: 60, uniforms: [], glsl: "" });
    api.setStageTexture(STAGE_ID, "filmTc", null);
    api.setStageTexture(STAGE_ID, "filmCurves", null);
    api.setStageTexture(STAGE_ID, "filmSpec", null);
    return;
  }
  const stock = FILM_STOCKS.find((s) => s.id === id) ?? FILM_STOCKS[0];
  api.registerProcessingStage(buildStage(stock));
  // Re-register the effect stages so halation tint / grain balance follow the
  // selected stock (cheap recompile, same as swapping the film stage).
  api.registerProcessingStage(buildHalationStage(stock.fx));
  api.registerProcessingStage(buildGrainStage(stock.fx));
  const v = ++texVersion;
  api.setStageTexture(STAGE_ID, "filmTc", { data: stock.filmTc(), width: stock.tcSize, height: stock.tcSize, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmCurves", { data: stock.filmCurves(), width: 256, height: 3, format: "rgba16f", version: v });
  api.setStageTexture(STAGE_ID, "filmSpec", { data: stock.filmSpec(), width: 81, height: 4, format: "rgba16f", version: v });
}

// ─── Panel control layout ───────────────────────────────────────────────────
// One source of truth for the panel's sliders, their defaults, AND the reset
// maps — grouped into the collapsible sections the panel renders, so a control,
// its default and its section can never drift apart.
interface Ctrl { stage: string; key: string; label: string; min: number; max: number; dflt: number; step: number; }
interface PanelSection { id: string; title: string; hint: string; ctrls: Ctrl[]; }
const SECTIONS: PanelSection[] = [
  { id: "film", title: "Film", hint: "Negative exposure, enlarger print, development and live colour-head filtration.", ctrls: [
    { stage: STAGE_ID, key: "sfExposure", label: "Exposure", min: -3, max: 3, dflt: 0, step: 0.01 },
    { stage: STAGE_ID, key: "sfPrintExp", label: "Print Exposure", min: 0.2, max: 3, dflt: 1, step: 0.01 },
    { stage: STAGE_ID, key: "sfCouplerAmt", label: "Coupler Amount", min: 0, max: 2, dflt: 1, step: 0.01 },
    { stage: STAGE_ID, key: "sfContrast", label: "Print Contrast", min: 0.5, max: 2, dflt: 1, step: 0.01 },
    { stage: STAGE_ID, key: "sfFiltM", label: "Filtration M", min: -100, max: 100, dflt: 0, step: 1 },
    { stage: STAGE_ID, key: "sfFiltY", label: "Filtration Y", min: -100, max: 100, dflt: 0, step: 1 },
  ] },
  { id: "halation", title: "Halation", hint: "Back-reflection highlight glow, tinted to the selected stock. Off at 0.", ctrls: [
    { stage: HAL_ID, key: "sfHalAmount", label: "Amount", min: 0, max: 1, dflt: 0, step: 0.01 },
    { stage: HAL_ID, key: "sfHalSize", label: "Size", min: 0, max: 8, dflt: 3, step: 0.1 },
    { stage: HAL_ID, key: "sfHalThreshold", label: "Threshold", min: 0, max: 1, dflt: 0.6, step: 0.01 },
  ] },
  { id: "grain", title: "Grain", hint: "Midtone-peaked, per-channel film grain at the stock's coarseness. Off at 0.", ctrls: [
    { stage: GRAIN_ID, key: "sfGrainAmount", label: "Amount", min: 0, max: 1, dflt: 0, step: 0.01 },
    { stage: GRAIN_ID, key: "sfGrainSize", label: "Size", min: 0.5, max: 5, dflt: 1.5, step: 0.1 },
  ] },
];
// Flat { "stage.key": default } map for a full reset.
const ALL_DEFAULTS: Record<string, number> = Object.fromEntries(
  SECTIONS.flatMap((s) => s.ctrls.map((c) => [`${c.stage}.${c.key}`, c.dflt])),
);

function resetPanel(api: SafelightAPI): void {
  api.stores.useDevelopStore.getState().setDynParams({ ...ALL_DEFAULTS });
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
  // built); the panel shows a getting-started view instead.
  if (FILM_STOCKS.length > 0) {
    // applyStock registers the film stage AND the per-stock effect stages.
    applyStock(api, api.settings.get("stock", FILM_STOCKS[0].id));
  } else {
    // Still register the effects (fallback character) so they compile and the
    // panel's getting-started view shows. Both default to amount 0 → inert.
    api.registerProcessingStage(buildHalationStage(DEFAULT_FX));
    api.registerProcessingStage(buildGrainStage(DEFAULT_FX));
  }

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
    // Section open/closed state (Film open; effects collapsed since they're off by
    // default). One object so the number of hooks stays constant — no per-section
    // useState in a loop.
    const [open, setOpen] = React.useState({ film: true, halation: false, grain: false });

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

    const h = React.createElement;
    // Persist on gesture end (mirrors core panels): setDynParam only mutates the
    // in-memory bag, so without committing the values reset on a library round-trip.
    const commit = () => { void useDevelopStore.getState().commitEdit("Spektrafilm"); };
    const valOf = (c: Ctrl): number => {
      const v = paramBag[`${c.stage}.${c.key}`];
      return typeof v === "number" ? v : c.dflt;
    };
    const renderCtrl = (c: Ctrl) =>
      h(Slider, {
        key: c.key, label: c.label, value: valOf(c), min: c.min, max: c.max, step: c.step,
        defaultValue: c.dflt,
        onChange: (v: number) => setDynParam(`${c.stage}.${c.key}`, v),
        onCommit: commit,
      });
    // Has any control in the section moved off its default? Drives the per-section
    // Reset affordance (shown only when there's something to reset).
    const sectionDirty = (sec: PanelSection) =>
      sec.ctrls.some((c) => valOf(c) !== c.dflt);
    const resetSection = (sec: PanelSection) => {
      useDevelopStore.getState().setDynParams(
        Object.fromEntries(sec.ctrls.map((c) => [`${c.stage}.${c.key}`, c.dflt])),
      );
      commit();
    };

    const renderSection = (sec: PanelSection) => {
      const isOpen = open[sec.id];
      const header = h("div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginTop: 4 },
          title: sec.hint, onClick: () => setOpen({ ...open, [sec.id]: !isOpen }) },
        h("span", { className: "text-[11px] text-text-primary", style: { fontWeight: 600 } },
          `${isOpen ? "▾" : "▸"} ${sec.title}`),
        sectionDirty(sec)
          ? h("button",
              { className: "rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3",
                style: { border: "none", cursor: "pointer" },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick: (e: any) => { e.stopPropagation(); resetSection(sec); } },
              "Reset")
          : null);
      return h("div", { key: sec.id, className: "flex flex-col gap-1.5" },
        header,
        isOpen ? sec.ctrls.map(renderCtrl) : null);
    };

    // Group the picker by film family and surface the selected stock's blurb.
    const KIND_LABEL: Record<string, string> = {
      negative: "Colour negative", cine: "Cinema", slide: "Slide / reversal",
    };
    const kinds = FILM_STOCKS.map((s) => s.kind).filter((k, i, a) => a.indexOf(k) === i);
    const stockOptions = kinds.map((k) =>
      h("optgroup", { key: k, label: KIND_LABEL[k] ?? k },
        FILM_STOCKS.filter((s) => s.kind === k).map((s) =>
          h("option", { key: s.id, value: s.id }, s.name))));
    const activeStock = FILM_STOCKS.find((s) => s.id === stock) ?? FILM_STOCKS[0];
    const isNone = stock === NONE_ID;

    return h(
      "div",
      { className: "flex flex-col gap-1.5 p-2" },
      h("label", { className: "text-[11px] text-text-secondary" }, "Film stock"),
      h(
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
        // "None" turns the whole extension off; real stocks follow, grouped by family.
        h("option", { key: NONE_ID, value: NONE_ID }, "None (off)"),
        ...stockOptions,
      ),
      isNone
        ? h("p",
            { className: "text-[11px] text-text-secondary", style: { lineHeight: 1.35, margin: "4px 0" } },
            "Spektrafilm is off. Choose a film stock to enable it, and switch your rendering transform back from “Spektrafilm”.")
        : h("p",
            { className: "text-[11px] text-text-secondary", style: { lineHeight: 1.35, margin: "2px 0 4px" } },
            activeStock.description),
      isNone ? null : SECTIONS.map(renderSection),
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
