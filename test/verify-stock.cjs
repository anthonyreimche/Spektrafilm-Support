// The stock is the photo's. It lives in the photo's bag as a uniform, and the
// stages and the spectral textures hold every stock at once, so whichever
// renderer draws a photo (the Develop view, an edited thumbnail, an export)
// develops it with its own stock, not the one the photo open in Develop has.
// Also: Halation and Grain keep the full range of what they're handed, the
// halo's spread is a fraction of the frame at any render size, and the panel
// is built from api.ui with no Tailwind classes of its own.
const fs = require("fs");
const path = require("path");
const { I, FILM, ui, rig, findAll, textOf } = require(path.join(__dirname, "rig.cjs"));
const { FILM_STOCKS } = require(path.join(__dirname, ".build", "stocks_data.generated.js"));
const { atVersion } = require(path.join(__dirname, "process-version.cjs"));

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) fails++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const HAL = "spektrafilm-support.halation";
const GRAIN = "spektrafilm-support.grain";
const STOCK = `${FILM}.sfStock`;
const LEGACY = `${FILM}.__stock`;
const N = FILM_STOCKS.length;
const SLIDE = FILM_STOCKS.findIndex((s) => s.kind === "slide");
const BW = FILM_STOCKS.findIndex((s) => s.kind === "bw");

/** Whether `atlas` holds each stock's own table at its index, in rows of `rowLen` floats. */
function holdsEvery(atlas, table) {
  const per = table(FILM_STOCKS[0]).length;
  if (!atlas || atlas.data.length !== per * N) return false;
  return FILM_STOCKS.every((s, k) => {
    const own = table(s);
    return own.length === per && own.every((v, i) => Object.is(atlas.data[k * per + i], v));
  });
}

// ── Registration ─────────────────────────────────────────────────────────────
{
  const r = rig({});
  check(
    "with no stock picked the film, Halation and Grain are registered all the same",
    [FILM, HAL, GRAIN].every((id) => r.stages.has(id)) && r.unregistered.length === 0,
    [...r.stages.keys()].join(", "),
  );
  const stock = (r.stages.get(FILM)?.uniforms ?? []).find((u) => u.key === "sfStock");
  check("the photo's stock is an int uniform, off by default", !!stock && stock.glslType === "int" && stock.default === -1, JSON.stringify(stock));

  const before = [...r.registrations];
  const uploaded = [...r.uploads];
  r.develop.setState({ photoId: "p2", paramBag: { [STOCK]: SLIDE } });
  r.develop.setState({ photoId: "p3", paramBag: { [STOCK]: BW } });
  r.develop.setState({ photoId: "p4", paramBag: {} });
  check(
    "opening photos with other stocks registers and uploads nothing more",
    same(r.registrations, before) && same(r.uploads, uploaded),
    `${r.registrations.length - before.length} registrations, ${r.uploads.length - uploaded.length} uploads`,
  );
}

// ── The textures hold every stock ────────────────────────────────────────────
{
  const r = rig({});
  const tc = r.textures.get(`${FILM}.filmTc`);
  const curves = r.textures.get(`${FILM}.filmCurves`);
  const spec = r.textures.get(`${FILM}.filmSpec`);
  const T = FILM_STOCKS[0].tcSize;
  check("the chromaticity table stacks every stock's tile", !!tc && tc.width === T && tc.height === T * N && holdsEvery(tc, (s) => s.filmTc()), tc && `${tc.width}×${tc.height}`);
  check("the curves stack every stock's three rows", !!curves && curves.width === 256 && curves.height === 3 * N && holdsEvery(curves, (s) => s.filmCurves()), curves && `${curves.width}×${curves.height}`);
  check("the spectra stack every stock's four rows", !!spec && spec.width === 81 && spec.height === 4 * N && holdsEvery(spec, (s) => s.filmSpec()), spec && `${spec.width}×${spec.height}`);
  const film = r.stages.get(FILM);
  check(
    "the film's GLSL bakes no one stock's constants",
    !!film && !FILM_STOCKS.some((s) => `${film.glsl}\n${film.helpers ?? ""}`.includes(s.consts)),
  );
}

// ── The effects follow the photo's stock ─────────────────────────────────────
{
  const r = rig({});
  const film = r.stages.get(FILM);
  const produced = (film?.produces ?? []).map((v) => v.name);
  for (const id of [HAL, GRAIN]) {
    const s = r.stages.get(id);
    check(`${id} reads the photo's stock from the film stage`, !!s && (s.consumes ?? []).includes("spektrafilmStock") && produced.includes("spektrafilmStock"));
  }
}

