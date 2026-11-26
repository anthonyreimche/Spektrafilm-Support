// Spektrafilm Support — SafeLight extension (GPL-3.0-or-later)
//
// Runs the Spektrafilm spectral film simulation LIVE per pixel on the GPU — not
// a frozen LUT. The 5-stage pipeline (expose → develop → print-expose → print-
// develop → scan) is transliterated to GLSL in film-glsl.ts (validated stage-by-
// stage against the engine), driven by per-stock spectral data (3 rgba16f
// textures + a GLSL const block) extracted by tools/extract_stock.py. Exposure
// and print exposure are live uniforms.
//
// The stock is the photo's own: a uniform in its bag picks it out of textures
// and constants that hold every bundled stock, so the Develop view, edited
// thumbnails and exports each develop a photo with its own stock.
//
// Pair with the "Spektrafilm" display transform (registered below): the film IS
// the tone rendering, so the view transform is a plain encode with the base
// curve off.

import { FILM_HELPERS, N_WL, filmGlsl } from "./film-glsl";
import { FILM_STOCKS, type FilmStockData, type FilmFx } from "./stocks_data.generated";

// ─── Minimal SafeLight API surface ───────────────────────────────────────────

type GlslType = "float" | "int" | "vec2" | "vec3" | "vec4" | "sampler2D";

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

interface InterStageVariable {
  name: string;
  glslType: "float" | "vec2" | "vec3" | "vec4";
  producer?: string;
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
  // Values handed on in the same draw as isv_<name> (Safelight 3.0.1); without
  // a producer the stage assigns them in its glsl.
  produces?: InterStageVariable[];
  // The isv_<name> values the stage reads from earlier stages.
  consumes?: string[];
  // Runs the stage again inside each mask whose bag holds its keys, with that
  // mask's values, blended by its coverage (Safelight 3.1.0, process version 2
  // photos).
  mask?: { maskable: true };
  // Omitted, a display-phase stage is handed `c` clipped to [0, 1] on process
  // version 2, the clip written ahead of its block and outside its own gate.
  // Hosts before process versions ignore it.
  space?: { encoding: "linear" | "perceptual"; primaries?: "rec709" | "rec2020" };
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
  skipToneShoulder?: boolean;
}

// The params a panel edits: the photo's bag, or one mask's (maskId set).
// Reads see the store as it is now, not as the render was handed it.
interface ParamScope {
  maskId: string | null;
  getParam(key: string): unknown;
  getParams(): Readonly<Record<string, unknown>>;
  setParams(patch: Record<string, unknown>): void;
  commit(label: string): void;
}

// React as the host hands it over (api.react). The bundle never imports React,
// so only the calls the panel makes are typed.
type ReactNode = unknown;
type Component<P> = (props: P) => ReactNode;
interface ReactApi {
  createElement<P>(type: string | Component<P>, props?: P | null, ...children: ReactNode[]): ReactNode;
  useState<T>(initial: T): [T, (next: T) => void];
}

interface SliderProps {
  key?: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
}

interface SelectGroup { title?: string; items: { value: string; label: string }[]; }

// The host's themed controls (api.ui): they carry the app's own classes, which
// a runtime-loaded bundle can't, since the app's Tailwind build never scans it.
interface UiKit {
  Button: Component<{ variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; full?: boolean; title?: string; onClick?: () => void }>;
  Select: Component<{ value: string; onChange: (value: string) => void; groups: SelectGroup[]; ariaLabel?: string }>;
  Field: Component<{ label?: ReactNode; hint?: ReactNode }>;
  Section: Component<{ key?: string; title: ReactNode; right?: ReactNode }>;
  Stack: Component<{ gap?: number; style?: Record<string, string | number> }>;
  Row: Component<{ gap?: number; align?: string; style?: Record<string, string | number> }>;
  tokens: Record<"textPrimary" | "textSecondary" | "surface2", string>;
}

interface DevelopState {
  paramBag: Record<string, unknown>;
  setDynParam(key: string, value: unknown): void;
  setDynParams(patch: Record<string, unknown>): void;
  commitEdit(label: string): Promise<void> | void;
}
interface DevelopStore {
  <T>(selector: (state: DevelopState) => T): T;
  getState(): DevelopState;
  subscribe(listener: (state: DevelopState) => void): () => void;
}

interface SafelightAPI {
  react: ReactApi;
  registerProcessingStage(c: ProcessingStageContribution): void;
  unregisterProcessingStage(id: string): void;
  setStageTexture(stageId: string, key: string, tex: StageTextureData | null): void;
  registerPipeline(c: PipelineContribution): void;
  registerPanel(c: {
    id: string;
    title: string;
    component: Component<Record<string, never>>;
    defaultDock?: { module: "library" | "develop"; direction: "left" | "right"; order?: number; width?: number };
    /** The modules the panel may be docked in; omitted, every module (Safelight 3.2.8). */
    modules?: readonly string[];
    onReset?: () => void;
    // Offers the panel in a mask's Adjust tab, editing that mask's values
    // through useParamScope; `owns` lists every qualified key it writes.
    mask?: { component: Component<Record<string, never>>; order?: number; owns: readonly string[] };
  }): void;
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  };
  components: { Slider: Component<SliderProps> };
  ui: UiKit;
  stores: { useDevelopStore: DevelopStore };
  develop: {
    // The mask's scope inside a mask's Adjust tab, the photo's anywhere else.
    useParamScope(): ParamScope;
  };
}

