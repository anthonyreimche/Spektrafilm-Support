#!/usr/bin/env python3
# Generate black-and-white film + paper profiles for the Spektrafilm engine.
#
# The engine is a 3-dye (CMY) subtractive colour model with no native B&W path.
# We model a silver B&W material as the degenerate case the colour pipeline
# already handles exactly: THREE IDENTICAL panchromatic layers + a spectrally
# NEUTRAL image dye. Identical layers ⇒ the three "raw" exposures are equal at
# every pixel ⇒ neutral density everywhere ⇒ a perfectly grey output, with no
# changes to the engine, the extractor, or the GLSL. What survives is the real
# physics that makes B&W look like B&W:
#   • the SPECTRAL SENSITIVITY decides how each colour becomes a grey tone (red
#     lips dark, blue sky light; orthochromatic stocks render red near-black) —
#     true spectral B&W;
#   • the film + paper CHARACTERISTIC CURVES decide tone and contrast (the grade);
#   • the neg→enlarger→paper→scan path gives the real darkroom tonal inversion.
#
# The curves are DATASHEET-DERIVED PARAMETRIC MODELS (sensitisation class +
# published gamma/toe/shoulder per stock), authored by hand for shape fidelity —
# NOT measured spectral traces. They live here as code so they are reproducible
# and easy to tune. The print auto-balances each film's midgray, so all stocks
# share one normal-grade paper and differ by sensitivity (colour→grey) and curve
# (contrast); ISO labels are descriptive (speed is not separately modelled).
# Output JSON: tools/bw_profiles/*.json, loaded by tools/extract_stock.py.
#
#   python tools/make_bw_profiles.py        # writes tools/bw_profiles/*.json

import json
import os
from math import erf, sqrt

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "bw_profiles")
ENGINE_PROFILES = (
    "D:/Repositories/Safelight Project/spektrafilm-engine/src/spektrafilm/data/profiles"
)

WL = np.arange(380.0, 781.0, 5.0)  # 81 bins, 5 nm — matches the engine grid
_ERF = np.vectorize(erf)


def _g(mu, sig):
    return np.exp(-0.5 * ((WL - mu) / sig) ** 2)


def _hicut(edge, w):
    return 1.0 / (1.0 + np.exp((WL - edge) / w))


def _locut(edge, w):
    return 1.0 / (1.0 + np.exp((edge - WL) / w))


def _phi(z):
    return 0.5 * (1.0 + _ERF(z / sqrt(2.0)))


def _softplus(t, k):
    return np.log1p(np.exp(np.clip(k * t, -30.0, 30.0))) / k


def _norm_log_sensitivity(lin, peak_log10=-0.3, floor=-5.0):
    lin = np.clip(lin, 1e-6, None)
    log_s = np.log10(lin)
    log_s += peak_log10 - log_s.max()
    return np.maximum(log_s, floor).tolist()


# ── Spectral sensitivities (relative; shape drives colour→grey rendering) ──────
def pan_sensitivity(green=0.50, red=0.72, red_cut=662):
    """Classic panchromatic emulsion: native blue silver-halide sensitivity plus
    green and red dye sensitisers with the characteristic red cut-off."""
    s = 0.95 * _g(445, 42) + green * _g(550, 34) + red * _g(632, 26)
    s *= _hicut(red_cut, 7) * _locut(386, 7)
    return _norm_log_sensitivity(s)


def tgrain_sensitivity():
    """Modern tabular-grain emulsion: smoother, more even response with red
    sensitivity extended toward ~690 nm."""
    s = 0.9 * _g(450, 46) + 0.62 * _g(545, 40) + 0.70 * _g(642, 34)
    s *= _hicut(688, 8) * _locut(384, 7)
    return _norm_log_sensitivity(s)


def ortho_sensitivity():
    """Orthochromatic emulsion: blue/green sensitive, RED-BLIND (cut ~600 nm).
    Renders reds near-black and blue skies very light — the dramatic ortho look."""
    s = 1.0 * _g(440, 40) + 0.6 * _g(530, 34)
    s *= _hicut(600, 10) * _locut(384, 7)
    return _norm_log_sensitivity(s)


