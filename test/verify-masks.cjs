// Local-adjustment masks. The film stage runs again inside a mask that holds
// its keys and develops the photo's scene with the mask's settings on top of
// the photo's; Halation and Grain stay the photo's. activate() offers the panel
// in the Masking panel's Adjust tab, owning the film keys it writes, and the
// panel there shows the film controls only: the stock is the photo's, since a
// copy shares the stage's spectral textures. The stand-in host is test/rig.cjs.
const path = require("path");
const { I, FILM, ui, rig, findAll, textOf, sliders, slider } = require(path.join(__dirname, "rig.cjs"));
const { FILM_STOCKS } = require(path.join(__dirname, ".build", "stocks_data.generated.js"));

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) fails++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const STOCK = `${FILM}.sfStock`;
const FILM_KEYS = ["sfExposure", "sfPrintExp", "sfCouplerAmt", "sfContrast", "sfFiltM", "sfFiltY"].map((k) => `${FILM}.${k}`);
const NEGATIVE = FILM_STOCKS.findIndex((s) => s.kind === "negative");

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
    "the film hands its scene, live settings and stock on to its mask copies and effects",
    same(produced.map((v) => [v.name, v.glslType, v.producer]), [
      ["spektrafilmScene", "vec4", undefined],
      ["spektrafilmLive", "vec4", undefined],
      ["spektrafilmFilt", "vec2", undefined],
      ["spektrafilmStock", "float", undefined],
    ]),
  );
  // The core refuses a stage that reads an isv_ name it neither produces nor consumes.
  const read = new Set(((film && film.glsl) || "").replace(/\/\/[^\n]*/g, "").match(/\bisv_\w+/g) || []);
  check("every isv_ name the film reads is one it produces", [...read].every((n) => produced.some((v) => `isv_${v.name}` === n)) && read.size === 4, [...read].join(", "));
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
  check("leaves out the stock picker: a mask develops the photo's stock", findAll(tree, (e) => e.type === ui.Select).length === 0);
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
  const reset = findAll(r.render(), (e) => e.type === ui.Button && textOf(e).trim() === "Reset")[0];
  if (reset) reset.props.onClick({ stopPropagation: () => undefined });
  check("the film section's reset clears the mask's settings back to the photo's", !!reset && r.mask.getState().bag[`${FILM}.sfPrintExp`] === 1 && same(r.develop.getState().paramBag, { [STOCK]: NEGATIVE }));
  check("the reset commits once, to the mask", same(r.commits, ["mask: Spektrafilm"]), r.commits.join(", "));
}
{
  const r = rig({}, {});
  const tree = r.render();
  check("with no stock on the photo a mask has no controls", sliders(tree).length === 0 && findAll(tree, (e) => e.type === ui.Select).length === 0);
  check("and says the photo has no film stock yet", /no film stock/i.test(textOf(tree)), textOf(tree).trim());
}

// ── The same panel in the dock ───────────────────────────────────────────────
{
  const r = rig({ [STOCK]: NEGATIVE });
  const tree = r.render();
  check("in the dock it has the stock picker and all three sections", findAll(tree, (e) => e.type === ui.Select).length === 1 && /Film[\s\S]*Halation[\s\S]*Grain/.test(textOf(tree)));
  const exposure = slider(tree, "Exposure");
  exposure.onChange(0.7);
  exposure.onCommit();
  check("in the dock a film slider writes the photo's bag", r.develop.getState().paramBag[`${FILM}.sfExposure`] === 0.7);
  check("in the dock it commits under the panel's name", same(r.commits, ["Spektrafilm"]), r.commits.join(", "));
}

I.deactivate();
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL MASK CHECKS PASS");
process.exit(fails ? 1 : 0);
