function d(e) {
  return e = Math.min(1, Math.max(0, e)), e <= 31308e-7 ? e * 12.92 : 1.055 * Math.pow(e, 1 / 2.4) - 0.055;
}
function g(e) {
  return Math.pow(2, e * 16 + -10);
}
function L() {
  const t = new Uint8Array(143748);
  for (let a = 0; a < 33; a++)
    for (let o = 0; o < 33; o++)
      for (let l = 0; l < 33; l++) {
        const m = a * 33 + l, s = (o * 1089 + m) * 4;
        t[s] = Math.round(d(g(l / 32)) * 255), t[s + 1] = Math.round(d(g(o / 32)) * 255), t[s + 2] = Math.round(d(g(a / 32)) * 255), t[s + 3] = 255;
      }
  return t;
}
const T = `
const float SF_MIN_EV = ${(-10).toFixed(1)};
const float SF_MAX_EV = ${6 .toFixed(1)};
vec3 sfShaper(vec3 lv) {
  return clamp((log2(max(lv, vec3(1e-10))) - SF_MIN_EV) / (SF_MAX_EV - SF_MIN_EV), 0.0, 1.0);
}
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
`, h = [], u = "spektrafilm-support.film", i = [
  { id: "neutral", name: "Neutral (no film baked)", atlas: L },
  ...h
], y = {
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
}, k = `
  vec3 linExp = lin * exp2(exposure);
  vec3 film = srgbToLinear(sfSampleLut(filmLut, sfShaper(linExp), cubeSize));
  film += stageResult * vec3(1.0, 0.4, 0.15) * halation;
  float noise = (sfHash(srcUv * vec2(1543.0, 2087.0)) - 0.5) * grain * 0.08;
  lin = max(film * (1.0 + noise), vec3(0.0));
`, M = {
  id: u,
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
  helpers: T,
  glsl: k,
  passes: [y]
};
let c = null, I = 1;
function _(e, t) {
  const a = i.find((o) => o.id === t) ?? i[0];
  e.setStageTexture(u, "filmLut", {
    data: a.atlas(),
    width: 1089,
    height: 33,
    format: "rgba8",
    version: I++
  });
}
function P(e) {
  c = e;
  const t = e.react;
  e.registerProcessingStage(M), _(e, e.settings.get("stock", i[0].id));
  function a() {
    const o = e.components.Slider, l = e.stores.useDevelopStore, m = l((n) => n.paramBag), p = l((n) => n.setDynParam), [s, E] = t.useState(() => e.settings.get("stock", i[0].id)), b = (n, r) => {
      const f = m[`${u}.${n}`];
      return typeof f == "number" ? f : r;
    }, S = (n, r, f, x, v) => t.createElement(o, {
      label: r,
      value: b(n, v),
      min: f,
      max: x,
      step: 0.01,
      defaultValue: v,
      onChange: (A) => p(`${u}.${n}`, A)
    });
    return t.createElement(
      "div",
      { style: { padding: 12, display: "flex", flexDirection: "column", gap: 10 } },
      t.createElement(
        "label",
        { style: { fontSize: 12, color: "var(--color-text-secondary)" } },
        "Film stock"
      ),
      t.createElement(
        "select",
        {
          value: s,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onChange: (n) => {
            const r = n.target.value;
            E(r), e.settings.set("stock", r), _(e, r);
          },
          style: {
            background: "var(--color-surface-2)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
            padding: "4px 6px",
            fontSize: 13
          }
        },
        i.map(
          (n) => t.createElement("option", { key: n.id, value: n.id }, n.name)
        )
      ),
      S("exposure", "Print Exposure", -3, 3, 0),
      S("halation", "Halation", 0, 1, 0),
      S("grain", "Grain", 0, 1, 0)
    );
  }
  e.registerPanel({
    id: "spektrafilm-support.panel",
    title: "Spektrafilm",
    component: a,
    defaultDock: { module: "develop", direction: "right", order: 6, width: 260 }
  });
}
function H() {
  c == null || c.setStageTexture(u, "filmLut", null), c = null;
}
export {
  P as activate,
  H as deactivate
};
//# sourceMappingURL=index.js.map
