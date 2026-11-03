// A stand-in host for the node checks: activate() over a fake develop store,
// with the registrations, uploads and commits it makes recorded. The panel
// renders without React or a DOM: hooks hand back their initial state and the
// element tree is plain objects whose handlers are called as the core's
// controls would.
const path = require("path");
const I = require(path.join(__dirname, ".build", "index.js"));

const FILM = "spektrafilm-support.film";

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
const ui = {
  Button: () => null,
  Select: () => null,
  Field: () => null,
  Section: () => null,
  Stack: () => null,
  Row: () => null,
  tokens: {
    textPrimary: "var(--color-text-primary)",
    textSecondary: "var(--color-text-secondary)",
    textMuted: "var(--color-text-muted)",
    surface2: "var(--color-surface-2)",
    surface3: "var(--color-surface-3)",
  },
};

/** Activates over a photo bag, inside a mask holding `maskBag` when one is given. */
function rig(photoBag = {}, maskBag) {
  const commits = [];
  const stages = new Map();
  const registrations = [];
  const unregistered = [];
  const textures = new Map();
  const uploads = [];
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
    registerProcessingStage: (s) => {
      registrations.push(s.id);
      stages.set(s.id, s);
    },
    unregisterProcessingStage: (id) => {
      unregistered.push(id);
      stages.delete(id);
    },
    setStageTexture: (stageId, key, tex) => {
      uploads.push(`${stageId}.${key}`);
      textures.set(`${stageId}.${key}`, tex);
    },
    registerPipeline: () => undefined,
    registerPanel: (p) => void panels.push(p),
    settings: { get: (_key, fallback) => fallback, set: () => undefined },
    components: { Slider },
    ui,
    stores: { useDevelopStore: develop },
    develop: { useParamScope: () => (maskBag === undefined ? photoScope : maskScope) },
  });
  return {
    develop, mask, commits, stages, registrations, unregistered, textures, uploads,
    panel: panels[0],
    render: () => panels[0].component(),
  };
}

const isElement = (node) => !!node && typeof node === "object" && !Array.isArray(node) && "props" in node;

/** Every element in a tree that `test` accepts, through children and the
 *  element-valued props (a Section's title and right, a Field's hint). */
function findAll(node, test) {
  if (Array.isArray(node)) return node.flatMap((c) => findAll(c, test));
  if (!isElement(node)) return [];
  const { title, right, label, hint } = node.props;
  return [
    ...(test(node) ? [node] : []),
    ...findAll([title, right, label, hint].filter(isElement), test),
    ...findAll(node.children, test),
  ];
}
/** The text a tree shows: string children and the labelling props, in order. */
function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isElement(node)) return "";
  const { title, label, hint, right } = node.props;
  return [title, label, hint, right, node.children].map(textOf).join(" ");
}
const sliders = (tree) => findAll(tree, (e) => e.type === Slider).map((e) => e.props);
const slider = (tree, label) => sliders(tree).find((s) => s.label === label);

module.exports = { I, FILM, Slider, ui, rig, findAll, textOf, sliders, slider };