// ── The panel ────────────────────────────────────────────────────────────────
{
  const r = rig({});
  const picker = findAll(r.render(), (e) => e.type === ui.Select)[0];
  picker?.props.onChange(FILM_STOCKS[SLIDE].id);
  check("the picker writes the stock into the photo's bag", r.develop.getState().paramBag[STOCK] === SLIDE, String(r.develop.getState().paramBag[STOCK]));
  check("and commits it to the photo", same(r.commits, ["Spektrafilm"]), r.commits.join(", "));
  const none = findAll(r.render(), (e) => e.type === ui.Select)[0];
  none?.props.onChange("none");
  check("None writes the stock off", r.develop.getState().paramBag[STOCK] === -1);
}
{
  const r = rig({ [LEGACY]: SLIDE });
  check("a photo stored before the stock was a uniform keeps its stock", r.develop.getState().paramBag[STOCK] === SLIDE, String(r.develop.getState().paramBag[STOCK]));
  r.develop.setState({ photoId: "p2", paramBag: { [LEGACY]: BW } });
  check("so does one opened after it", r.develop.getState().paramBag[STOCK] === BW, String(r.develop.getState().paramBag[STOCK]));
  r.develop.setState({ photoId: "p3", paramBag: { [LEGACY]: BW, [STOCK]: -1 } });
  check("the uniform wins over the old key", r.develop.getState().paramBag[STOCK] === -1);
  const picker = findAll(r.render(), (e) => e.type === ui.Select)[0];
  check("and the picker shows it", picker?.props.value === "none", picker?.props.value);
}
{
  const r = rig({ [STOCK]: SLIDE });
  r.panel.onReset();
  check("the panel's reset turns the stock off", r.develop.getState().paramBag[STOCK] === -1);
}

// ── Full range ───────────────────────────────────────────────────────────────
// Whatever envelope an effect works out from [0, 1] values, the c it hands on
// is the c it was handed plus its effect: no assignment to c clips it, from
// process version 2 on.
{
  const r = rig({});
  for (const id of [HAL, GRAIN]) {
    for (const version of [2, 3]) {
      const glsl = atVersion(r.stages.get(id)?.glsl ?? "", version).replace(/\/\/[^\n]*/g, "");
      const writes = glsl.match(/(?:^|[;{}\s])c\s*[-+*/]?=(?!=)[^;]*;/g) ?? [];
      const clipping = writes.filter((w) => /clamp\s*\(|min\s*\(|max\s*\(|saturate\s*\(/.test(w));
      check(`${id} never writes a clipped c on version ${version}`, writes.length > 0 && clipping.length === 0, clipping.map((w) => w.trim()).join(" | "));
    }
  }
}

// ── Version 1 ────────────────────────────────────────────────────────────────
// Photos on process version 1 keep the look they were edited with: the halo's
// level is Size itself and its screen blend works on c held to [0, 1], and
// grain holds c to [0, 1] before adding itself.
{
  const r = rig({});
  const hal = atVersion(r.stages.get(HAL)?.glsl ?? "", 1);
  check(
    "version 1's halo reads the level Size names, whatever the source's size",
    hal.includes("vec3 sfBlur = textureLod(uImage, srcUv, clamp(sfHalSize, 0.0, 8.0)).rgb;") &&
      !hal.includes("textureSize(") &&
      !hal.includes(`${I.HAL_REF_EDGE}`),
  );
  check("version 1's halo screen-blends c held to [0, 1]", hal.includes("c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - hgl);") && !/c \+=/.test(hal));
  const grain = atVersion(r.stages.get(GRAIN)?.glsl ?? "", 1);
  const held = grain.indexOf("c = clamp(c, 0.0, 1.0);");
  check(
    "version 1's grain holds c to [0, 1] before adding itself",
    held >= 0 && held < grain.indexOf("vec2 gbase") && held < grain.indexOf("c += sfGrainAmount * genv * gn;"),
  );
}

// ── Halation spread ──────────────────────────────────────────────────────────
// The source's mip chain is as long as the render is big, so a fixed level
// blurs a fixed number of texels: the same Size would glow four times wider on
// a thumbnail than in Develop. The level is anchored to the source's long edge.
{
  const r = rig({});
  const glsl = atVersion(r.stages.get(HAL)?.glsl ?? "", 2);
  check(
    "the halo's level is anchored to the source's long edge on version 2",
    /textureSize\(\s*uImage\s*,\s*0\s*\)/.test(glsl) && /log2\(/.test(glsl) && glsl.includes(`${I.HAL_REF_EDGE}`) && I.HAL_REF_EDGE === 4096,
  );
}

// ── Styling ──────────────────────────────────────────────────────────────────
// Extension bundles aren't scanned by the app's Tailwind build, so a class
// only this extension names produces no CSS. The panel is api.ui and inline
// styles from api.ui.tokens.
{
  const classed = (tree) => findAll(tree, (e) => e.props.className !== undefined).map((e) => e.props.className);
  const dock = rig({ [`${FILM}.sfStock`]: SLIDE });
  check("the dock panel names no class of its own", classed(dock.render()).length === 0, classed(dock.render()).join(" | "));
  const off = rig({});
  check("nor with no stock picked", classed(off.render()).length === 0);
  const masked = rig({ [`${FILM}.sfStock`]: SLIDE }, {});
  check("nor in a mask", classed(masked.render()).length === 0);
  const bundled = FILM_STOCKS.splice(0);
  try {
    const empty = rig({});
    const view = empty.render();
    const tree = typeof view?.type === "function" ? view.type(view.props) : view;
    check("nor the getting-started view", /not set up/.test(textOf(tree)) && classed(tree).length === 0, classed(tree).join(" | "));
  } finally {
    FILM_STOCKS.push(...bundled);
  }
}
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
  const anys = src.match(/[:<(,|]\s*any\b|\bas any\b|any\[\]/g) ?? [];
  check("the source types its API without any", anys.length === 0, anys.join(" "));
}

I.deactivate();
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL STOCK CHECKS PASS");
process.exit(fails ? 1 : 0);
