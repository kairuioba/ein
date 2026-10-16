# Original pixel mascots for each engine, drawn in the rubber-hose pixel-cartoon style of the user's reference.
# Bodies come from each company's name / meaning (moon, question mark, Martian, codex book, ...), never from logos.
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont

S, H = 72, 8
N = S * H
T, BODY, BODY2, DET, EW, EB, LIMB, GLOVE, SHOE, ACC, ACC2, FX, LINE = range(13)
NL = 13
WEIGHT = np.array([1, 1, 1.2, 2.6, 2.0, 2.6, 1.3, 1.4, 1.2, 1.6, 1.6, 1.8, 2.8])

def hx(h):
    h = h.lstrip("#"); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
def shade(c, f):
    return tuple(max(0, min(255, round(v * f))) for v in c)
def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

class Canvas:
    def __init__(self):
        self.im = Image.new("L", (N, N), T)
        self.d = ImageDraw.Draw(self.im)
    def P(self, pts):
        return [(x * H, y * H) for x, y in pts]
    def poly(self, pts, lab):
        self.d.polygon(self.P(pts), fill=lab)
    def ell(self, cx, cy, rx, ry, lab):
        self.d.ellipse([(cx - rx) * H, (cy - ry) * H, (cx + rx) * H, (cy + ry) * H], fill=lab)
    def rect(self, x0, y0, x1, y1, lab, r=0):
        if r:
            self.d.rounded_rectangle([x0 * H, y0 * H, x1 * H, y1 * H], radius=r * H, fill=lab)
        else:
            self.d.rectangle([x0 * H, y0 * H, x1 * H, y1 * H], fill=lab)
    def line(self, pts, lab, w):
        pp = self.P(pts)
        self.d.line(pp, fill=lab, width=int(w * H), joint="curve")
        for (x, y) in pp:
            r = w * H / 2; self.d.ellipse([x - r, y - r, x + r, y + r], fill=lab)
    def text(self, s, x, y, size, lab, font="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        f = ImageFont.truetype(font, int(size * H))
        self.d.text((x * H, y * H), s, font=f, fill=lab)

def limb(cv, pts, w=2.2):
    cv.line(pts, LINE, w + 2.0); cv.line(pts, LIMB, w)

def glove(cv, x, y, r=3.4):
    cv.ell(x, y, r + 1, r + 1, LINE); cv.ell(x, y, r, r, GLOVE)
    cv.ell(x - r * .8, y - r * .5, 1.6, 1.6, LINE); cv.ell(x - r * .8, y - r * .5, 1.0, 1.0, GLOVE)

def shoe(cv, x, y, flip=1):
    cv.ell(x + 2.2 * flip, y + .6, 5.4, 3.4, LINE); cv.ell(x + 2.2 * flip, y + .4, 4.4, 2.5, SHOE)

def eye(cv, x, y, w=3.2, h=4.2, look=(.5, .5), glow=False):
    cv.ell(x, y, w + 1, h + 1, LINE); cv.ell(x, y, w, h, EW)
    if not glow:
        cv.ell(x + look[0], y + look[1], w * .62, h * .66, EB)
        cv.ell(x + look[0] - .8, y + look[1] - 1.2, .9, .9, EW)

POSES = {   # (left hand dx,dy), (right hand dx,dy) relative to shoulders; legs spread
 "idle": ((-5, 10), (5, 10), 0), "wave": ((-5, 10), (6, -12), 0), "cheer": ((-7, -11), (7, -11), 1),
 "think": ((5, -8), (5, 10), 0), "point": ((-5, 10), (13, -2), 0), "run": ((-8, 3), (7, 8), 3), "work": ((6, 4), (-6, 4), 0),
 "scared": ((-6, -10), (6, -10), 2),
}

def figure(kind, pose="idle"):
    cv = Canvas()
    G = GEOM[kind]
    (lx, ly), (rx, ry), legs = POSES[pose]
    sl, sr, hl, hr = G["shoulders"][0], G["shoulders"][1], G["hips"][0], G["hips"][1]
    lx = max(lx, 6 - sl[0]); rx = min(rx, 66 - sr[0])          # keep hands inside the 72 px sprite
    # legs behind the body
    if G.get("legs", True):
        foot_y = G.get("foot_y", 64)
        limb(cv, [hl, (hl[0] - 1 - legs, (hl[1] + foot_y) / 2), (hl[0] - 2 - legs, foot_y)])
        limb(cv, [hr, (hr[0] + 1 + legs, (hr[1] + foot_y) / 2), (hr[0] + 2 + legs, foot_y)])
        shoe(cv, hl[0] - 2 - legs, foot_y + 1, -1); shoe(cv, hr[0] + 2 + legs, foot_y + 1, 1)
    # arms behind for poses that cross the body; otherwise drawn after body
    G["draw"](cv)
    el = (sl[0] + lx * .45 - 2, sl[1] + ly * .55)
    er = (sr[0] + rx * .45 + 2, sr[1] + ry * .55)
    if G.get("block"):          # block arms with square fists (the brick golem)
        for s_, e_, h_ in ((sl, el, (sl[0] + lx, sl[1] + ly)), (sr, er, (sr[0] + rx, sr[1] + ry))):
            cv.line([s_, e_, h_], LINE, 7.8); cv.line([s_, e_, h_], LIMB, 5.6)
            cv.rect(h_[0] - 4.4, h_[1] - 4.4, h_[0] + 4.4, h_[1] + 4.4, LINE, 1); cv.rect(h_[0] - 3.4, h_[1] - 3.4, h_[0] + 3.4, h_[1] + 3.4, GLOVE, 1)
            cv.line([(h_[0] - 3.2, h_[1] - .4), (h_[0] + 3.2, h_[1] - .4)], DET, .7)
    else:
        limb(cv, [sl, el, (sl[0] + lx, sl[1] + ly)]); glove(cv, sl[0] + lx, sl[1] + ly)
        limb(cv, [sr, er, (sr[0] + rx, sr[1] + ry)]); glove(cv, sr[0] + rx, sr[1] + ry)
    if pose == "scared":
        for (x, y) in [(G["eyes"][0][0] - 9, G["eyes"][0][1] - 8), (G["eyes"][1][0] + 9, G["eyes"][1][1] - 6)]:
            cv.ell(x, y, 1.6, 2.4, FX)
    return cv.im

# ---------------------------------------------------------------- bodies (sprite coordinates, 72 x 72)
def b_golem(cv):
    """Brick golem after the user's own artwork (authorised for the Claude engine): orange bricks, dark visor, two hot slanted eyes."""
    # legs and feet
    for x0 in (22, 38):
        cv.rect(x0, 49.5, x0 + 12, 63.5, LINE); cv.rect(x0 + 1, 50, x0 + 11, 63, BODY)
        cv.line([(x0 + 1, 56.5), (x0 + 11, 56.5)], DET, .8)
    for x0 in (19.5, 36.5):
        cv.rect(x0, 62, x0 + 16, 68.5, LINE, 1); cv.rect(x0 + 1, 63, x0 + 15, 67.5, SHOE, 1)
    cv.rect(21, 45.5, 51, 50.5, LINE); cv.rect(22, 46, 50, 50, BODY2)
    # torso with brick seams, shoulder pads
    cv.rect(17, 25.5, 55, 47, LINE, 1); cv.rect(18, 26.5, 54, 46, BODY)
    cv.line([(18, 36), (54, 36)], DET, .8)
    for (x, y0, y1) in [(29, 26.5, 36), (43, 26.5, 36), (36, 36, 46)]:
        cv.line([(x, y0), (x, y1)], DET, .8)
    for x0 in (11, 50.5):
        cv.rect(x0, 25, x0 + 10.5, 36, LINE, 1); cv.rect(x0 + 1, 26, x0 + 9.5, 35, BODY2, 1)
    # head: ear blocks, brick head, visor, eyes
    for x0 in (17.5, 50):
        cv.rect(x0, 9, x0 + 4.5, 19.5, LINE); cv.rect(x0 + .8, 10, x0 + 3.7, 18.5, BODY2)
    cv.rect(21, 3, 51, 26, LINE, 1); cv.rect(22, 4, 50, 25, BODY, 1)
    cv.line([(22, 22), (50, 22)], DET, .7)
    for x in (30, 42):
        cv.line([(x, 22), (x, 25)], DET, .7)
    cv.rect(24.5, 10, 47.5, 19.5, LINE, 1); cv.rect(25.5, 11, 46.5, 18.5, ACC, 1)
    le = [(27.2, 12.4), (34.6, 14.2), (34.3, 17.2), (27.6, 15.8)]
    for pts in (le, [(72 - x, y) for x, y in le]):
        cx = sum(x for x, _ in pts) / 4; cy = sum(y for _, y in pts) / 4
        cv.poly([(cx + (x - cx) * 1.35, cy + (y - cy) * 1.5) for x, y in pts], ACC2)
        cv.poly(pts, EW)

def b_pi(cv):
    """π: the name itself — a wide top bar as the head, the two stems as legs."""
    for pts in ([(25, 29), (25.5, 44), (23.5, 54)], [(46, 29), (46, 46), (49.5, 54)]):
        cv.line(pts, LINE, 9.4); cv.line(pts, BODY2, 6.8)
    cv.poly([(8, 17), (12, 12), (63, 12), (64, 15), (63, 31), (10, 31), (7, 27)], LINE)
    cv.poly([(9.2, 17.4), (12.6, 13.2), (62, 13.2), (62.8, 15.4), (62, 29.8), (10.6, 29.8), (8.2, 26.6)], BODY)
    cv.rect(13, 14.6, 60, 17.2, ACC, 1)
    eye(cv, 30, 22, 2.8, 3.5, (.5, .3)); eye(cv, 42, 22, 2.8, 3.5, (.5, .3))
    cv.line([(33.5, 27.2), (36, 28.4), (38.5, 27.2)], LINE, 1.0)

def b_moon(cv):
    cv.ell(34, 30, 22, 22, LINE); cv.ell(34, 30, 21, 21, BODY)
    cv.ell(47, 23, 17.5, 17.5, LINE); cv.ell(47.6, 22.4, 16.8, 16.8, T)
    for (x, y, r) in [(18, 40, 1.6), (33, 47, 1.8), (16, 24, 1.2)]:
        cv.ell(x, y, r, r, ACC)
    eye(cv, 20.5, 29.5, 2.6, 3.4, (.7, .4)); eye(cv, 26.5, 38, 2.6, 3.4, (.7, .4))
    cv.line([(22, 45), (26, 46.5), (30, 45.5)], LINE, 1.0)

def b_qmark(cv):
    hook = [(23, 18), (25, 10), (31, 5.5), (40, 5.5), (47, 10), (48, 18), (44, 24), (38, 28.5), (36.5, 34), (36.5, 41)]
    cv.line(hook, LINE, 12); cv.line(hook, BODY, 9.6)
    cv.line([(27, 9), (33, 6.2)], ACC, 1.6)
    eye(cv, 33, 9, 2.5, 3.1, (.6, .4)); eye(cv, 41, 10, 2.5, 3.1, (.6, .4))

def b_alien(cv):
    pts = [(36, 6), (48, 9), (54, 18), (53, 28), (46, 37), (36, 41), (26, 37), (19, 28), (18, 18), (24, 9)]
    cv.line([(36, 8), (36, 1.5)], LINE, 2.2); cv.ell(36, 1.8, 2.8, 2.8, LINE); cv.ell(36, 1.8, 1.9, 1.9, ACC2)
    cv.poly([(x + (1.1 if x > 36 else -1.1), y + (1.1 if y > 20 else -1.1)) for x, y in pts], LINE)
    cv.poly(pts, BODY)
    cv.rect(30, 39, 42, 52, LINE, 3); cv.rect(31, 39.5, 41, 51, BODY2, 3)
    cv.rect(34.5, 42, 37.5, 45, ACC2, 1)
    for (cx, s_) in [(28.5, -1), (43.5, 1)]:
        e = [(cx - 6.5 * s_, 19), (cx + 3.5 * s_, 17), (cx + 5 * s_, 24), (cx - 1.5 * s_, 30)]
        cv.poly([(x + s_ * .9, y + .6) for x, y in e], LINE); cv.poly(e, EB)
        cv.ell(cx - 2.5 * s_, 21, 1.3, 1.3, EW)

def b_book(cv):
    cv.poly([(10, 20), (36, 25), (62, 20), (62, 50), (36, 55), (10, 50)], LINE)
    cv.poly([(11, 22), (35, 26), (35, 52), (11, 48)], BODY); cv.poly([(37, 26), (61, 22), (61, 48), (37, 52)], BODY)
    cv.poly([(35, 26), (37, 26), (37, 53), (35, 53)], BODY2)
    for i, w in enumerate([14, 10, 16, 8]):
        y = 39 + i * 3.2
        cv.line([(14, y), (14 + w, y + .8)], ACC if i % 2 == 0 else DET, 1.0)
    for i, w in enumerate([12, 16, 9, 13]):
        y = 39 + i * 3.2
        cv.line([(40, y + .8), (40 + w, y)], DET if i % 2 == 0 else ACC, 1.0)
    eye(cv, 23, 32, 3.0, 3.8, (.6, .4)); eye(cv, 49, 32, 3.0, 3.8, (-.4, .4))

def b_pointer(cv):
    pts = [(20, 4), (20, 48), (30, 39), (37, 55), (45, 51), (38, 36), (51, 36)]
    cv.poly([(x - 1.2, y - 1.4) for x, y in pts[:1]] + [(19, 50), (30, 41.5), (36.5, 57.5), (47, 52.5), (40.5, 37.5), (54, 37), (19, 2)], LINE)
    cv.poly(pts, BODY)
    eye(cv, 25.5, 27, 2.6, 3.4, (.5, .4)); eye(cv, 32.5, 32, 2.6, 3.4, (.5, .4))

def b_toolbox(cv):
    cv.line([(27, 23), (28, 15), (44, 15), (45, 23)], LINE, 3.6); cv.line([(27, 23), (28, 15.5), (44, 15.5), (45, 23)], BODY2, 1.6)
    cv.poly([(47, 22), (55, 10), (59, 12), (52, 24)], LINE); cv.poly([(48, 22), (55.5, 11.2), (58, 12.6), (51, 23)], ACC)
    cv.ell(57, 10, 3.4, 3.4, LINE); cv.ell(57, 10, 2.4, 2.4, ACC); cv.ell(58.5, 8.5, 1.2, 1.2, T)
    cv.rect(12, 22, 60, 54, LINE, 5); cv.rect(13, 23, 59, 53, BODY, 4)
    cv.rect(13, 23, 59, 30, BODY2, 3); cv.rect(33, 27, 39, 33, LINE, 1); cv.rect(34, 28, 38, 32, ACC2, 1)
    eye(cv, 27, 41, 3.0, 3.8, (.5, .3)); eye(cv, 45, 41, 3.0, 3.8, (.5, .3))
    cv.line([(32, 48), (36, 50), (40, 48)], LINE, 1.1)

def b_envelope(cv):
    for (sx, s) in [(13, -1), (59, 1)]:
        feathers = [(sx, 26), (sx + 14 * s, 14), (sx + 15 * s, 18), (sx + 12 * s, 21), (sx + 14 * s, 24), (sx + 10 * s, 28), (sx + 11 * s, 31), (sx, 36)]
        cv.poly([(x + .8 * s, y + (0 if i in (0, 7) else -.8)) for i, (x, y) in enumerate(feathers)], LINE); cv.poly(feathers, ACC)
        cv.line([(sx + 2 * s, 29), (sx + 9 * s, 22)], DET, .9)
    cv.rect(11, 22, 61, 52, LINE, 3); cv.rect(12, 23, 60, 51, BODY, 2)
    cv.line([(13, 24), (36, 39), (59, 24)], DET, 1.4)
    eye(cv, 29, 44, 2.6, 3.0, (.5, .2)); eye(cv, 43, 44, 2.6, 3.0, (.5, .2))

def b_gear(cv):
    pts = []
    for i in range(40):
        a = i / 40 * 2 * math.pi
        r = 22 if (i // 2) % 2 == 0 else 17.5
        pts.append((36 + r * math.cos(a), 31 + r * math.sin(a)))
    cv.poly([(36 + (x - 36) * 1.06, 31 + (y - 31) * 1.06) for x, y in pts], LINE); cv.poly(pts, BODY)
    cv.ell(36, 31, 12.5, 12.5, LINE); cv.ell(36, 31, 11.5, 11.5, BODY2)
    eye(cv, 31.5, 30, 2.6, 3.4, (.5, .4)); eye(cv, 40.5, 30, 2.6, 3.4, (.5, .4))
    cv.line([(33, 37), (36, 38.5), (39, 37)], LINE, 1.0)

def b_codeblock(cv):
    cv.rect(11, 14, 61, 50, LINE, 5); cv.rect(12, 15, 60, 49, BODY, 4)
    cv.rect(12, 15, 60, 21, BODY2, 3)
    for i, c in enumerate([ACC2, (ACC), DET]):
        cv.ell(17 + i * 4.2, 18, 1.3, 1.3, [FX, ACC, ACC2][i])
    cv.text("{", 14, 21, 20, ACC); cv.text("}", 48, 21, 20, ACC)
    eye(cv, 30, 33, 2.8, 3.6, (.5, .4)); eye(cv, 42, 33, 2.8, 3.6, (.5, .4))
    cv.line([(32, 41), (36, 43), (40, 41)], LINE, 1.0)

def b_cube(cv):
    top = [(36, 8), (58, 18), (36, 28), (14, 18)]
    left = [(14, 18), (36, 28), (36, 54), (14, 44)]
    right = [(36, 28), (58, 18), (58, 44), (36, 54)]
    cv.poly([(36, 6.5), (59.5, 17.5), (59.5, 45), (36, 55.8), (12.5, 45), (12.5, 17.5)], LINE)
    cv.poly(top, ACC); cv.poly(left, BODY); cv.poly(right, BODY2)
    cv.line([(14, 18), (36, 28), (58, 18)], LINE, .9); cv.line([(36, 28), (36, 54)], LINE, .9)
    eye(cv, 21.5, 33, 2.4, 3.2, (.5, .4)); eye(cv, 29, 36.5, 2.4, 3.2, (.5, .4))
    cv.line([(23, 42), (26, 44), (29, 44.5)], LINE, .9)
    for (x, c) in [(25, ACC2), (47, ACC2)]:
        cv.poly([(x - 3, 55), (x + 3, 55), (x, 64)], FX); cv.poly([(x - 1.6, 55), (x + 1.6, 55), (x, 60)], c)

def b_chip(cv):
    for i in range(4):
        x = 22 + i * 9.3
        for (y0, y1) in [(9, 15), (55, 61)]:
            cv.rect(x - 1.8, y0, x + 1.8, y1, LINE); cv.rect(x - 1, y0 + .6, x + 1, y1 - .6, ACC)
        y = 22 + i * 9.3
        for (x0, x1) in [(9, 15), (57, 63)]:
            cv.rect(x0, y - 1.8, x1, y + 1.8, LINE); cv.rect(x0 + .6, y - 1, x1 - .6, y + 1, ACC)
    cv.rect(13, 13, 59, 59, LINE, 4); cv.rect(14, 14, 58, 58, BODY, 3)
    cv.rect(22, 24, 50, 48, LINE, 2); cv.rect(23, 25, 49, 47, BODY2, 2)
    eye(cv, 30, 34, 2.8, 3.6, glow=True); eye(cv, 42, 34, 2.8, 3.6, glow=True)
    cv.line([(32, 41), (36, 43), (40, 41)], ACC, 1.0)

def b_monitor(cv):
    cv.rect(30, 44, 42, 52, LINE); cv.rect(31, 44, 41, 51, BODY)
    cv.rect(23, 50, 49, 55, LINE, 2); cv.rect(24, 51, 48, 54, BODY, 1)
    cv.rect(9, 9, 63, 47, LINE, 4); cv.rect(10, 10, 62, 46, BODY, 3)
    cv.rect(14, 14, 58, 42, LINE, 2); cv.rect(15, 15, 57, 41, BODY2, 2)
    eye(cv, 29, 26, 2.8, 3.8, glow=True); eye(cv, 43, 26, 2.8, 3.8, glow=True)
    cv.line([(31, 34), (36, 36.5), (41, 34)], ACC, 1.2)

GEOM = {
 "moon":      dict(draw=b_moon, shoulders=((14, 36), (43, 46)), hips=((29, 50), (36, 50)), eyes=((20.5, 29.5), (26.5, 38))),
 "qmark":     dict(draw=b_qmark, shoulders=((32, 35), (41, 35)), hips=((34.5, 44), (38.5, 44)), eyes=((33, 9), (41, 10))),
 "alien":     dict(draw=b_alien, shoulders=((32, 43), (40, 43)), hips=((33.5, 51), (38.5, 51)), eyes=((28, 22), (44, 22))),
 "book":      dict(draw=b_book, shoulders=((11, 36), (61, 36)), hips=((32, 52), (40, 52)), eyes=((23, 32), (49, 32))),
 "pointer":   dict(draw=b_pointer, shoulders=((21, 32), (40, 37)), hips=((34, 50), (40, 49)), eyes=((26.5, 24), (33.5, 29))),
 "toolbox":   dict(draw=b_toolbox, shoulders=((13, 38), (59, 38)), hips=((28, 53), (44, 53)), eyes=((27, 41), (45, 41))),
 "envelope":  dict(draw=b_envelope, shoulders=((12, 42), (60, 42)), hips=((28, 51), (44, 51)), eyes=((29, 44), (43, 44))),
 "gear":      dict(draw=b_gear, shoulders=((15, 35), (57, 35)), hips=((31, 51), (41, 51)), eyes=((31.5, 30), (40.5, 30))),
 "codeblock": dict(draw=b_codeblock, shoulders=((12, 34), (60, 34)), hips=((29, 49), (43, 49)), eyes=((30, 33), (42, 33))),
 "cube":      dict(draw=b_cube, shoulders=((14, 34), (58, 34)), hips=((25, 54), (47, 54)), eyes=((22.5, 36), (30, 39.5)), legs=False),
 "chip":      dict(draw=b_chip, shoulders=((14, 34), (58, 34)), hips=((28, 58), (44, 58)), eyes=((30, 34), (42, 34)), foot_y=66),
 "golem":     dict(draw=b_golem, shoulders=((16, 30), (56, 30)), hips=((28, 50), (44, 50)), eyes=((30, 15), (42, 15)), legs=False, block=True),
 "pi":        dict(draw=b_pi, shoulders=((10, 22), (62, 22)), hips=((23.5, 54), (49.5, 54)), eyes=((30, 22), (42, 22)), foot_y=64),
 "monitor":   dict(draw=b_monitor, shoulders=((10, 30), (62, 30)), hips=((30, 54), (42, 54)), eyes=((29, 26), (43, 26))),
}

PAL = {   # body, body2, detail, accent, accent2, limb, shoe, eye-white (glow) ; brand colours
 "kimi":    dict(kind="moon", body="#EAF2FF", body2="#C9DDFB", det="#5B6B85", acc="#B9D2FA", acc2="#1783FF", limb="#1783FF", shoe="#0B2A52", ew="#FFFFFF"),
 "qwen":    dict(kind="qmark", body="#8E72FA", body2="#6336E7", det="#2A1670", acc="#C9B8FF", acc2="#6F69F7", limb="#4C22C4", shoe="#25125F", ew="#FFFFFF"),
 "grok":    dict(kind="alien", body="#E9EBEF", body2="#16171B", det="#4A4F59", acc="#F2F4F8", acc2="#FFFFFF", limb="#2A2D33", shoe="#0C0D10", ew="#FFFFFF"),
 "codex":   dict(kind="book", body="#F7F8FA", body2="#16171A", det="#9AA0AA", acc="#22C55E", acc2="#16171A", limb="#2A2D33", shoe="#16171A", ew="#FFFFFF"),
 "cursor":  dict(kind="pointer", body="#F4F5F7", body2="#2A2D34", det="#2A2D34", acc="#9AA3AF", acc2="#2A2D34", limb="#2A2D34", shoe="#16171A", ew="#FFFFFF"),
 "workbuddy": dict(kind="toolbox", body="#3B82F6", body2="#1D4ED8", det="#0B1F4D", acc="#CBD5E1", acc2="#FBBF24", limb="#12306E", shoe="#0B1F4D", ew="#FFFFFF"),
 "hermes":  dict(kind="envelope", body="#F7F8FA", body2="#D9DCE1", det="#8A919C", acc="#FFFFFF", acc2="#14B8A6", limb="#5B6170", shoe="#2F343C", ew="#FFFFFF"),
 "droid":   dict(kind="gear", body="#C9CDD3", body2="#F97316", det="#3A3F48", acc="#F97316", acc2="#FDBA74", limb="#2A2D33", shoe="#16171A", ew="#FFFFFF"),
 "opencode": dict(kind="codeblock", body="#3A3F48", body2="#22252B", det="#9AA3AF", acc="#4ADE80", acc2="#FBBF24", limb="#6B717C", shoe="#16171A", ew="#FFFFFF"),
 "antigravity": dict(kind="cube", body="#C7CDD6", body2="#9EA6B2", det="#3A3F48", acc="#EEF1F5", acc2="#7DD3FC", limb="#5B6170", shoe="#16171A", ew="#FFFFFF"),
 "local":   dict(kind="chip", body="#16A34A", body2="#0B3A1C", det="#0B3A1C", acc="#86EFAC", acc2="#22C55E", limb="#11692F", shoe="#0B3A1C", ew="#B9F8CF"),
 "claude":  dict(kind="golem", body="#E2825A", body2="#C4653F", det="#6B2E18", acc="#1A1210", acc2="#FF8A4C", limb="#D7744C", shoe="#A9512F", ew="#FFE7C9", glove="#E8895F"),
 "pi":      dict(kind="pi", body="#5B6472", body2="#3A414D", det="#1F242C", acc="#7C8696", acc2="#FBBF24", limb="#2F3540", shoe="#151820", ew="#FFFFFF"),
 "pc":      dict(kind="monitor", body="#64748B", body2="#0B1220", det="#1E2633", acc="#7DD3FC", acc2="#38BDF8", limb="#475569", shoe="#1E2633", ew="#9BE3FF"),
}

def render(model, pose="idle", scale=6):
    p = PAL[model]
    lab = np.array(figure(p["kind"], pose))
    blk = lab.reshape(S, H, S, H).transpose(0, 2, 1, 3).reshape(S, S, H * H)
    counts = np.stack([(blk == k).sum(-1) for k in range(NL)], -1).astype(float)
    cover = 1 - counts[..., 0] / (H * H)
    w = counts * WEIGHT; w[..., 0] = 0
    labs = np.where(cover >= .34, w.argmax(-1), 0)
    # outer outline
    solid = labs != 0
    pad = np.pad(solid, 1)
    nb = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
    labs = np.where(~solid & nb, LINE, labs)
    col = {T: (0, 0, 0), BODY: hx(p["body"]), BODY2: hx(p["body2"]), DET: hx(p["det"]), EW: hx(p["ew"]), EB: (14, 15, 18),
           LIMB: hx(p["limb"]), GLOVE: hx(p.get("glove", "#FAFAF8")), SHOE: hx(p["shoe"]), ACC: hx(p["acc"]), ACC2: hx(p["acc2"]), FX: (110, 196, 255), LINE: (14, 15, 18)}
    img = np.zeros((S, S, 4), np.uint8)
    for k, c in col.items():
        m = labs == k
        img[m, :3] = c; img[m, 3] = 255 if k != T else 0
    # rim shading on body / body2 / limbs
    for k in (BODY, BODY2, LIMB, SHOE):
        m = labs == k
        pd = np.pad(m, 1)
        br = m & ~(pd[1:-1, 2:] & pd[2:, 1:-1])            # bottom/right edge
        tl = m & ~(pd[1:-1, :-2] & pd[:-2, 1:-1])           # top/left edge
        img[br, :3] = [shade(col[k], .78)] if br.any() else img[br, :3]
        img[tl & ~br, :3] = [mix(col[k], (255, 255, 255), .28)] if (tl & ~br).any() else img[tl & ~br, :3]
    out = Image.fromarray(img, "RGBA")
    return out.resize((S * scale, S * scale), Image.NEAREST)
