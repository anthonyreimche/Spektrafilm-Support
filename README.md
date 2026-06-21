# Spektrafilm Support for SafeLight

A [SafeLight](https://github.com/anthonyreimche/SafeLight) extension that brings
the look of [**Spektrafilm**](https://github.com/andreavolpato/spektrafilm) —
Andrea Volpato's physically-based *spectral* simulation of analog photography
(negative → enlarger → print → scan) — into SafeLight as a **real-time GPU
stage**, with halation and grain.

It adds a **Spektrafilm** panel to the Develop module: pick a film stock, set
Print Exposure, Halation and Grain.

## How it stays fast

Spektrafilm's spectral pipeline is expensive: it reconstructs a spectrum per
pixel, exposes a virtual emulsion with measured spectral sensitivities, develops
dye densities (with couplers), prints through a virtual enlarger and scans the
print. None of that runs per frame here.

- **The colour core is baked offline into a 3D LUT** (`tools/bake_luts.py`) and
  uploaded to the GPU once per stock. The per-frame hot path is a single
  tiled-atlas trilinear lookup over an sRGB-encoded input — trivially real-time.
- **Switching stocks swaps the LUT texture**, not the shader — no recompile.
- **Halation** is one downsampled separable-blur prepass (only when its amount is
  non-zero). **Grain** is a few ALU ops per pixel.

The film transform runs at the `tone-map` phase on scene-linear `lin` and writes
scene-linear print colour, which SafeLight's display transform then encodes.

> **Select the "Spektrafilm" rendering transform** (Preferences ▸ Rendering).
> The extension registers it — a plain encode with the RAW base curve off — as
> the correct view transform for the film stocks. Selecting AgX/ACES instead
> would tone-map *on top of* the baked film look; the film stock already is the
> tone rendering.

## Bundled film stocks

Out of the box the picker includes **Neutral** (a pass-through identity) plus
seven stocks baked from Spektrafilm and shipped with the extension:

| Stock | Film → Print |
|---|---|
| Kodak Portra 400 | kodak_portra_400 → kodak_portra_endura |
| Kodak Portra 160 | kodak_portra_160 → kodak_portra_endura |
| Kodak Ektar 100 | kodak_ektar_100 → kodak_supra_endura |
| Kodak Gold 200 | kodak_gold_200 → kodak_endura_premier |
| Kodak Ultramax 400 | kodak_ultramax_400 → kodak_supra_endura |
| Fujifilm Pro 400H | fujifilm_pro_400h → kodak_portra_endura |
| Kodak Vision3 250D | kodak_vision3_250d → kodak_2383 (cinema print) |

These LUTs are CC BY-SA 4.0 (see Licensing). Select the **Spektrafilm** rendering
transform when using them.

## Baking your own stocks

Want a different film/print combo than the bundled set? Bake it yourself.
SafeLight never links the GPLv3 engine — it only loads the baked LUT bytes.

**1. Install Spektrafilm** from <https://github.com/andreavolpato/spektrafilm>.
The full dependency set is pip-installable with wheels (numpy, scipy,
colour-science, scikit-image, numba, OpenImageIO, rawpy, exiv2, lensfunpy,
pyfftw) — only the GUI extras (PySide6/napari) are heavy and the LUT path
doesn't need them. List what's available:

```bash
spektrafilm-lut list film     # e.g. kodak_portra_400, kodak_ektar_100, …
spektrafilm-lut list print    # e.g. kodak_portra_endura, kodak_2383, …
```

**2. Bake each stock as a 33³ .cube with sRGB input + output** (this is what the
extension's shader expects):

```bash
spektrafilm-lut build --film kodak_portra_400 --print kodak_portra_endura \
  --input srgb --output srgb --resolution 33 --out ./baked
# repeat for each film/print combination you want
```

> **Input/output must be `srgb` and resolution `33`** — the shader sRGB-encodes
> the scene-linear input before the lookup and the atlas is fixed at 33³. Other
> encodings/sizes won't line up. (A log input like V-Log could preserve more
> highlight latitude later, but needs a matching shaper change + calibration.)

**3. Convert the .cube bundles to the extension's atlas** and rebuild:

```bash
node tools/cube_to_stocks.mjs ./baked   # → src/stocks.generated.ts
npm run build                           # bundles the LUTs into dist/index.js
```

Each `.cube` becomes one stock (id = filename, name = prettified). Rename the
`.cube` files first if you want friendlier names in the picker. Commit
`dist/index.js` and `src/stocks.generated.ts`, then install/reload.

## Installation

Search for **Spektrafilm Support** in SafeLight's Extensions panel, or install
manually by pasting the repo URL into the Extensions panel.

## Development

```bash
npm install
npm run build      # → dist/index.js
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
```

> `dist/index.js` must be committed. SafeLight installs extensions by cloning the
> repo and loading the prebuilt bundle directly — it does not run a build step.

This extension requires the host's **stage-texture API** (`api.setStageTexture`)
and the LUT-binding path in the processing-stage framework — hence
`minAppVersion`.

## Licensing

- **This extension's code: GPL-3.0-or-later.** See [LICENSE](LICENSE). It is GPL
  because it implements the Spektrafilm look and its bake tool drives the GPLv3
  Spektrafilm engine.
- **Bundled LUT data** (`src/stocks.generated.ts`) is **CC BY-SA 4.0**: it was
  generated by Spektrafilm 0.3.4 from profiles © 2026 Andrea Volpato, then
  reformatted (3D `.cube` → tiled rgba8 atlas, base64) for this extension. Under
  ShareAlike, redistributions of this data must keep the CC BY-SA 4.0 license and
  this attribution. License: <https://creativecommons.org/licenses/by-sa/4.0/>.
  The **Neutral** identity LUT is original to this extension and carries no such
  obligation.

Spektrafilm © Andrea Volpato — https://github.com/andreavolpato/spektrafilm
