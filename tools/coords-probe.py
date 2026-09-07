#!/usr/bin/env python3
"""PocketCOM e2e 截图像素探测（docs/coords.md 复验工具）。

宿主 `--screenshot` 输出为 2x 物理像素 PNG，含 28pt（56 物理像素）标题栏。
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
import sys
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
    votes = {}
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            c = img.getpixel((px + dx, py + dy))
            votes[c] = votes.get(c, 0) + 1
    return "#%02x%02x%02x" % max(votes, key=votes.get)


def diff(a, b, tol=TOL):
    w, h = a.size
    minx, miny = w, h
    maxx = maxy = -1
    pa, pb = a.load(), b.load()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            ca, cb = pa[x, y], pb[x, y]
            if (abs(ca[0] - cb[0]) > tol or abs(ca[1] - cb[1]) > tol
                    or abs(ca[2] - cb[2]) > tol):
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    if maxx < 0:
        return None
    x0, y0 = to_canvas(minx, miny)
    x1, y1 = to_canvas(maxx + 2, maxy + 2)
    return {"bbox": (x0, y0, x1, y1)}


def accent(img):
    w, h = img.size
    px = img.load()
    rows = []
    for y in range(TITLE_BAR, h, 2):
        xs = [x for x in range(0, w, 2)
              if all(abs(px[x, y][i] - ACCENT[i]) <= 14 for i in range(3))]
        if xs:
            rows.append((y, min(xs), max(xs)))
    if not rows:
        return []
    clusters, cur = [], [rows[0]]
    for r in rows[1:]:
        if r[0] - cur[-1][0] <= 4:
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
        y1 = to_canvas(0, c[-1][0] + 2)[1]
        out.append((x0 // DENSITY, y0, x1 // DENSITY, y1))
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "sample" and len(sys.argv) == 5:
        print(sample(load(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])))
    elif cmd == "diff" and len(sys.argv) == 4:
        d = diff(load(sys.argv[2]), load(sys.argv[3]))
        print(d if d else "IDENTICAL")
    elif cmd == "accent" and len(sys.argv) == 3:
        for c in accent(load(sys.argv[2])):
            print("accent bbox (canvas):", c)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
