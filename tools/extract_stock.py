#!/usr/bin/env python3
# Extract one film+print stock from the Spektrafilm engine into a self-sufficient
# bundle the GPU stage runs the simulation from — NOT an RGB->RGB look bake. It
# pulls the per-stage spectral primitives, precomputes the parts that are fixed
# per stock (coupler matrix, before-couplers curves, spectral kernels, colour
# matrices), and SELF-VALIDATES by re-running the whole pipeline from the bundle
# alone against the engine's per-stage taps. Exposure / print-exposure / gamma
# stay live (applied analytically), so the result is a simulation, not a frozen
# LUT.
#
# Usage: python tools/extract_stock.py <film> <print> [out.json]

import json
import sys

import numpy as np
import colour

from spektrafilm.runtime.params_builder import init_params, digest_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.runtime.topology import Tap
from spektrafilm.config import STANDARD_OBSERVER_CMFS
from spektrafilm.model.illuminants import standard_illuminant
from spektrafilm.model.couplers import (
    compute_dir_couplers_matrix,
    compute_density_curves_before_dir_couplers,
)
from spektrafilm.utils.morph_curves import apply_print_curves_morph


TC_LUT_SIZE = 64  # downsampled chromaticity LUT (smooth → 64² is ample)


def _mask_spectral(channel_density, base_density):
    """Dye spectra are sub-band (NaN outside); the engine maps NaN→0 light.
    Return (chD with NaN→0, baseD with NaN→+big) so 10**(-density)≈0 there."""
    chD = np.asarray(channel_density, dtype=float)
    baseD = np.asarray(base_density, dtype=float)
    mask = np.isnan(baseD) | np.isnan(chD).any(axis=1)
    return np.nan_to_num(chD, nan=0.0), np.where(mask, 1e6, np.nan_to_num(baseD, nan=0.0))


def _linear_matrix(fn):
    """A linear colour transform as a 3×3 M such that out = inp @ M."""
    return np.asarray(fn(np.eye(3))).reshape(3, 3)


def _resample_tc_lut(tc_lut, size):
    src = np.asarray(tc_lut)
    n = src.shape[0]
    idx = np.linspace(0, n - 1, size)
    x = np.clip(idx, 0, n - 1)
    x0 = np.floor(x).astype(int); x1 = np.minimum(x0 + 1, n - 1); fx = x - x0
    rows = src[x0] * (1 - fx)[:, None, None] + src[x1] * fx[:, None, None]
    out = rows[:, x0] * (1 - fx)[None, :, None] + rows[:, x1] * fx[None, :, None]
    return out  # (size,size,3)