// ─── Stage ───────────────────────────────────────────────────────────────────

const STAGE_ID = "spektrafilm-support.film";
const HAL_ID = "spektrafilm-support.halation";
const GRAIN_ID = "spektrafilm-support.grain";

// Sentinel stock id meaning "off" (index -1 in the bag): the film stage passes
// lin through and the effects go inert. See the panel's picker.
const NONE_ID = "none";

// The photo's stock, as an index into FILM_STOCKS (-1 = none). It is a uniform
// so every renderer binds it from the photo's own bag. Photos edited before
// that keep their pick under the descriptor-less LEGACY_STOCK key, which a
// GLSL name can't carry (two underscores are reserved); the Develop store
// carries it into K_STOCK when such a photo opens.
const K_STOCK = STAGE_ID + ".sfStock";
const LEGACY_STOCK = STAGE_ID + ".__stock";

// The source long edge the halo's Size is tuned at: Develop's default render
// edge, so a full-size photo in Develop looks as it always has.
export const HAL_REF_EDGE = 4096;

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

/** A GLSL const array of one value per stock, indexed by stock. */
const constArray = (type: string, name: string, values: readonly string[]): string =>
  `const ${type} ${name}[${values.length}] = ${type}[${values.length}](${values.join(", ")});`;

interface StockConst { type: string; name: string; value: string; }

// The extractor's const block, one `const <type> <name> = <value>;` per line.
function stockConsts(stock: FilmStockData): StockConst[] {
  return [...stock.consts.matchAll(/const\s+(\w+)\s+(\w+)\s*=\s*([^;]+);/g)].map(([, type, name, value]) => ({
    type, name, value: value.trim(),
  }));
}

/** Every stock's constants as const arrays (`helpers`), and the declarations
 *  that pick the photo's stock's entries out of them by `sfK` (`select`). */
function stockConstArrays(stocks: readonly FilmStockData[]): { helpers: string; select: string } {
  const layout = stockConsts(stocks[0]);
  const perStock = stocks.map((s) => {
    const own = new Map(stockConsts(s).map((c) => [c.name, c]));
    return layout.map((c) => {
      const mine = own.get(c.name);
      if (!mine || mine.type !== c.type) throw new Error(`Spektrafilm: stock ${s.id} has no ${c.type} ${c.name}`);
      return mine.value;
    });
  });
  return {
    helpers: layout.map((c, i) => constArray(c.type, `${c.name}_all`, perStock.map((v) => v[i]))).join("\n"),
    select: layout.map((c) => `    ${c.type} ${c.name} = ${c.name}_all[sfK];`).join("\n"),
  };
}

export type StockAtlases = Record<"filmTc" | "filmCurves" | "filmSpec", Omit<StageTextureData, "version">>;

/** Every stock's three tables stacked top to bottom, stock 0 first: a stock's
 *  tile starts at row index × its table's height. */
export function buildAtlases(stocks: readonly FilmStockData[]): StockAtlases {
  const tc = stocks[0]?.tcSize ?? 0;
  const odd = stocks.find((s) => s.tcSize !== tc);
  if (odd) throw new Error(`Spektrafilm: stock ${odd.id}'s chromaticity table is ${odd.tcSize}², not ${tc}²`);
  const stack = (tables: Float32Array[]): Float32Array => {
    const out = new Float32Array(tables.reduce((n, t) => n + t.length, 0));
    let at = 0;
    for (const t of tables) {
      out.set(t, at);
      at += t.length;
    }
    return out;
  };
  const n = stocks.length;
  return {
    filmTc: { data: stack(stocks.map((s) => s.filmTc())), width: tc, height: tc * n, format: "rgba16f" },
    filmCurves: { data: stack(stocks.map((s) => s.filmCurves())), width: 256, height: 3 * n, format: "rgba16f" },
    filmSpec: { data: stack(stocks.map((s) => s.filmSpec())), width: N_WL, height: 4 * n, format: "rgba16f" },
  };
}

