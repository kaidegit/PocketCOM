#!/usr/bin/env python3
"""PocketCOM e2e 截图像素探测（docs/coords.md 复验工具）。

宿主 `--screenshot` 默认输出为 2x 物理像素 PNG，含 28pt 标题栏。
--density 指截图实际像素/逻辑像素比例（macOS backing scale），不是宿主 raster density。
--title-bar 指逻辑像素高度；无标题栏的板端截图用 --density 1 --title-bar 0。
画布坐标（--click/--mouse 的逻辑像素）与物理像素换算：

    canvas_x = phys_x / 2
    canvas_y = (phys_y - 56) / 2

用法：
  coords-probe.py sample A.png 136 91     # 画布坐标处颜色（3x3 邻域众数）
  coords-probe.py diff A.png B.png        # 差异 bbox（画布坐标；容差 10，
                                         #   滤掉弹层遮罩 #00000001 的 ±1 噪声）
  coords-probe.py accent A.png            # 找 accent 蓝实心簇（激活分段/
                                         #   主按钮/选中勾选框，深色主题渲染值
                                         #   #3f83fa，源色 #4c8dff 经合成偏移）

同一 UI 状态的两次运行截图字节一致（无交互时 diff 为 IDENTICAL），
可作负对照。
"""
import argparse
from PIL import Image

TITLE_BAR = 56
DENSITY = 2
# 深色主题 accent #4c8dff 经窗口合成后的实测渲染值，容差放 ±14
ACCENT = (0x3F, 0x83, 0xFA)
TOL = 10


def load(path):
    return Image.open(path).convert("RGB")


def to_canvas(px, py):
    return px // DENSITY, (py - TITLE_BAR) // DENSITY


def sample(img, cx, cy):
    px, py = cx * DENSITY, cy * DENSITY + TITLE_BAR
    if not (0 <= px < img.width and TITLE_BAR <= py < img.height):
        raise ValueError("sample coordinate is outside the canvas")
    votes = {}
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if not (0 <= px + dx < img.width and TITLE_BAR <= py + dy < img.height):
                continue
            c = img.getpixel((px + dx, py + dy))
            votes[c] = votes.get(c, 0) + 1
    return "#%02x%02x%02x" % max(votes, key=votes.get)


def diff(a, b, tol=TOL):
    if a.size != b.size:
        raise ValueError("diff requires screenshots of the same size")
    w, h = a.size
    minx, miny = w, h
    maxx = maxy = -1
    pa, pb = a.load(), b.load()
    for y in range(TITLE_BAR, h, DENSITY):
        for x in range(0, w, DENSITY):
            ca, cb = pa[x, y], pb[x, y]
            if (abs(ca[0] - cb[0]) > tol or abs(ca[1] - cb[1]) > tol
                    or abs(ca[2] - cb[2]) > tol):
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    if maxx < 0:
        return None
    x0, y0 = to_canvas(minx, miny)
    x1, y1 = to_canvas(min(maxx + DENSITY, w), min(maxy + DENSITY, h))
    return {"bbox": (x0, y0, x1, y1)}


def accent(img):
    w, h = img.size
    px = img.load()
    rows = []
    for y in range(TITLE_BAR, h, DENSITY):
        xs = [x for x in range(0, w, DENSITY)
              if all(abs(px[x, y][i] - ACCENT[i]) <= 14 for i in range(3))]
        if xs:
            rows.append((y, min(xs), max(xs)))
    if not rows:
        return []
    clusters, cur = [], [rows[0]]
    for r in rows[1:]:
        if r[0] - cur[-1][0] <= 2 * DENSITY:
            cur.append(r)
        else:
            clusters.append(cur)
            cur = [r]
    clusters.append(cur)
    out = []
    for c in clusters:
        x0 = min(r[1] for r in c)
        x1 = max(r[2] for r in c)
        y0 = to_canvas(0, c[0][0])[1]
        y1 = to_canvas(0, c[-1][0] + DENSITY)[1]
        out.append((x0 // DENSITY, y0, x1 // DENSITY, y1))
    return out


def main():
    global DENSITY, TITLE_BAR
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--density", type=int, default=2,
                        help="actual screenshot pixels per logical pixel (default: 2)")
    parser.add_argument("--title-bar", type=int, default=28,
                        help="title bar height in logical pixels (default: 28; board: 0)")
    commands = parser.add_subparsers(dest="command", required=True)
    sampling = commands.add_parser("sample")
    sampling.add_argument("image")
    sampling.add_argument("x", type=int)
    sampling.add_argument("y", type=int)
    comparison = commands.add_parser("diff")
    comparison.add_argument("before")
    comparison.add_argument("after")
    accents = commands.add_parser("accent")
    accents.add_argument("image")
    args = parser.parse_args()
    if args.density < 1 or args.title_bar < 0:
        parser.error("density must be positive and title-bar must be nonnegative")
    DENSITY = args.density
    TITLE_BAR = args.title_bar * DENSITY
    if args.command == "sample":
        print(sample(load(args.image), args.x, args.y))
    elif args.command == "diff":
        d = diff(load(args.before), load(args.after))
        print(d if d else "IDENTICAL")
    elif args.command == "accent":
        for c in accent(load(args.image)):
            print("accent bbox (canvas):", c)


if __name__ == "__main__":
    main()
