#!/usr/bin/env python3
"""Figure 2 of the preprint: how defects 1 and 4 changed the statistic that was
fed to the skewness transform of the D'Agostino-Pearson test.

    python3 make-defect-factors.py        # writes defect-factors.png here

Needs numpy and matplotlib. Everything plotted is a closed form, so the figure
can be checked by hand (the three factors are quoted in section 2.2.5):

    defect 1 alone    ((n - 1) / n)^(3/2)              sample SD in the moments
    defect 4 alone    sqrt(n (n - 1)) / (n - 2)        adjusted G1 in the transform
    together          (n - 1)^2 / (n (n - 2))          = 1 + 1 / (n (n - 2))

Colours are the first three slots of the reference categorical palette of the
dataviz skill (blue, orange, aqua), which pass its lightness, chroma, CVD and
normal-vision checks; aqua is under 3:1 on white, so every line is also labelled
at its end.
"""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D

SURFACE = "#ffffff"
INK, INK2 = "#0b0b0b", "#52514e"
GRID, AXIS = "#e1e0d9", "#c3c2b7"
NET, D1, D4 = "#2a78d6", "#eb6834", "#1baf7a"  # categorical slots 1, 2, 3

plt.rcParams.update({
    "font.family": "Liberation Sans",
    "mathtext.fontset": "custom",
    "mathtext.rm": "Liberation Sans",
    "mathtext.it": "Liberation Sans:italic",
    "mathtext.bf": "Liberation Sans:bold",
    "mathtext.fallback": "stix",
    "text.color": INK2,
    "axes.labelcolor": INK2,
    "xtick.color": INK2,
    "ytick.color": INK2,
})


def factors(n):
    n = np.asarray(n, dtype=float)
    d1 = ((n - 1) / n) ** 1.5
    d4 = np.sqrt(n * (n - 1)) / (n - 2)
    return d1, d4, d1 * d4


n = np.linspace(8, 40, 600)
f1, f4, net = factors(n)
assert np.allclose(net, 1 + 1 / (n * (n - 2)))  # the closed form quoted in the text

N0, N1 = 8, 40
fig, ax = plt.subplots(figsize=(6.2, 3.1), dpi=300, facecolor=SURFACE)
fig.subplots_adjust(left=0.105, right=0.875, top=0.835, bottom=0.175)
ax.set_facecolor(SURFACE)

ax.axhline(1.0, color=AXIS, lw=0.9, zorder=1)
ax.yaxis.grid(True, color=GRID, lw=0.6, zorder=0)
ax.set_axisbelow(True)
for side in ("top", "right", "left"):
    ax.spines[side].set_visible(False)
ax.spines["bottom"].set_color(AXIS)
ax.tick_params(axis="y", length=0, labelsize=7.5, pad=4)
ax.tick_params(axis="x", length=3, color=AXIS, labelsize=7.5)

# One point per line at n = 10 (the size used in the text) and one at the right
# end where the line is named; each carries a 2 px ring in the surface colour.
series = [  # name at the end, colour, curve, label offset (dx, dy) at n = 10, anchor
    ("defect 4", D4, f4, (0.55, 0.020), "bottom"),
    ("net", NET, net, (0.55, 0.020), "bottom"),
    ("defect 1", D1, f1, (0.55, -0.014), "top"),
]
for name, colour, curve, (dx, dy), va in reversed(series):
    ax.plot(n, curve, color=colour, lw=1.6, solid_capstyle="round", zorder=3)
for name, colour, curve, (dx, dy), va in series:
    y10 = float(np.interp(10, n, curve))
    y_end = float(curve[-1])
    ax.plot([10], [y10], "o", ms=5.2, mfc=colour, mec=SURFACE, mew=1.5, zorder=5)
    ax.text(10 + dx, y10 + dy, f"{y10:.3f}" if abs(y10 - 1) > 0.05 else f"{y10:.4f}",
            ha="left", va=va, fontsize=7.5, color=INK2, zorder=6)
    ax.plot([N1], [y_end], "o", ms=5.2, mfc=colour, mec=SURFACE, mew=1.5, zorder=5, clip_on=False)
    ax.text(N1 + 1.3, y_end, name, ha="left", va="center", fontsize=7.8, color=INK, clip_on=False)

ax.text(N0 + 0.25, 0.992, "1 = no error", ha="left", va="top", fontsize=7.5, color=INK2, style="italic")

ax.set_xlim(N0 - 0.5, N1)
ax.set_ylim(0.78, 1.30)
ax.set_xticks([8, 10, 20, 30, 40])
ax.set_yticks([0.8, 0.9, 1.0, 1.1, 1.2, 1.3])
ax.set_yticklabels(["0.8", "0.9", "1.0", "1.1", "1.2", "1.3"])
ax.set_xlabel(r"Sample size $n$", fontsize=8, labelpad=4)
ax.set_ylabel(r"Factor on $\sqrt{b_1}$, the input to the skewness transform", fontsize=8, labelpad=6)

handles = [
    Line2D([], [], color=NET, lw=1.6, solid_capstyle="round"),
    Line2D([], [], color=D1, lw=1.6, solid_capstyle="round"),
    Line2D([], [], color=D4, lw=1.6, solid_capstyle="round"),
]
labels = [
    "Net effect, defects 1 and 4 together",
    "Defect 1 alone: sample SD in the moments",
    "Defect 4 alone: adjusted $G_1$ in the transform",
]
fig.legend(handles, labels, loc="upper left", bbox_to_anchor=(0.095, 1.0), ncol=1,
           frameon=False, fontsize=7.5, handlelength=1.8, handletextpad=0.6,
           labelspacing=0.25, borderaxespad=0.2)

out = Path(__file__).with_name("defect-factors.png")
fig.savefig(out, dpi=300, facecolor=SURFACE)
print("wrote", out)