// One stage for every stock, so it never recompiles on a stock change and any
// renderer develops a photo with the stock its bag names. Slides (reversal)
// have no enlarger or print paper: their sfPositive branches the print stages
// out at runtime, but that branch is still compiled, so its print-only uniforms
// stay declared. The PANEL is what hides the print controls for slides (see
// FILM_CTRLS_POS).
export function buildStage(stocks: readonly FilmStockData[] = FILM_STOCKS): ProcessingStageContribution {
  const uniforms: UniformDeclaration[] = [
    { key: "sfStock", glslType: "int", default: -1, label: "Film stock" },
    { key: "sfExposure", glslType: "float", default: 0, range: { min: -3, max: 3, step: 0.01 }, label: "Exposure" },
    { key: "sfPrintExp", glslType: "float", default: 1, range: { min: 0.2, max: 3, step: 0.01 }, label: "Print Exposure" },
    { key: "sfCouplerAmt", glslType: "float", default: 1, range: { min: 0, max: 2, step: 0.01 }, label: "Coupler Amount" },
    { key: "sfContrast", glslType: "float", default: 1, range: { min: 0.5, max: 2, step: 0.01 }, label: "Contrast" },
    { key: "sfFiltM", glslType: "float", default: 0, range: { min: -100, max: 100, step: 1 }, label: "Filtration M" },
    { key: "sfFiltY", glslType: "float", default: 0, range: { min: -100, max: 100, step: 1 }, label: "Filtration Y" },
  ];
  const consts = stockConstArrays(stocks);
  return {
    id: STAGE_ID,
    name: "Spektrafilm",
    phase: "tone-map",
    uniforms,
    textures: [
      { key: "filmTc", kind: "lut", format: "rgba16f" },
      { key: "filmCurves", kind: "lut", format: "rgba16f" },
      { key: "filmSpec", kind: "lut", format: "rgba16f" },
    ],
    helpers: [
      FILM_HELPERS,
      `const int SF_STOCKS = ${stocks.length};`,
      `const float SF_TC_SIZE = ${stocks[0].tcSize}.0;`,
      consts.helpers,
    ].join("\n"),
    glsl: filmGlsl(consts.select),
    // The scene and settings a mask's copy develops again, and the stock, which
    // the copies and the effects read (see filmGlsl).
    produces: [
      { name: "spektrafilmScene", glslType: "vec4" },
      { name: "spektrafilmLive", glslType: "vec4" },
      { name: "spektrafilmFilt", glslType: "vec2" },
      { name: "spektrafilmStock", glslType: "float" },
    ],
    // A mask's copy shares this stage's spectral textures and the photo's
    // stock, so a mask changes the stock's settings, never the stock.
    mask: { maskable: true },
  };
}

// The effects' per-stock character comes from the stock the film stage hands
// on (isv_spektrafilmStock, stock + 1, 0 for none); with no stock they rest.
// Without bundled stocks there is no film stage, so they use DEFAULT_FX.
const STOCK_FROM_FILM = "int sfK = int(isv_spektrafilmStock + 0.5) - 1;";

