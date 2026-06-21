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
  tiled-atlas trilinear lookup over a log-shaped input — trivially real-time.
- **Switching stocks swaps the LUT texture**, not the shader — no recompile.
- **Halation** is one downsampled separable-blur prepass (only when its amount is
  non-zero). **Grain** is a few ALU ops per pixel.

The film transform runs at the `tone-map` phase on scene-linear `lin` and writes
scene-linear print colour, which SafeLight's display transform then encodes.

> **Use with the default ("Linear") rendering transform.** Selecting AgX/ACES in
> Preferences ▸ Rendering would tone-map *on top of* the baked film look. The
> film stock already is the view transform.

## Baking real film stocks

Out of the box this ships with a single **neutral placeholder** LUT (the image
renders normally). Real stocks come from running the Spektrafilm engine offline:

```bash
# Requires a working Spektrafilm install + numpy.
# 1. Edit STOCKS and wire render_with_spektrafilm() in tools/bake_luts.py.
python tools/bake_luts.py        # writes src/stocks.generated.ts
npm run build                    # bundles the baked LUTs into dist/index.js
```

`bake_luts.py` is the **only** place the GPLv3 Spektrafilm engine is touched — it
runs the simulation on a grid and writes the result as data. SafeLight never
links the engine; it only loads the baked bytes.

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
- **Baked LUT data** is derived from Spektrafilm's film/print profiles, which are
  **CC BY-SA 4.0**. Any stocks you bake and distribute must carry that
  attribution and share-alike. The neutral placeholder LUT is original and
  carries no such obligation.

Spektrafilm © Andrea Volpato — https://github.com/andreavolpato/spektrafilm