# ── Characteristic curves ─────────────────────────────────────────────────────
# Paper constants, calibrated against the zero-base film curves so a neutral
# midgray (0.184) lands at output ~0.19 with clean blacks and a normal grade.
# MU shifts lightness, SIGMA the grade (smaller=harder), DMAX the maximum black.
# (Films carry no Dmin in their curve — see film note below — so a single paper
# calibration holds for every stock; they differ by contrast and sensitivity.)
PAPER_MU = 0.18
PAPER_DMAX = 2.05
PAPER_SIGMA = 0.34


def film_density_curve(le, base=0.0, gamma=0.61, toe=-2.05, shoulder=1.75, k=3.2):
    """D–logE as NET density above base (Dmin=0): a smooth toe→straight→shoulder
    with slope `gamma` between `toe` and `shoulder`. Keeping Dmin at 0 (film
    base+fog lives in base_density instead) makes the engine's midgray print
    balance land identically for every stock, so they differ only by contrast
    (gamma), toe/shoulder shape and spectral sensitivity — not gross exposure."""
    return base + gamma * (_softplus(le - toe, k) - _softplus(le - shoulder, k))


def paper_density_curve(le, mu=PAPER_MU, dmax=PAPER_DMAX, sigma=PAPER_SIGMA, base=0.04):
    return base + dmax * _phi((le - mu) / sigma)


def paper_curves_model(mu=PAPER_MU, dmax=PAPER_DMAX, sigma=PAPER_SIGMA):
    """density_curves_model the print-develop stage bakes from: three identical
    sublayers summing to one Dmax·Φ sigmoid per (identical) channel."""
    centers = [[mu, mu, mu] for _ in range(3)]
    amplitudes = [[dmax / 3.0] * 3 for _ in range(3)]
    sigmas = [[sigma] * 3 for _ in range(3)]
    return {"model_type": "cdfs", "centers": centers, "amplitudes": amplitudes, "sigmas": sigmas}


# ── Stock catalogue ───────────────────────────────────────────────────────────
# sens: callable → (81,) log10 sensitivity. curve: film_density_curve kwargs.
FILMS = [
    dict(stock="kodak_tri_x_400", name="Kodak Tri-X 400", antihalation="strong",
         sens=lambda: pan_sensitivity(),
         curve=dict(base=0.0, gamma=0.61, toe=-2.05, shoulder=1.75)),
    dict(stock="ilford_hp5_plus_400", name="Ilford HP5 Plus 400", antihalation="strong",
         sens=lambda: pan_sensitivity(green=0.55, red=0.68),
         curve=dict(base=0.0, gamma=0.57, toe=-2.20, shoulder=1.65)),
    dict(stock="ilford_fp4_plus_125", name="Ilford FP4 Plus 125", antihalation="strong",
         sens=lambda: pan_sensitivity(green=0.52, red=0.66),
         curve=dict(base=0.0, gamma=0.62, toe=-2.10, shoulder=1.90)),
    dict(stock="kodak_tmax_100", name="Kodak T-Max 100", antihalation="strong",
         sens=tgrain_sensitivity,
         curve=dict(base=0.0, gamma=0.60, toe=-2.25, shoulder=2.05)),
    dict(stock="kodak_tmax_400", name="Kodak T-Max 400", antihalation="strong",
         sens=tgrain_sensitivity,
         curve=dict(base=0.0, gamma=0.585, toe=-2.10, shoulder=1.90)),
    dict(stock="fujifilm_acros_100", name="Fujifilm Neopan Acros 100", antihalation="strong",
         sens=lambda: pan_sensitivity(green=0.55, red=0.66, red_cut=672),
         curve=dict(base=0.0, gamma=0.62, toe=-2.20, shoulder=1.95)),
    dict(stock="ilford_ortho_plus_80", name="Ilford Ortho Plus 80", antihalation="strong",
         sens=ortho_sensitivity,
         curve=dict(base=0.0, gamma=0.70, toe=-1.85, shoulder=1.55)),
    dict(stock="ilford_delta_3200", name="Ilford Delta 3200", antihalation="weak",
         sens=lambda: pan_sensitivity(green=0.58, red=0.72, red_cut=678),
         curve=dict(base=0.0, gamma=0.52, toe=-2.45, shoulder=1.60)),
]


# ── Assembly ──────────────────────────────────────────────────────────────────
def _triplicate(col):
    return np.column_stack([np.asarray(col)] * 3).tolist()


