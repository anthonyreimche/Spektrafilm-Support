# Spektrafilm Support for SafeLight

A [SafeLight](https://github.com/anthonyreimche/SafeLight) extension that runs
[**Spektrafilm**](https://github.com/andreavolpato/spektrafilm) — Andrea
Volpato's physically-based *spectral* simulation of analog photography
(negative → enlarger → print → scan) — **live, per pixel, on the GPU**. Not a
baked LUT: it runs the actual 5-stage spectral pipeline with adjustable exposure
and print exposure.

It adds a **Spektrafilm** panel to the Develop module: pick a film stock, set
Exposure and Print Exposure.

## How it works

Spektrafilm's pipeline is five per-pixel stages: spectral expose → develop
(characteristic curves + DIR couplers) → print-expose (spectral, through the
enlarger) → print-develop → scan (spectral → XYZ → RGB). This extension runs all
five **live in a GLSL processing stage** ([src/film-glsl.ts](src/film-glsl.ts)):

- The expensive spectral data (the Hanatos chromaticity LUT, dye-density and
  sensitivity spectra, characteristic curves, colour matrices) is **extracted
  from the engine per stock** and uploaded as 3 float (`rgba16f`) textures + a
  GLSL const block. This is *not* an RGB→RGB look bake — the per-pixel pipeline
  is run in full, so **exposure and print exposure stay live**.
- The two spectral stages integrate over 81 wavelength bins per pixel; the rest
  is matrix + 1D-curve + chromaticity-LUT lookups.
- Each stage was validated to ~0 error against the engine's per-stage taps
  (`tools/extract_stock.py` self-checks the whole pipeline from the bundle).

The stage runs at the `tone-map` phase on scene-linear `lin` and writes
scene-linear print colour.

> **Select the "Spektrafilm" rendering transform** (Preferences ▸ Rendering).
> The extension registers it — a plain encode with the RAW base curve off — as
> the correct view transform: the film stock *is* the tone rendering, so AgX/ACES
> would tone-map on top of it.

## Bundled film stocks

The picker ships seven stocks:

| Stock | Film → Print |
|---|---|
| Kodak Portra 400 | kodak_portra_400 → kodak_portra_endura |
| Kodak Portra 160 | kodak_portra_160 → kodak_portra_endura |
| Kodak Ektar 100 | kodak_ektar_100 → kodak_supra_endura |
| Kodak Gold 200 | kodak_gold_200 → kodak_endura_premier |
| Kodak Ultramax 400 | kodak_ultramax_400 → kodak_supra_endura |
| Fujifilm Pro 400H | fujifilm_pro_400h → kodak_portra_endura |
| Kodak Vision3 250D | kodak_vision3_250d → kodak_2383 (cinema print) |

## Adding your own stocks

Want a different film/print combo? Regenerate the data from the engine.
SafeLight never links the GPLv3 engine — the extraction runs offline and only the
extracted spectral data ships.

**1. Install Spektrafilm** from <https://github.com/andreavolpato/spektrafilm>.
The whole dependency set is pip-installable with wheels on Python 3.13 (numpy,
scipy, colour-science, scikit-image, numba, OpenImageIO, rawpy, exiv2, lensfunpy,
pyfftw); skip the GUI extras (PySide6/napari). List what's available with
`spektrafilm-lut list film` / `list print`.

**2. Edit the `CURATED` list** in [tools/extract_stock.py](tools/extract_stock.py)
(film slug, print slug, display name).

**3. Regenerate + rebuild:**

```bash
python tools/extract_stock.py --emit   # runs the engine → src/stocks_data.generated.ts
npm run build                          # bundles the data into dist/index.js
```

`--emit` self-checks each stock (the whole pipeline re-run from the packed data
vs the engine). Commit `dist/index.js` and `src/stocks_data.generated.ts`, then
install/reload.

## Status / limitations

- Gamut compression uses ACES RGC as a stand-in for the engine's perceptual
  `cam16ucs` — the spectral stages are exact; only extreme out-of-gamut colours
  differ slightly.
- Enlarger filtration is currently fixed at the profile default (baked into the
  print kernel); halation and grain are not yet re-added as prepasses.

## Installation

Search for **Spektrafilm Support** in SafeLight's Extensions panel, or paste the
repo URL into the panel.

## Development

```bash
npm install
npm run build      # → dist/index.js   (commit this — installs load the prebuilt bundle)
npm run typecheck  # tsc --noEmit
```

Requires the host's **rgba16f stage-texture API** (`api.setStageTexture` with
float textures) — hence `minAppVersion`.

## Licensing

- **This extension's code: GPL-3.0-or-later** ([LICENSE](LICENSE)) — it implements
  the Spektrafilm pipeline and its extractor drives the GPLv3 engine.
- **Bundled spectral data** (`src/stocks_data.generated.ts`) is **CC BY-SA 4.0**:
  extracted by Spektrafilm 0.3.4 from profiles © 2026 Andrea Volpato and repacked
  (float textures + GLSL constants) for this extension. Under ShareAlike,
  redistributions must keep the CC BY-SA 4.0 licence and this attribution.
  <https://creativecommons.org/licenses/by-sa/4.0/>

Spektrafilm © Andrea Volpato — https://github.com/andreavolpato/spektrafilm
