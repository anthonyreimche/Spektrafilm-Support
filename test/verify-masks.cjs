// Local-adjustment masks. The film stage runs again inside a mask that holds
// its keys and develops the photo's scene with the mask's settings on top of
// the photo's; Halation and Grain stay the photo's. activate() offers the panel
// in the Masking panel's Adjust tab, owning the film keys it writes, and the
// panel there shows the film controls only: the stock is the photo's, since a
// copy shares the stage's spectral textures. The panel renders here without
// React or a DOM: hooks hand back their initial state and the element tree is
// plain objects whose handlers are called as the core's controls would.
const path = require("path");
const I = require(path.join(__dirname, ".build", "index.js"));
const { FILM_STOCKS } = require(path.join(__dirname, ".build", "stocks_data.generated.js"));

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) fails++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const FILM = "spektrafilm-support.film";
const STOCK = `${FILM}.__stock`;
const FILM_KEYS = ["sfExposure", "sfPrintExp", "sfCouplerAmt", "sfContrast", "sfFiltM", "sfFiltY"].map((k) => `${FILM}.${k}`);
const NEGATIVE = FILM_STOCKS.findIndex((s) => s.kind === "negative");

function fakeStore(init) {
  let state = init;
  const listeners = new Set();
  const hook = (selector) => (selector ? selector(state) : state);
  hook.getState = () => state;
  hook.setState = (partial) => {
    const prev = state;
    state = { ...state, ...(typeof partial === "function" ? partial(state) : partial) };
    for (const l of listeners) l(state, prev);
  };
  hook.subscribe = (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return hook;
}

const Slider = () => null;

/** Activates over a photo bag, inside a mask holding `maskBag` when one is given. */
function rig(photoBag = {}, maskBag) {
  const commits = [];
  const stages = new Map();
  const panels = [];
  const develop = fakeStore({
    photoId: "p1",
    paramBag: photoBag,
    setDynParam: (key, value) => develop.setState((s) => ({ paramBag: { ...s.paramBag, [key]: value } })),
    setDynParams: (patch) => develop.setState((s) => ({ paramBag: { ...s.paramBag, ...patch } })),
    commitEdit: async (label) => void commits.push(label),
  });
  const mask = fakeStore({ bag: maskBag ?? {} });
  const photoScope = {
    maskId: null,
    getParam: (key) => develop.getState().paramBag[key],
    getParams: () => develop.getState().paramBag,
    setParams: (patch) => develop.getState().setDynParams(patch),
    commit: (label) => void develop.getState().commitEdit(label),
  };
  const maskScope = {
    maskId: "mask-1",
    getParam: (key) => mask.getState().bag[key],
    getParams: () => mask.getState().bag,
    setParams: (patch) => mask.setState((s) => ({ bag: { ...s.bag, ...patch } })),
    commit: (label) => void commits.push(`mask: ${label}`),
  };
  I.deactivate();
  I.activate({
    react: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: (init) => [typeof init === "function" ? init() : init, () => undefined],
    },
    registerProcessingStage: (s) => void stages.set(s.id, s),
    unregisterProcessingStage: (id) => void stages.delete(id),
    setStageTexture: () => undefined,
    registerPipeline: () => undefined,
    registerPanel: (p) => void panels.push(p),
    settings: { get: (_key, fallback) => fallback, set: () => undefined },
    components: { Slider },
    stores: { useDevelopStore: develop },
    develop: { useParamScope: () => (maskBag === undefined ? photoScope : maskScope) },
  });
  return { develop, mask, commits, stages, panel: panels[0], render: () => panels[0].component() };
}

/** Every element in a tree that `test` accepts, children arrays flattened. */
function findAll(node, test) {
  if (Array.isArray(node)) return node.flatMap((c) => findAll(c, test));
  if (!node || typeof node !== "object") return [];
  return [...(test(node) ? [node] : []), ...findAll(node.children, test)];
}
function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" ? textOf(node.children) : "";
}
const sliders = (tree) => findAll(tree, (e) => e.type === Slider).map((e) => e.props);
const slider = (tree, label) => sliders(tree).find((s) => s.label === label);

