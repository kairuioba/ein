#!/usr/bin/env python3
"""Regenerate the engine mascot sprite sheets in src/assets/mascots/.

    python3 scripts/mascots/generate.py [path/to/claude-artwork.jpg]

Dev-only (needs Pillow + numpy). The output PNGs are committed, so the app and
its build never run this. Every engine gets an original pixel character whose
body comes from the engine's name (a moon for Kimi, a question mark for Qwen,
a codex book for Codex …) — never from a company logo.

Outputs
  mascots.png   full-body sprites, one row per engine, one column per pose,
                72×72 px cells at 1× (scale them up by whole numbers, with
                image-rendering: pixelated)
  busts.png     head-and-shoulders crops for avatars, 4× (224×224 cells),
                one column per engine, downscaled smoothly by the browser
  claude-bust.jpg  the Claude avatar: a crop of the team's own artwork, used
                with the owner's permission (pass its path as the argument)
"""
import pathlib, sys
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from mascots import render, POSES  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "src" / "assets" / "mascots"
KINDS = ["workbuddy", "claude", "codex", "kimi", "qwen", "grok", "hermes", "droid",
         "cursor", "antigravity", "opencode", "pi", "local", "pc"]
POSE_ORDER = ["idle", "work", "wave", "cheer", "think", "point", "run", "scared"]
CELL, BUST = 72, 224


def sheet():
    img = Image.new("RGBA", (CELL * len(POSE_ORDER), CELL * len(KINDS)), (0, 0, 0, 0))
    for r, kind in enumerate(KINDS):
        for c, pose in enumerate(POSE_ORDER):
            img.alpha_composite(render(kind, pose, scale=1), (c * CELL, r * CELL))
    img.save(OUT / "mascots.png", optimize=True)


def busts():
    img = Image.new("RGBA", (BUST * len(KINDS), BUST), (0, 0, 0, 0))
    for i, kind in enumerate(KINDS):
        full = render(kind, "idle", scale=4)              # 288 × 288
        x0, y0, x1, y1 = full.getbbox()
        h = min(y1 - y0, 224)
        crop = full.crop((x0, y0, x1, y0 + h))
        side = max(crop.width, crop.height)
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.alpha_composite(crop, ((side - crop.width) // 2, 0))
        img.alpha_composite(sq.resize((BUST, BUST), Image.NEAREST), (i * BUST, 0))
    img.save(OUT / "busts.png", optimize=True)


def claude_bust(src):
    art = Image.open(src).convert("RGB").crop((405, 104, 725, 330))
    art.resize((272, 192), Image.LANCZOS).save(OUT / "claude-bust.jpg", quality=88)


if __name__ == "__main__":
    assert set(POSE_ORDER) == set(POSES), "pose list drifted from mascots.py"
    OUT.mkdir(parents=True, exist_ok=True)
    sheet()
    busts()
    if len(sys.argv) > 1:
        claude_bust(sys.argv[1])
    print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir() if p.suffix in {".png", ".jpg"})))