// ─── Halation (post-effect) ────────────────────────────────────────────────
// Back-reflection halation: bright scene light scatters through the film base
// and reflects back, blooming a glow around highlights whose HUE is the stock's
// own anti-halation balance (Portra ≈ (1,0.33,0); other stocks differ — extracted
// per stock into fx.halTint).
//
// Implemented as a MIP-CHAIN bloom done entirely INLINE — deliberately NOT the
// host's multi-pass prepass framework, which was silently falling back to the raw
// source on some setups (capped prepass-stage budget) and washing the frame with
// tint. The source `uImage` already carries a mip chain the core itself samples
// for blur (textureLod(uImage, uv, lod)); sampling it at a Size-derived LOD gives
// a blurred copy of the source per pixel with zero extra passes, so Size/Threshold
// always respond and there's nothing to fall back. The chain is as long as the
// source is big (Develop's 4096 px, a thumbnail's 960, an export's full size), so
// Size is offset by the source's long edge against HAL_REF_EDGE: the halo spreads
// over the same share of the frame wherever the photo renders. Threshold isolates
// highlights; Amount screen-blends the tinted glow over the film output `c`
// (bright areas barely change, so the halo spreads into darker surroundings). The
// blend is worked out on `c` held to [0, 1] and added to `c` as it came, so values
// past either end keep their range. Default amount 0 → off until dialled in. The
// stage declares the display's own space, so the host adds no clip of its own.
// Photos on process version 1 keep the look they were edited with: the level is
// Size itself at any source size, and the blend replaces `c` held to [0, 1].
export function buildHalationStage(stocks: readonly FilmStockData[] = FILM_STOCKS): ProcessingStageContribution {
  const lumaW = "vec3(0.2126, 0.7152, 0.0722)";
  const perStock = stocks.length > 0;
  // B&W desaturates the blurred highlights so the halo is neutral grey; colour
  // stocks keep the source colour and tint it by the stock's halation balance.
  const helpers = perStock
    ? [
        constArray("vec3", "sfHalTintOf", stocks.map((s) => (s.kind === "bw" ? "vec3(1.0)" : vec3lit(s.fx.halTint)))),
        constArray("bool", "sfHalMonoOf", stocks.map((s) => String(s.kind === "bw"))),
      ].join("\n")
    : "";
  return {
    id: HAL_ID,
    name: "Halation",
    phase: "effects",
    priority: 50,
    space: { encoding: "perceptual" },
    ...(perStock ? { consumes: ["spektrafilmStock"] } : {}),
    uniforms: [
      { key: "sfHalAmount", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Halation" },
      // Size = blur LOD into the source mip chain (0 = sharp highlights, 8 = very
      // wide glow). Trilinear (fractional LOD) keeps the spread smooth.
      { key: "sfHalSize", glslType: "float", default: 4, range: { min: 0, max: 8, step: 0.1 }, label: "Size" },
      // Only source values above the threshold bloom; range past 1.0 so it can
      // gate bright (HDR) highlights on the RAW float path.
      { key: "sfHalThreshold", glslType: "float", default: 0.6, range: { min: 0, max: 2, step: 0.01 }, label: "Threshold" },
    ],
    helpers,
    glsl: `
      ${perStock ? STOCK_FROM_FILM : ""}
      if (sfHalAmount > 0.0${perStock ? " && sfK >= 0" : ""}) {
        vec3 sfTint = ${perStock ? "sfHalTintOf[sfK]" : vec3lit(DEFAULT_FX.halTint)};
#if SL_PROCESS_VERSION >= 2
        vec2 sfSrc = vec2(textureSize(uImage, 0));
        float sfLod = clamp(sfHalSize, 0.0, 8.0) + log2(max(sfSrc.x, sfSrc.y) / ${HAL_REF_EDGE}.0);
        vec3 sfBlur = textureLod(uImage, srcUv, max(sfLod, 0.0)).rgb;
#else
        vec3 sfBlur = textureLod(uImage, srcUv, clamp(sfHalSize, 0.0, 8.0)).rgb;
#endif
        ${perStock ? `if (sfHalMonoOf[sfK]) sfBlur = vec3(dot(max(sfBlur, 0.0), ${lumaW}));` : ""}
        vec3 sfHi = max(sfBlur - sfHalThreshold, 0.0);
        // Gain (×4): the mip blur box-averages, so a highlight's energy is diluted by
        // its surroundings — a unit of Amount needs a multiplier to read. ×4 puts the
        // useful range around a natural halo; the screen-blend keeps bright areas from
        // blowing out, so it glows into darker surroundings rather than washing.
        vec3 hgl = clamp(sfHalAmount * 4.0 * sfTint * sfHi, 0.0, 1.0);
        // Screen blend, 1 - (1 - c)(1 - hgl), as what it adds to c.
#if SL_PROCESS_VERSION >= 2
        vec3 sfHalBase = clamp(c, 0.0, 1.0);
        c += hgl * (1.0 - sfHalBase);
#else
        c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - hgl);
#endif
      }`,
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
// The stage declares the display's own space, so the host adds no clip of its
// own. The midtone envelope needs [0, 1], so it is read from `c` held there, and
// the grain is added to `c` as it came, keeping values past either end. On
// process version 1, `c` itself is held to [0, 1] first, as those edits were made.
export function buildGrainStage(stocks: readonly FilmStockData[] = FILM_STOCKS): ProcessingStageContribution {
  const perStock = stocks.length > 0;
  // Normalise per-channel scale to mean 1 so it only sets RELATIVE coarseness
  // (overall size stays on the Size slider); larger scale → coarser → fewer cells.
  const scaleOf = (fx: FilmFx): string => {
    const gm = (fx.grainScale[0] + fx.grainScale[1] + fx.grainScale[2]) / 3 || 1;
    return `vec3(${fx.grainScale.map((x) => (x / gm).toFixed(4)).join(", ")})`;
  };
  // Two octaves of value noise (fine + finer) read more like real silver grain
  // than a single octave, which looks blobby/cellular. B&W grain is monochrome
  // (ONE shared noise → luminance grain); colour stocks use decorrelated
  // per-channel noise (coloured grain) at per-channel coarseness.
  const perStockHelpers = perStock
    ? [
        constArray("vec3", "sfGrainScaleOf", stocks.map((s) => scaleOf(s.fx))),
        constArray("bool", "sfGrainMonoOf", stocks.map((s) => String(s.kind === "bw"))),
      ].join("\n")
    : "";
  return {
    id: GRAIN_ID,
    name: "Grain",
    phase: "effects",
    priority: 60,
    space: { encoding: "perceptual" },
    ...(perStock ? { consumes: ["spektrafilmStock"] } : {}),
    uniforms: [
      { key: "sfGrainAmount", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Grain" },
      { key: "sfGrainSize", glslType: "float", default: 1.5, range: { min: 0.5, max: 5, step: 0.1 }, label: "Grain Size" },
    ],
    // Integer PCG hash (Jarzynski & Olano 2020), not fract(sin(dot(p, k)) * big):
    // within a few hundred cells the float32 sin argument loses the fractional
    // bits that hash relies on, and the lattice runs to tens of thousands, so it
    // collapsed into a periodic cross-hatch on every GPU. Explicit highp because
    // fragment ints default to mediump (16-bit on some GPUs).
    helpers: `
      highp uint sfPcg(highp uint v) {
        highp uint s = v * 747796405u + 2891336453u;
        highp uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
        return (w >> 22u) ^ w;
      }
      float sfHash1(vec2 p) {
        highp uvec2 q = uvec2(ivec2(p));
        return float(sfPcg(q.x + sfPcg(q.y)) >> 8u) * (1.0 / 16777216.0);
      }
      float sfValNoise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sfHash1(i), sfHash1(i + vec2(1.0, 0.0)), f.x),
                   mix(sfHash1(i + vec2(0.0, 1.0)), sfHash1(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      // Two-octave grain: a fine base plus a finer, rotated detail octave, biased
      // toward the high frequency so the texture is crisp rather than cloudy.
      float sfGrain2(vec2 p) {
        float a = sfValNoise(p);
        float b = sfValNoise(p * 2.17 + vec2(19.0, 7.0));
        return clamp(0.5 + (a - 0.5) * 0.55 + (b - 0.5) * 0.85, 0.0, 1.0);
      }
      ${perStockHelpers}`,
    glsl: `
      ${perStock ? STOCK_FROM_FILM : ""}
      if (sfGrainAmount > 0.0${perStock ? " && sfK >= 0" : ""}) {
#if SL_PROCESS_VERSION >= 2
        vec3 sfGrainBase = clamp(c, 0.0, 1.0);
#else
        c = clamp(c, 0.0, 1.0);
        vec3 sfGrainBase = c;
#endif
        // Frame-relative, square-celled, resolution-independent grain coordinate.
        vec2 gbase = vec2(srcUv.x * uImageAspect, srcUv.y) * (${GRAIN_REF}.0 / max(sfGrainSize, 0.5));
        // Per-channel coarseness (÷scale) + a per-channel offset so the three
        // channels are independent (coloured grain), not one luminance grain tinted.
        // B&W stocks override this with a single shared noise (monochrome grain).
        vec3 gs = ${perStock ? "sfGrainScaleOf[sfK]" : scaleOf(DEFAULT_FX)};
        vec3 gn = ${perStock ? "sfGrainMonoOf[sfK]" : "false"}
          ? vec3(sfGrain2(gbase) - 0.5)
          : vec3(
              sfGrain2(gbase / gs.x),
              sfGrain2(gbase / gs.y + vec2(37.0, 11.0)),
              sfGrain2(gbase / gs.z + vec2(91.0, 53.0))
            ) - 0.5;
        float glum = dot(sfGrainBase, vec3(0.2126, 0.7152, 0.0722));
        float genv = 2.0 * sqrt(max(glum * (1.0 - glum), 0.0));
        c += sfGrainAmount * genv * gn;
      }`,
  };
}

let theApi: SafelightAPI | null = null;
let texVersion = 1;

// Per-image film-stock selection. The chosen stock lives in the develop paramBag
// (like the sliders) so it round-trips PER PHOTO, stored as a numeric index into
// FILM_STOCKS (-1 = None/off). Untouched photos default to None — the film is
// strictly opt-in per image, never inherited from another photo.
let storeUnsub: (() => void) | null = null;

function stockIndexForId(id: string): number {
  if (id === NONE_ID) return -1;
  const i = FILM_STOCKS.findIndex((s) => s.id === id);
  return i >= 0 ? i : 0;
}

function stockIdFromBag(bag: Record<string, unknown>): string {
  const idx = bag[K_STOCK] ?? bag[LEGACY_STOCK];
  if (typeof idx === "number") return idx < 0 ? NONE_ID : (FILM_STOCKS[idx]?.id ?? NONE_ID);
  return NONE_ID; // untouched photo → off
}

// A photo picked before the stock was a uniform renders without it until its
// pick reaches K_STOCK, which the next commit then stores with the photo.
function carryLegacyStock(api: SafelightAPI, bag: Record<string, unknown>): void {
  const legacy = bag[LEGACY_STOCK];
  if (bag[K_STOCK] === undefined && typeof legacy === "number") {
    api.stores.useDevelopStore.getState().setDynParam(K_STOCK, legacy);
  }
}

function uploadStocks(api: SafelightAPI): void {
  const v = ++texVersion;
  for (const [key, tex] of Object.entries(buildAtlases(FILM_STOCKS))) {
    api.setStageTexture(STAGE_ID, key, { ...tex, version: v });
  }
}

// ─── Panel control layout ───────────────────────────────────────────────────
// One source of truth for the panel's sliders, their defaults, AND the reset
// maps — grouped into the collapsible sections the panel renders, so a control,
// its default and its section can never drift apart.
interface Ctrl { stage: string; key: string; label: string; min: number; max: number; dflt: number; step: number; }
interface PanelSection { id: string; title: string; hint: string; ctrls: Ctrl[]; }

// Film controls differ by path: negatives expose the full enlarger-print chain;
// slides (reversal) have no print, so only Exposure / Coupler Amount / a film-
// curve Contrast apply (mirrors buildStage's per-path uniform set).
const FILM_CTRLS_NEG: Ctrl[] = [
  { stage: STAGE_ID, key: "sfExposure", label: "Exposure", min: -3, max: 3, dflt: 0, step: 0.01 },
  { stage: STAGE_ID, key: "sfPrintExp", label: "Print Exposure", min: 0.2, max: 3, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfCouplerAmt", label: "Coupler Amount", min: 0, max: 2, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfContrast", label: "Print Contrast", min: 0.5, max: 2, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfFiltM", label: "Filtration M", min: -100, max: 100, dflt: 0, step: 1 },
  { stage: STAGE_ID, key: "sfFiltY", label: "Filtration Y", min: -100, max: 100, dflt: 0, step: 1 },
];
const FILM_CTRLS_POS: Ctrl[] = [
  { stage: STAGE_ID, key: "sfExposure", label: "Exposure", min: -3, max: 3, dflt: 0, step: 0.01 },
  { stage: STAGE_ID, key: "sfCouplerAmt", label: "Coupler Amount", min: 0, max: 2, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfContrast", label: "Contrast", min: 0.5, max: 2, dflt: 1, step: 0.01 },
];
// B&W runs the full negative→print path, so the bundle keeps the negative uniform
// set, but DIR couplers and colour-head filtration are meaningless for a neutral
// silver emulsion. The panel shows just the darkroom essentials: film exposure,
// print exposure (print lightness) and Print Contrast (the paper grade).
const FILM_CTRLS_BW: Ctrl[] = [
  { stage: STAGE_ID, key: "sfExposure", label: "Exposure", min: -3, max: 3, dflt: 0, step: 0.01 },
  { stage: STAGE_ID, key: "sfPrintExp", label: "Print Exposure", min: 0.2, max: 3, dflt: 1, step: 0.01 },
  { stage: STAGE_ID, key: "sfContrast", label: "Paper Grade", min: 0.5, max: 2, dflt: 1, step: 0.01 },
];
const HAL_CTRLS: Ctrl[] = [
  { stage: HAL_ID, key: "sfHalAmount", label: "Amount", min: 0, max: 1, dflt: 0, step: 0.01 },
  { stage: HAL_ID, key: "sfHalSize", label: "Size", min: 0, max: 8, dflt: 4, step: 0.1 },
  { stage: HAL_ID, key: "sfHalThreshold", label: "Threshold", min: 0, max: 2, dflt: 0.6, step: 0.01 },
];
const GRAIN_CTRLS: Ctrl[] = [
  { stage: GRAIN_ID, key: "sfGrainAmount", label: "Amount", min: 0, max: 1, dflt: 0, step: 0.01 },
  { stage: GRAIN_ID, key: "sfGrainSize", label: "Size", min: 0.5, max: 5, dflt: 1.5, step: 0.1 },
];

function filmCtrlsFor(kind: string): Ctrl[] {
  if (kind === "slide") return FILM_CTRLS_POS;
  if (kind === "bw") return FILM_CTRLS_BW;
  return FILM_CTRLS_NEG;
}
function sectionsFor(kind: string): PanelSection[] {
  const filmHint =
    kind === "slide" ? "Slide exposure, development and contrast (reversal film, scanned directly — no enlarger print)."
    : kind === "bw" ? "Darkroom black & white: film exposure, print exposure (print lightness) and paper grade (contrast)."
    : "Negative exposure, enlarger print, development and live colour-head filtration.";
  return [
    { id: "film", title: "Film", hint: filmHint, ctrls: filmCtrlsFor(kind) },
    { id: "halation", title: "Halation", hint: "Back-reflection highlight glow, tinted to the selected stock. Off at 0.", ctrls: HAL_CTRLS },
    { id: "grain", title: "Grain", hint: "Midtone-peaked, per-channel film grain at the stock's coarseness. Off at 0.", ctrls: GRAIN_CTRLS },
  ];
}
// Flat { "stage.key": default } map for a full reset — union across every path
// (FILM_CTRLS_NEG is a superset of the slide/bw film keys) so reset clears every
// control regardless of the current stock.
const ALL_DEFAULTS: Record<string, number> = Object.fromEntries(
  [...FILM_CTRLS_NEG, ...HAL_CTRLS, ...GRAIN_CTRLS].map((c) => [`${c.stage}.${c.key}`, c.dflt]),
);

function resetPanel(api: SafelightAPI): void {
  // Reset every slider AND turn the stock off (None is the per-image default),
  // then persist so the reset survives a library round-trip / reload.
  api.stores.useDevelopStore.getState().setDynParams({ ...ALL_DEFAULTS, [K_STOCK]: -1 });
  void api.stores.useDevelopStore.getState().commitEdit("Spektrafilm Reset");
}

const ENGINE_URL = "https://github.com/andreavolpato/spektrafilm";
const GUIDE_URL =
  "https://github.com/anthonyreimche/Spektrafilm-Support-for-Safelight#adding-your-own-stocks";
const REGEN_CMD = "python tools/extract_stock.py --emit\nnpm run build";

// Shown in place of the controls when no film-stock data is bundled. The looks
// are generated offline from Andrea Volpato's spectral engine (GPLv3) and baked
// into the extension; this guides the user through producing them.
function GettingStarted({ React, ui }: { React: ReactApi; ui: UiKit }) {
  const [copied, setCopied] = React.useState(false);
  const h = React.createElement;
  const { Button, Row, Stack, tokens } = ui;
  // The kit has no link button, so the links are styled inline from its tokens.
  const link = (href: string, label: string) =>
    h("a", {
      href, target: "_blank", rel: "noreferrer",
      style: {
        display: "block", padding: "4px 8px", borderRadius: 4, fontSize: 11, textDecoration: "none",
        background: tokens.surface2, color: tokens.textPrimary,
      },
    }, label);
  const step = (n: number, text: string) =>
    h(Row, { gap: 6, align: "flex-start" },
      h("span", { style: { color: tokens.textSecondary } }, `${n}.`),
      h("span", { style: { color: tokens.textPrimary } }, text));
  return h(
    Stack,
    { gap: 6, style: { padding: 8, fontSize: 11, color: tokens.textSecondary } },
    h("div", { style: { fontWeight: 600, color: tokens.textPrimary } }, "Spektrafilm not set up"),
    h("p", { style: { lineHeight: 1.4, margin: 0 } },
      "No film-stock data is bundled. Spektrafilm's looks are generated offline from the spectral engine, then baked into the extension. To get started:"),
    step(1, "Install the Spektrafilm engine (pip-installable, Python 3.13)."),
    step(2, "Run the extractor to generate the film stocks."),
    step(3, "Rebuild the extension and reload it."),
    h(Button,
      {
        full: true,
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

  // The stages and every stock's textures stay put whatever photo is open: each
  // photo's bag picks its stock, and with none the stages rest. No bundled
  // film-stock data → no film stage (it can't be built); the effects still
  // register with the fallback character, and the panel shows a getting-started
  // view instead.
  if (FILM_STOCKS.length > 0) {
    api.registerProcessingStage(buildStage());
    uploadStocks(api);
    // A photo switch (loadEdit) replaces the paramBag.
    const store = api.stores.useDevelopStore;
    carryLegacyStock(api, store.getState().paramBag ?? {});
    storeUnsub = store.subscribe((state) => carryLegacyStock(api, state.paramBag ?? {}));
  }
  api.registerProcessingStage(buildHalationStage());
  api.registerProcessingStage(buildGrainStage());

  api.registerPipeline({
    id: "spektrafilm-support.transform",
    name: "Spektrafilm",
    description:
      "Plain sRGB encode with the RAW base curve and highlight shoulder off — the correct view transform for the Spektrafilm film stage (the film provides the tone rendering).",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return linearToSrgbU(lin); }",
    skipBaseCurve: true,
    // The film's characteristic curve rolls off the highlights, so the film stage
    // gets the scene's headroom instead of values the core shoulder already
    // squeezed under white (current processing only; older edits keep the shoulder).
    skipToneShoulder: true,
  });

  // The panel edits whatever useParamScope hands it: the photo's bag in the
  // dock, a mask's in the Masking panel's Adjust tab. The stock is always the
  // photo's, and Halation and Grain stay the photo's, so a mask's panel has the
  // film controls only, which develop the photo's stock again with the mask's
  // settings on top of the photo's.
  function SpektrafilmPanel() {
    const Slider = api.components.Slider;
    const { Button, Field, Section, Select, Stack, tokens } = api.ui;
    const useDevelopStore = api.stores.useDevelopStore;
    const paramBag = useDevelopStore((s) => s.paramBag);
    const scope = api.develop.useParamScope();
    const inMask = scope.maskId !== null;
    const values = scope.getParams();
    // Section open/closed state (Film open; effects collapsed since they're off by
    // default). One object so the number of hooks stays constant — no per-section
    // useState in a loop.
    const [open, setOpen] = React.useState<Record<string, boolean>>({ film: true, halation: false, grain: false });

    // The selected stock is DERIVED from the per-image paramBag (re-rendered on
    // every photo switch), not local/global state — so the picker follows the
    // active photo.
    const stock = stockIdFromBag(paramBag);

    // No bundled film-stock data → the film controls are useless; show a
    // getting-started view instead (the looks are generated offline from the
    // Spektrafilm engine, then baked into the extension).
    if (FILM_STOCKS.length === 0) {
      return React.createElement(GettingStarted, { React, ui: api.ui });
    }

    const h = React.createElement;
    // Persist on gesture end (mirrors core panels): setDynParam only mutates the
    // in-memory bag, so without committing the values reset on a library round-trip.
    const commit = () => scope.commit("Spektrafilm");
    const valOf = (c: Ctrl): number => {
      const v = values[`${c.stage}.${c.key}`];
      return typeof v === "number" ? v : c.dflt;
    };
    const renderCtrl = (c: Ctrl) =>
      h(Slider, {
        key: c.key, label: c.label, value: valOf(c), min: c.min, max: c.max, step: c.step,
        defaultValue: c.dflt,
        onChange: (v: number) => scope.setParams({ [`${c.stage}.${c.key}`]: v }),
        onCommit: commit,
      });
    // Has any control in the section moved off its default? Drives the per-section
    // Reset affordance (shown only when there's something to reset).
    const sectionDirty = (sec: PanelSection) =>
      sec.ctrls.some((c) => valOf(c) !== c.dflt);
    const resetSection = (sec: PanelSection) => {
      scope.setParams(Object.fromEntries(sec.ctrls.map((c) => [`${c.stage}.${c.key}`, c.dflt])));
      commit();
    };

    const renderSection = (sec: PanelSection) => {
      const isOpen = open[sec.id];
      return h(Section,
        {
          key: sec.id,
          title: h("span",
            { title: sec.hint, style: { cursor: "pointer" }, onClick: () => setOpen({ ...open, [sec.id]: !isOpen }) },
            `${isOpen ? "▾" : "▸"} ${sec.title}`),
          right: sectionDirty(sec)
            ? h(Button, { variant: "ghost", size: "sm", onClick: () => resetSection(sec) }, "Reset")
            : null,
        },
        isOpen ? sec.ctrls.map(renderCtrl) : null);
    };

    // Group the picker by film family and surface the selected stock's blurb.
    const KIND_LABEL: Record<string, string> = {
      negative: "Colour negative", cine: "Cinema", slide: "Slide / reversal", bw: "Black & white",
    };
    const kinds = FILM_STOCKS.map((s) => s.kind).filter((k, i, a) => a.indexOf(k) === i);
    // "None" turns the whole extension off; real stocks follow, grouped by family.
    const groups: SelectGroup[] = [
      { items: [{ value: NONE_ID, label: "None (off)" }] },
      ...kinds.map((k) => ({
        title: KIND_LABEL[k] ?? k,
        items: FILM_STOCKS.filter((s) => s.kind === k).map((s) => ({ value: s.id, label: s.name })),
      })),
    ];
    const activeStock = FILM_STOCKS.find((s) => s.id === stock) ?? FILM_STOCKS[0];
    const isNone = stock === NONE_ID;
    const sections = sectionsFor(activeStock.kind);
    const note = (text: string) =>
      h("p", { style: { fontSize: 11, lineHeight: 1.35, margin: 0, color: tokens.textSecondary } }, text);

    if (inMask) {
      return h(
        Stack,
        { gap: 6, style: { padding: 8 } },
        isNone
          ? note("This photo has no film stock yet. Choose one in the Spektrafilm panel, then shape it here.")
          : note(`Develops the photo's ${activeStock.name} again inside the mask, these settings on top of the photo's. At their defaults the mask matches the photo.`),
        isNone ? null : renderSection(sections[0]),
      );
    }

    return h(
      Stack,
      { gap: 8, style: { padding: 8 } },
      h(Field,
        {
          label: "Film stock",
          hint: isNone
            ? "Spektrafilm is off. Choose a film stock to enable it, and switch your rendering transform back from “Spektrafilm”."
            : activeStock.description,
        },
        h(Select, {
          value: stock,
          groups,
          ariaLabel: "Film stock",
          onChange: (id: string) => {
            useDevelopStore.getState().setDynParam(K_STOCK, stockIndexForId(id)); // per-image selection
            commit();                                                            // persist on this photo
          },
        })),
      isNone ? null : sections.map(renderSection),
    );
  }

  api.registerPanel({
    id: "spektrafilm-support.panel",
    title: "Spektrafilm",
    component: SpektrafilmPanel,
    defaultDock: { module: "develop", direction: "right", order: 6, width: 260 },
    modules: ["develop"],
    onReset: () => resetPanel(api),
    // The same panel edits a mask's film settings in the Masking panel's
    // Adjust tab. Every stock's controls are a subset of the negative's.
    mask: { component: SpektrafilmPanel, owns: FILM_CTRLS_NEG.map((c) => `${c.stage}.${c.key}`) },
  });
}

export function deactivate(): void {
  storeUnsub?.();
  storeUnsub = null;
  theApi?.setStageTexture(STAGE_ID, "filmTc", null);
  theApi?.setStageTexture(STAGE_ID, "filmCurves", null);
  theApi?.setStageTexture(STAGE_ID, "filmSpec", null);
  theApi = null;
}