def _metadata(name):
    return {
        "version": "bw-1",
        "copyright": f"B&W profile '{name}' (c) 2026 Anthony Reimche, GPL-3.0-or-later.",
        "created": "2026-06-29",
        "license": (
            "Datasheet-derived parametric B&W model authored for the Spektrafilm "
            "Support extension (GPL-3.0-or-later). Models a neutral silver emulsion "
            "as three identical layers + neutral dye in the spektrafilm engine "
            "(https://github.com/andreavolpato/spektrafilm). NOT a measured spectral "
            "trace; sensitivity and characteristic-curve SHAPES follow published "
            "Kodak/Ilford/Fuji datasheet classes. See tools/make_bw_profiles.py."
        ),
        "citation": "Spektrafilm engine by Andrea Volpato — https://github.com/andreavolpato/spektrafilm",
        "datasource": "Hand-modelled from published B&W film/paper datasheet curve shapes.",
    }


def _zeros_layers(n):
    return np.zeros((n, 3, 3)).tolist()


def _empty_model():
    return {
        "model_type": "cdfs",
        "centers": [[0.0] * 3 for _ in range(3)],
        "amplitudes": [[0.0] * 3 for _ in range(3)],
        "sigmas": [[1.0] * 3 for _ in range(3)],
    }


def build_film(spec):
    t = json.load(open(os.path.join(ENGINE_PROFILES, "kodak_portra_400.json")))
    le = np.asarray(t["data"]["log_exposure"], float)
    d = t["data"]
    d["log_sensitivity"] = _triplicate(spec["sens"]())
    d["channel_density"] = (np.ones((81, 3)) / 3.0).tolist()   # neutral dye, 3 layers sum to 1·D
    # Film support absorption — held constant so the print auto-balance keeps a
    # CONSISTENT midgray across stocks (per-film fog already lives in the curve's
    # `base`; stocks then differ by contrast/sensitivity, not gross exposure).
    d["base_density"] = np.full(81, 0.10).tolist()
    d["midscale_neutral_density"] = np.full(81, 0.6).tolist()  # informational only
    d["density_curves"] = _triplicate(film_density_curve(le, **spec["curve"]))
    d["density_curves_layers"] = _zeros_layers(le.size)        # unused (grain off in extractor)
    d["hanatos2025_adaptation_window_params"] = []             # tc_lut built straight from sensitivity
    d["hanatos2025_adaptation_surface_params"] = []
    d["density_curves_model"] = _empty_model()                 # unused in film develop; kept valid
    t["info"].update(
        stock=spec["stock"], name=spec["name"], type="negative", support="film",
        stage="filming", use="still", antihalation=spec["antihalation"], target_print=None,
        channel_model="bw", densitometer="status_M",
        reference_illuminant="D55", viewing_illuminant="D50",
    )
    t["metadata"] = _metadata(spec["name"])
    _write(spec["stock"], t)


def build_paper():
    t = json.load(open(os.path.join(ENGINE_PROFILES, "kodak_portra_endura.json")))
    le = np.asarray(t["data"]["log_exposure"], float)
    d = t["data"]
    d["log_sensitivity"] = _triplicate(
        _norm_log_sensitivity((1.0 * _g(420, 26) + 0.35 * _g(458, 28)) * _hicut(500, 12) * _locut(362, 8))
    )
    d["channel_density"] = (np.ones((81, 3)) / 3.0).tolist()   # neutral black image
    d["base_density"] = np.full(81, 0.04).tolist()             # bright neutral paper white
    d["midscale_neutral_density"] = np.full(81, 0.7).tolist()
    d["density_curves"] = _triplicate(paper_density_curve(le))
    d["density_curves_layers"] = _zeros_layers(le.size)
    d["hanatos2025_adaptation_window_params"] = []
    d["hanatos2025_adaptation_surface_params"] = []
    d["density_curves_model"] = paper_curves_model()
    t["info"].update(
        stock="bw_enlarging_paper", name="B&W Enlarging Paper (Grade 2½)", type="negative",
        support="paper", stage="printing", use="still", antihalation="strong", target_print=None,
        channel_model="bw", densitometer="status_A",
        reference_illuminant="TH-KG3", viewing_illuminant="D50",
    )
    t["metadata"] = _metadata("B&W Enlarging Paper")
    _write("bw_enlarging_paper", t)


def _write(stock, profile):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, stock + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2)
    print(f"wrote {path}")


if __name__ == "__main__":
    for spec in FILMS:
        build_film(spec)
    build_paper()
