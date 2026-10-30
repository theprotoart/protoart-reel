"""Draws the ProtoArt Reel DMG window's background: a dark rack panel with an amber stripe, the name, a pair of tape
reels, an amber arrow from the app to Applications, and a line of instructions, plus a light plate behind each
icon's name (Finder writes the names in dark text, unreadable on the dark panel otherwise).
Writes <out>/bg.png (660×460) and <out>/bg@2x.png (1320×920).
Usage: python3 dmg_background.py <out dir>
The icon positions must match the layout in "Make DMG for friends.command"."""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 660, 460
APP_X, APPS_X, ICON_Y = 170, 490, 170   # icon centres, as set in the DMG script
README_X, README_Y = 330, 350           # "Read Me First.txt"
ICON = 96
AMBER = (255, 176, 42)


def font(size, bold=False):
    paths = ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc",
             "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def reel(d, cx, cy, r, s):
    """A small tape reel: rim, three spokes' cut-outs and a hub."""
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(196, 192, 182), outline=(90, 86, 78), width=max(1, s))
    for k in range(3):
        a = math.radians(90 + k * 120)
        hx, hy = cx + math.cos(a) * r * 0.52, cy - math.sin(a) * r * 0.52
        d.ellipse([hx - r * 0.27, hy - r * 0.27, hx + r * 0.27, hy + r * 0.27], fill=(30, 30, 33))
    d.ellipse([cx - r * 0.18, cy - r * 0.18, cx + r * 0.18, cy + r * 0.18], fill=(60, 58, 54))


def draw(s):
    w, h = W * s, H * s
    img = Image.new("RGB", (w, h), (24, 25, 28))
    d = ImageDraw.Draw(img)
    for y in range(0, h, 2 * s):                      # brushed metal
        shade = 24 + (y * 7 // h) % 3
        d.line([(0, y), (w, y)], fill=(shade, shade + 1, shade + 4))
    d.rectangle([0, 0, w, 6 * s], fill=(236, 144, 32))  # the rack's amber stripe

    # name: ProtoArt in cream, REEL spaced out in amber, between two small reels
    f1, f2 = font(24 * s, True), font(15 * s, True)
    t1, t2 = "ProtoArt", "R  E  E  L"
    w1, w2 = d.textlength(t1, font=f1), d.textlength(t2, font=f2)
    gap = 12 * s
    x = (w - (w1 + gap + w2)) / 2
    ty = 30 * s
    d.text((x, ty), t1, font=f1, fill=(239, 234, 220))
    d.text((x + w1 + gap, ty + 8 * s), t2, font=f2, fill=AMBER)
    reel(d, x - 30 * s, ty + 15 * s, 13 * s, s)
    reel(d, x + w1 + gap + w2 + 30 * s, ty + 15 * s, 13 * s, s)

    # arrow from the app to Applications (glow, then the arrow)
    y = ICON_Y * s
    x0, x1 = (APP_X + 70) * s, (APPS_X - 70) * s
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    gd.line([(x0, y), (x1 - 18 * s, y)], fill=180, width=14 * s)
    gd.polygon([(x1, y), (x1 - 30 * s, y - 20 * s), (x1 - 30 * s, y + 20 * s)], fill=180)
    glow = glow.filter(ImageFilter.GaussianBlur(8 * s))
    img.paste((255, 160, 40), mask=glow.point(lambda v: v // 3))
    d.line([(x0, y), (x1 - 18 * s, y)], fill=AMBER, width=6 * s)
    d.polygon([(x1, y), (x1 - 26 * s, y - 16 * s), (x1 - 26 * s, y + 16 * s)], fill=AMBER)

    # light plates under the icon names
    def plate(cx, cy, pw=150):
        d.rounded_rectangle([(cx - pw / 2) * s, (cy + ICON / 2 + 3) * s, (cx + pw / 2) * s, (cy + ICON / 2 + 25) * s],
                            radius=5 * s, fill=(222, 217, 205), outline=(120, 114, 102), width=max(1, s))
    plate(APP_X, ICON_Y)
    plate(APPS_X, ICON_Y)
    plate(README_X, README_Y, 150)

    t = "Drag ProtoArt Reel onto Applications to install"
    f3 = font(15 * s)
    d.text(((w - d.textlength(t, font=f3)) / 2, (ICON_Y + ICON / 2 + 40) * s), t, font=f3, fill=(220, 214, 200))
    t = 'First time: System Settings > Privacy & Security > Open Anyway  ·  see "Read Me First"'
    f4 = font(11 * s)
    d.text(((w - d.textlength(t, font=f4)) / 2, (H - 26) * s), t, font=f4, fill=(150, 146, 138))
    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    draw(1).save(os.path.join(out, "bg.png"))
    draw(2).save(os.path.join(out, "bg@2x.png"))


if __name__ == "__main__":
    main()