def main():
    if len(sys.argv) < 3:
        print("usage: extract_stock.py <film> <print> [out.json]", file=sys.stderr)
        return 2
    film, prnt = sys.argv[1], sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else f"{film}__{prnt}.json"

    p = digest_params(init_params(film, prnt))
    p.io.input_color_space = "sRGB"; p.io.input_cctf_decoding = False
    p.io.output_color_space = "sRGB"; p.io.output_cctf_encoding = False
    p.camera.auto_exposure = False; p.camera.exposure_compensation_ev = 0.0
    for fld in (p.film_render.grain, p.film_render.halation, p.film_render.glare, p.print_render.glare):
        fld.active = False
    p.film_render.dir_couplers.diffusion_size_um = 0.0
    pipe = SimulationPipeline(p)
    fd, pd = p.film.data, p.print.data

    # ── Stage 1 (expose): chromaticity matrix + tc_lut ───────────────────────
    ref_xy = colour.XYZ_to_xy(_linear_matrix(
        lambda e: colour.RGB_to_XYZ(e, "sRGB", apply_cctf_decoding=False)).sum(0))  # unused placeholder
    from spektrafilm.utils.spectral_upsampling import _illuminant_to_xy
    illu_xy = _illuminant_to_xy(p.film.info.reference_illuminant)
    M_rgb2xyz = _linear_matrix(lambda e: colour.RGB_to_XYZ(
        e, "sRGB", apply_cctf_decoding=False, illuminant=illu_xy, chromatic_adaptation_transform="CAT16"))
    sens_film = np.nan_to_num(10.0 ** np.asarray(fd.log_sensitivity))
    tc_lut = _resample_tc_lut(pipe._lut_service.get_filming_tc_lut(sens_film), TC_LUT_SIZE)

    # ── Stage 2 (develop): normalized curves, coupler matrix, before-couplers ─
    dc_f = np.asarray(fd.density_curves); le_f = np.asarray(fd.log_exposure)
    norm_dc = dc_f - np.nanmin(dc_f, axis=0)
    Mcoup = compute_dir_couplers_matrix(p.film_render.dir_couplers) * p.film_render.dir_couplers.amount
    dc0 = compute_density_curves_before_dir_couplers(
        norm_dc, le_f, Mcoup, positive=(p.film.info.type == "positive"))

    # ── Stage 3 (print-expose): spectral kernel = filtered_illuminant × paper_sens
    chD_f, baseD_f = _mask_spectral(fd.channel_density, fd.base_density)
    lamp = standard_illuminant(p.enlarger.illuminant)
    filt = np.asarray(pipe._enlarger_service.enlarger_filtered_illuminant(lamp))   # (81,)
    print_sens = np.nan_to_num(10.0 ** np.asarray(pd.log_sensitivity))            # (81,3)
    print_kernel = filt[:, None] * print_sens                                     # (81,3)
    factor = float(np.asarray(
        pipe._printing_stage._compute_exposure_factor_midgray(print_sens, filt)).reshape(-1)[0])

    # ── Stage 4 (print-develop): morphed paper curves ────────────────────────
    le_p = np.asarray(pd.log_exposure)
    morphed = np.asarray(apply_print_curves_morph(
        le_p, pd.density_curves_model, p.print_render.density_curves_morph, profile_type=p.print.info.type))

    # ── Stage 5 (scan): spectral kernel = scan_illuminant × CMFs, output matrix
    chD_p, baseD_p = _mask_spectral(pd.channel_density, pd.base_density)
    scan_il = standard_illuminant(p.print.info.viewing_illuminant)
    cmfs = np.asarray(STANDARD_OBSERVER_CMFS[:])
    scan_norm = float(np.sum(scan_il * cmfs[:, 1]))
    scan_kernel = scan_il[:, None] * cmfs                                         # (81,3)
    illum_xyz = np.einsum("k,kl->l", scan_il, cmfs) / scan_norm
    out_illum_xy = colour.XYZ_to_xy(illum_xyz)
    M_xyz2rgb = _linear_matrix(lambda e: colour.XYZ_to_RGB(
        e, colourspace="sRGB", apply_cctf_encoding=False, illuminant=out_illum_xy))

    bundle = {
        "film": film, "print": prnt, "n_wl": int(cmfs.shape[0]),
        "tc_size": TC_LUT_SIZE,
        "le_film": [float(le_f[0]), float(le_f[-1]), int(len(le_f))],
        "le_print": [float(le_p[0]), float(le_p[-1]), int(len(le_p))],
        "M_rgb2xyz": M_rgb2xyz.tolist(),
        "M_xyz2rgb": M_xyz2rgb.tolist(),
        "Mcoup": np.asarray(Mcoup).tolist(),
        "factor": factor, "scan_norm": scan_norm,
        "print_exposure": float(p.enlarger.print_exposure),
        "tex": {
            "tc_lut": tc_lut.tolist(),            # (S,S,3)
            "norm_dc": norm_dc.tolist(),          # (256,3)
            "dc0": dc0.tolist(),                  # (256,3)
            "chD_film": chD_f.tolist(), "baseD_film": baseD_f.tolist(),
            "print_kernel": print_kernel.tolist(),
            "morphed_print": morphed.tolist(),    # (256,3)
            "chD_print": chD_p.tolist(), "baseD_print": baseD_p.tolist(),
            "scan_kernel": scan_kernel.tolist(),
        },
    }

    # ── Self-validation: run the whole pipeline FROM THE BUNDLE vs engine taps ─
    def interp3(x, lo, hi, curves):
        n = curves.shape[0]; t = (x - lo) / (hi - lo) * (n - 1)
        i0 = np.clip(np.floor(t), 0, n - 1).astype(int); i1 = np.minimum(i0 + 1, n - 1); f = np.clip(t - i0, 0, 1)
        o = np.zeros_like(x)
        for c in range(3):
            o[..., c] = curves[i0[..., c], c] * (1 - f[..., c]) + curves[i1[..., c], c] * f[..., c]
        return o

    def tri2quad(xy):
        tx, ty = xy[..., 0], xy[..., 1]
        return np.stack((np.clip((1 - tx) ** 2, 0, 1), np.clip(ty / np.fmax(1 - tx, 1e-10), 0, 1)), -1)

    def bilin(lut, tc):
        S = lut.shape[0]; c = np.clip(tc, 0, 1) * (S - 1)
        x0 = np.floor(c[..., 0]).astype(int); y0 = np.floor(c[..., 1]).astype(int)
        x1 = np.minimum(x0 + 1, S - 1); y1 = np.minimum(y0 + 1, S - 1); fx = c[..., 0] - x0; fy = c[..., 1] - y0
        a = lut[x0, y0]; b = lut[x1, y0]; cc = lut[x0, y1]; d = lut[x1, y1]
        return (a * (1 - fx)[..., None] + b * fx[..., None]) * (1 - fy)[..., None] + (cc * (1 - fx)[..., None] + d * fx[..., None]) * fy[..., None]

    lef0, lef1 = le_f[0], le_f[-1]; lep0, lep1 = le_p[0], le_p[-1]
    def pipeline_from_bundle(rgb):
        xyz = rgb @ M_rgb2xyz; b = np.sum(xyz, -1); xy = xyz[..., :2] / np.fmax(b[..., None], 1e-10)
        raw = bilin(tc_lut, tri2quad(xy)) * b[..., None]
        logf = np.log10(np.fmax(raw, 0) + 1e-10)
        d = interp3(logf, lef0, lef1, norm_dc)
        cmy_f = interp3(logf - d @ Mcoup, lef0, lef1, dc0)
        dspec = np.einsum("ijk,lk->ijl", cmy_f, chD_f) + baseD_f
        rawp = np.einsum("ijl,lm->ijm", 10 ** (-dspec), print_kernel) * factor * p.enlarger.print_exposure
        logp = np.log10(np.fmax(rawp, 0) + 1e-10)
        cmy_p = interp3(logp, lep0, lep1, morphed)
        dspec2 = np.einsum("ijk,lk->ijl", cmy_p, chD_p) + baseD_p
        xyz2 = np.einsum("ijl,lm->ijm", 10 ** (-dspec2), scan_kernel) / scan_norm
        return xyz2 @ M_xyz2rgb  # pre-gamut-compression

    ax = [0.05, 0.184, 0.4, 0.7, 1.0]
    grid = np.array([[r, g, b] for r in ax for g in ax for b in ax]).reshape(1, -1, 3)
    rgb_ref = np.asarray(pipe.process(grid, inject=Tap.RGB_PRE, collect=Tap.RGB_OUT)).reshape(-1, 3)
    rgb_mine = pipeline_from_bundle(grid).reshape(-1, 3)
    err = float(np.abs(rgb_mine - rgb_ref).max())
    bundle["selfcheck_rgb_out_maxerr_pre_gamut"] = err

    with open(out, "w", encoding="utf-8") as fh:
        json.dump(bundle, fh)
    print(f"wrote {out}", file=sys.stderr)
    print(f"SELF-CHECK full pipeline-from-bundle vs engine rgb_out (pre-gamut): max err {err:.4f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