// ── The stages ───────────────────────────────────────────────────────────────
{
  const r = rig({ [STOCK]: NEGATIVE });
  const film = r.stages.get(FILM);
  check("the film stage runs again inside masks", !!film && same(film.mask, { maskable: true }));
  check(
    "Halation and Grain stay the photo's",
    r.stages.has("spektrafilm-support.halation") && r.stages.has("spektrafilm-support.grain") &&
      r.stages.get("spektrafilm-support.halation").mask === undefined && r.stages.get("spektrafilm-support.grain").mask === undefined,
  );
  const produced = (film && film.produces) || [];
  check(
    "the film hands its scene and live settings on to its mask copies",
    same(produced.map((v) => [v.name, v.glslType, v.producer]), [
      ["spektrafilmScene", "vec4", undefined],
      ["spektrafilmLive", "vec4", undefined],
      ["spektrafilmFilt", "vec2", undefined],
    ]),
  );
  // The core refuses a stage that reads an isv_ name it neither produces nor consumes.
  const read = new Set(((film && film.glsl) || "").replace(/\/\/[^\n]*/g, "").match(/\bisv_\w+/g) || []);
  check("every isv_ name the film reads is one it produces", [...read].every((n) => produced.some((v) => `isv_${v.name}` === n)) && read.size === 3, [...read].join(", "));
}

// ── activate() ───────────────────────────────────────────────────────────────
{
  const r = rig();
  const mask = r.panel.mask;
  check("the panel is offered in masks", !!mask && mask.component === r.panel.component);
  check("it owns the film keys it writes, and only those", !!mask && same([...mask.owns].sort(), [...FILM_KEYS].sort()), mask && mask.owns.join(", "));
}

// ── The panel in a mask ──────────────────────────────────────────────────────
{
  const r = rig({ [STOCK]: NEGATIVE, [`${FILM}.sfExposure`]: -1 }, { [`${FILM}.sfExposure`]: 0.5 });
  const tree = r.render();
  check("shows the mask's film settings, not the photo's", slider(tree, "Exposure")?.value === 0.5, String(slider(tree, "Exposure")?.value));
  check("leaves out the stock picker: a mask develops the photo's stock", findAll(tree, (e) => e.type === "select").length === 0);
  check(
    "shows the film controls only, without Halation and Grain",
    same(sliders(tree).map((s) => s.label), ["Exposure", "Print Exposure", "Coupler Amount", "Print Contrast", "Filtration M", "Filtration Y"]) &&
      !/Halation|Grain/.test(textOf(tree)),
    sliders(tree).map((s) => s.label).join(", "),
  );
}
{
  const r = rig({ [STOCK]: NEGATIVE }, {});
  const exposure = slider(r.render(), "Exposure");
  exposure.onChange(1);
  exposure.onCommit();
  check("a film slider writes the mask", same(r.mask.getState().bag, { [`${FILM}.sfExposure`]: 1 }));
  check("a film slider leaves the photo's bag alone", same(r.develop.getState().paramBag, { [STOCK]: NEGATIVE }));
  check("a film slider commits once, to the mask", same(r.commits, ["mask: Spektrafilm"]), r.commits.join(", "));
}
{
  const r = rig({ [STOCK]: NEGATIVE }, { [`${FILM}.sfPrintExp`]: 1.4 });
  const reset = findAll(r.render(), (e) => e.type === "button" && textOf(e) === "Reset")[0];
  if (reset) reset.props.onClick({ stopPropagation: () => undefined });
  check("the film section's reset clears the mask's settings back to the photo's", !!reset && r.mask.getState().bag[`${FILM}.sfPrintExp`] === 1 && same(r.develop.getState().paramBag, { [STOCK]: NEGATIVE }));
  check("the reset commits once, to the mask", same(r.commits, ["mask: Spektrafilm"]), r.commits.join(", "));
}
{
  const r = rig({}, {});
  const tree = r.render();
  check("with no stock on the photo a mask has no controls", sliders(tree).length === 0 && findAll(tree, (e) => e.type === "select").length === 0);
  check("and says the photo has no film stock yet", /no film stock/i.test(textOf(tree)), textOf(tree).trim());
}

// ── The same panel in the dock ───────────────────────────────────────────────
{
  const r = rig({ [STOCK]: NEGATIVE });
  const tree = r.render();
  check("in the dock it has the stock picker and all three sections", findAll(tree, (e) => e.type === "select").length === 1 && /Film[\s\S]*Halation[\s\S]*Grain/.test(textOf(tree)));
  const exposure = slider(tree, "Exposure");
  exposure.onChange(0.7);
  exposure.onCommit();
  check("in the dock a film slider writes the photo's bag", r.develop.getState().paramBag[`${FILM}.sfExposure`] === 0.7);
  check("in the dock it commits under the panel's name", same(r.commits, ["Spektrafilm"]), r.commits.join(", "));
}

I.deactivate();
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL MASK CHECKS PASS");
process.exit(fails ? 1 : 0);
