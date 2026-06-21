function A() {
  const t = new Uint8Array(143748);
  for (let a = 0; a < 33; a++)
    for (let l = 0; l < 33; l++)
      for (let o = 0; o < 33; o++) {
        const c = (l * 1089 + (a * 33 + o)) * 4;
        t[c] = Math.round(o / 32 * 255), t[c + 1] = Math.round(l / 32 * 255), t[c + 2] = Math.round(a / 32 * 255), t[c + 3] = 255;
      }
  return t;
}
const _ = `
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
`, k = [], s = "spektrafilm-support.film", i = [
  { id: "neutral", name: "Neutral (no film baked)", atlas: A },
  ...k
], E = {
  iterations: 2,
  glsl: `
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int i = -6; i <= 6; i++) {
      float w = exp(-float(i * i) / 18.0);
      vec2 off = (uPassIndex == 0) ? vec2(float(i), 0.0) : vec2(0.0, float(i));
      vec3 s = readPrev(vUv + off * uTexel * 3.0);
      if (uPassIndex == 0) s = max(s - 0.7, vec3(0.0));
      sum += s * w;
      wsum += w;
    }
    c = sum / wsum;
  `
}, h = `
  vec3 linExp = lin * exp2(exposure);
  vec3 film = srgbToLinear(sfSampleLut(filmLut, linearToSrgb(linExp), cubeSize));
  film += stageResult * vec3(1.0, 0.4, 0.15) * halation;
  float noise = (sfHash(srcUv * vec2(1543.0, 2087.0)) - 0.5) * grain * 0.08;
  lin = max(film * (1.0 + noise), vec3(0.0));
`, y = {
  id: s,
  name: "Spektrafilm",
  phase: "tone-map",
  uniforms: [
    { key: "exposure", glslType: "float", default: 0, range: { min: -3, max: 3, step: 0.01 }, label: "Print Exposure" },
    { key: "halation", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Halation" },
    { key: "grain", glslType: "float", default: 0, range: { min: 0, max: 1, step: 0.01 }, label: "Grain" },
    // Cube edge, fixed at the baked LUT size; not user-facing.
    { key: "cubeSize", glslType: "float", default: 33 }
  ],
  textures: [
    { key: "filmLut", kind: "lut", width: 1089, height: 33, format: "rgba8" }
  ],
  helpers: _,
  glsl: h,
  passes: [E]
};
let f = null, I = 1, u = null;
function S(e, t) {
  const a = i.find((l) => l.id === t) ?? i[0];
  e.setStageTexture(s, "filmLut", {
    data: a.atlas(),
    width: 1089,
    height: 33,
    format: "rgba8",
    version: I++
  });
}
function P(e) {
  e.stores.useDevelopStore.getState().setDynParams({
    [`${s}.exposure`]: 0,
    [`${s}.halation`]: 0,
    [`${s}.grain`]: 0
  });
  const t = i[0].id;
  e.settings.set("stock", t), S(e, t), u == null || u(t);
}
function w(e) {
  f = e;
  const t = e.react;
  e.registerProcessingStage(y), S(e, e.settings.get("stock", i[0].id));
  function a() {
    const l = e.components.Slider, o = e.stores.useDevelopStore, c = o((n) => n.paramBag), v = o((n) => n.setDynParam), [x, g] = t.useState(() => e.settings.get("stock", i[0].id));
    t.useEffect(() => (u = g, () => {
      u === g && (u = null);
    }), []);
    const b = (n, r) => {
      const m = c[`${s}.${n}`];
      return typeof m == "number" ? m : r;
    }, d = (n, r, m, L, p) => t.createElement(l, {
      label: r,
      value: b(n, p),
      min: m,
      max: L,
      step: 0.01,
      defaultValue: p,
      onChange: (T) => v(`${s}.${n}`, T)
    });
    return t.createElement(
      "div",
      { className: "flex flex-col gap-1.5 p-2" },
      t.createElement(
        "label",
        { className: "text-[11px] text-text-secondary" },
        "Film stock"
      ),
      t.createElement(
        "select",
        {
          value: x,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (n) => {
            const r = n.target.value;
            g(r), e.settings.set("stock", r), S(e, r);
          },
          className: "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3"
        },
        i.map(
          (n) => t.createElement("option", { key: n.id, value: n.id }, n.name)
        )
      ),
      d("exposure", "Print Exposure", -3, 3, 0),
      d("halation", "Halation", 0, 1, 0),
      d("grain", "Grain", 0, 1, 0)
    );
  }
  e.registerPanel({
    id: "spektrafilm-support.panel",
    title: "Spektrafilm",
    component: a,
    defaultDock: { module: "develop", direction: "right", order: 6, width: 260 },
    onReset: () => P(e)
  });
}
function D() {
  f == null || f.setStageTexture(s, "filmLut", null), f = null;
}
export {
  w as activate,
  D as deactivate
};
//# sourceMappingURL=index.js.map
