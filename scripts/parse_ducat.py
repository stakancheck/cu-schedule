#!/usr/bin/env python3
"""Парсер PDF-плана кампуса «Дукат» -> js/plans-ducat.js.

PDF векторный: 1 страница описания + по странице на этаж (1..10).
  * пол      - серая заливка (0.9);
  * стены    - тёмные заливки вне плашек и иконок;
  * плашки   - прямоугольники с текстом (цвет = тип помещения), под
               цветной плашкой с названием лежит чёрная с кодом;
  * иконки   - квадраты 12-30pt без текста, забираем векторы как есть.
Контуры помещений ищем растровой сегментацией: стены рисуем в маску,
дверные проёмы закрываем морфологией по линиям, берём компоненту под
плашкой кода и векторизуем её контур.

Текст в PDF закодирован со сдвигом: кириллица лежит в 0x10-0x4F,
часть заглавных подменена глифами Mac-кодировки. Декодируем эвристикой.

Запуск: python3 scripts/parse_ducat.py [plan.pdf]
"""
import json
import re
import sys
from pathlib import Path

import cv2
import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads/plan-ducat.pdf"
OUT = ROOT / "js/plans-ducat.js"

S = 2.5      # масштаб pt -> единицы плана (близко к масштабу ЦТ)
Z = 4        # масштаб растра для сегментации (px на pt)
DOORS = [26, 40, 60, 90]  # пробуемые ширины проёмов, pt
MAX_ROOM = 30000          # pt^2: больше - скорее всего протекли в коридор
HALLS = {"F101", "B1004", "B1006"}  # действительно большие залы

# ------------------------------------------------------------------ текст
SPECIAL = {"˜": "П", "ˆ": "К", "˚": "О", "˛": "Н", "˙": "Л", "˘": "И", "˝": "М", "€": " ", "\x06": ""}
PUNCT_AS_UPPER = set('!"#$%&\'()*+,-./')  # 0x21-0x2F -> С..Я, если начинают слово


def is_low(ch):
    return 0x30 <= ord(ch) <= 0x4F


def decode_word(w):
    if not w:
        return w
    # Код помещения: В/B + цифры, F + цифры, диапазоны через \x13 (тире)
    m = re.fullmatch(r"([\x12BF])(\d{3,4})([,.]?)", w)
    if m:
        return ("F" if m.group(1) == "F" else "B") + m.group(2) + m.group(3)
    if re.fullmatch(r"[\d\x13,.\-–]+", w):
        return w.replace("\x13", "–")
    if re.fullmatch(r"F\d{3}\x13F\d{3}", w):
        return w.replace("\x13", "–")
    out = []
    for i, ch in enumerate(w):
        o = ord(ch)
        nxt = w[i + 1] if i + 1 < len(w) else ""
        if ch in SPECIAL:
            out.append(SPECIAL[ch])
        elif 0x10 <= o <= 0x1F:
            out.append(chr(o + 0x400))
        elif ch in PUNCT_AS_UPPER and (i == 0 or w[i - 1] in "«(/") and nxt and (is_low(nxt) or nxt in SPECIAL):
            out.append(chr(o + 0x400))
        elif is_low(ch):
            out.append(chr(o + 0x400))
        else:
            out.append(ch)
    return "".join(out)


# Правки там, где эвристика ошибается: «Р» теряется как пробел, «(» бывает
# и буквой «Ш», и артефактом переноса строки, одиночное «8» это союз «и».
FIXES = [
    (r"\bуководители", "Руководители"),
    (r"\bШ(?=(команда|благополучия|для|бухгалтерии)\b)", ""),
    (r"Команда\(", "Команда "),
    (r" 8 ", " и "),
    (r"^т$", "B"), (r"^ц$", "F"),
    (r"цloo", "Floo"),
    (r"^на Ра этаж$", "на 0 этаж"),
    (r"^ектор$", "Ректор"),
    (r"Рраздевалка", "раздевалка"),
]


def undouble(raw):
    # на 3 этаже каждая строка продублирована: «АудиторияАудитория»
    h = len(raw) // 2
    if len(raw) % 2 == 0 and h > 0 and raw[:h] == raw[h:]:
        return raw[:h]
    parts = raw.split()
    if len(parts) % 2 == 0 and parts[: len(parts) // 2] == parts[len(parts) // 2:]:
        return " ".join(parts[: len(parts) // 2])
    return raw


def decode(s):
    s = undouble(s.replace("\n", " ").strip())
    out = re.sub(r"\s+", " ", " ".join(decode_word(w) for w in s.split(" "))).strip()
    for a, b in FIXES:
        out = re.sub(a, b, out)
    return out.strip()


# ------------------------------------------------------------------ геометрия
def color_kind(fill):
    r, g, b = fill
    if max(r, g, b) < 0.2:
        return "dark"
    if abs(r - 0.9) < 0.03 and abs(g - 0.9) < 0.03:
        return "floor"
    if min(r, g, b) > 0.97:
        return "white"
    if g > 0.5 and r < 0.2:
        return "kitchen"
    if b > 0.7 and r < 0.3:
        return "staff"
    if r > 0.9 and g < 0.35 and b > 0.45:
        return "fitness"
    if r > 0.9 and g < 0.4 and b < 0.2:
        return "closed"
    if r > 0.6 and b > 0.8:
        return "health"
    return "other"


def fmtp(p):
    return f"{p.x * S:.1f},{p.y * S:.1f}"


def path_d(dr, origin=(0, 0)):
    ox, oy = origin
    parts, cur = [], None

    def pt(p):
        return f"{(p.x - ox) * S:.1f},{(p.y - oy) * S:.1f}"

    for it in dr["items"]:
        op = it[0]
        if op == "l":
            a, b = it[1], it[2]
            if cur is None or abs(cur.x - a.x) > 0.01 or abs(cur.y - a.y) > 0.01:
                parts.append("M" + pt(a))
            parts.append("L" + pt(b))
            cur = b
        elif op == "c":
            a, c1, c2, b = it[1:5]
            if cur is None or abs(cur.x - a.x) > 0.01 or abs(cur.y - a.y) > 0.01:
                parts.append("M" + pt(a))
            parts.append(f"C{pt(c1)} {pt(c2)} {pt(b)}")
            cur = b
        elif op == "re":
            r = it[1]
            parts.append(f"M{pt(r.tl)}L{pt(r.tr)}L{pt(r.br)}L{pt(r.bl)}Z")
            cur = None
        elif op == "qu":
            q = it[1]
            parts.append(f"M{pt(q.ul)}L{pt(q.ur)}L{pt(q.lr)}L{pt(q.ll)}Z")
            cur = None
    d = "".join(parts)
    if dr.get("closePath"):
        d += "Z"
    return d


def replay(shape, dr):
    for it in dr["items"]:
        op = it[0]
        if op == "l":
            shape.draw_line(it[1], it[2])
        elif op == "c":
            shape.draw_bezier(it[1], it[2], it[3], it[4])
        elif op == "re":
            shape.draw_rect(it[1])
        elif op == "qu":
            shape.draw_quad(it[1])


def rasterize(page_rect, drs, fill_even_odd=True):
    doc = pymupdf.open()
    pg = doc.new_page(width=page_rect.width, height=page_rect.height)
    for dr in drs:
        sh = pg.new_shape()
        replay(sh, dr)
        sh.finish(fill=(0, 0, 0), color=None, even_odd=dr.get("even_odd", True), closePath=dr.get("closePath", False))
        sh.commit()
    pix = pg.get_pixmap(matrix=pymupdf.Matrix(Z, Z), colorspace=pymupdf.csGRAY, alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    return img < 128


def inside(inner, outer, tol=0.5):
    return (inner.x0 >= outer.x0 - tol and inner.y0 >= outer.y0 - tol
            and inner.x1 <= outer.x1 + tol and inner.y1 <= outer.y1 + tol)


def parse_page(page, floor_n):
    drawings = [dr for dr in page.get_drawings() if dr.get("fill")]
    spans = [s for b in page.get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"]
             if s["text"].strip()]

    floors = [dr for dr in drawings if color_kind(dr["fill"]) == "floor"]
    plan = pymupdf.Rect(floors[0]["rect"])
    for dr in floors[1:]:
        plan |= dr["rect"]
    plan_x = plan + (-4, -4, 4, 4)

    def span_center(s):
        x0, y0, x1, y1 = s["bbox"]
        return pymupdf.Point((x0 + x1) / 2, (y0 + y1) / 2)

    in_plan = [dr for dr in drawings if inside(dr["rect"], plan_x) and color_kind(dr["fill"]) != "floor"]

    # --- плашки: прямоугольник (4 линии / re) с текстом внутри
    tags = []
    for dr in in_plan:
        r = dr["rect"]
        kind = color_kind(dr["fill"])
        if kind in ("white", "floor") or not (6 <= r.height <= 60 and r.width >= 10):
            continue
        if len(dr["items"]) > 6:
            continue
        txt = [s for s in spans if r.contains(span_center(s))]
        if not txt:
            continue
        txt.sort(key=lambda s: (round(s["bbox"][1]), s["bbox"][0]))
        raw = "".join(s["text"] for s in txt)
        if any(abs(t["rect"].x0 - r.x0) < 0.5 and abs(t["rect"].y0 - r.y0) < 0.5
               and abs(t["rect"].x1 - r.x1) < 0.5 for t in tags):
            continue  # на некоторых этажах плашки продублированы
        tags.append({"rect": r, "kind": kind, "raw": raw, "text": decode(raw), "dr": dr})
    tag_rects = [t["rect"] for t in tags]

    # --- иконки: квадраты 12-30pt без текста
    icons = []
    for dr in in_plan:
        r = dr["rect"]
        kind = color_kind(dr["fill"])
        if kind in ("white",) or any(r == tr for tr in tag_rects):
            continue
        if 11 <= r.width <= 30 and 11 <= r.height <= 30 and abs(r.width - r.height) < 6:
            if len(dr["items"]) <= 6 and not any(r.contains(span_center(s)) for s in spans):
                icons.append({"rect": r, "kind": kind, "parts": []})
    for dr in in_plan:
        for ic in icons:
            if inside(dr["rect"], ic["rect"], 1):
                ic["parts"].append(dr)
                break

    used = set()
    for t in tags:
        used.add(id(t["dr"]))
    for ic in icons:
        for dr in ic["parts"]:
            used.add(id(dr))

    walls, voids = [], []
    for dr in in_plan:
        if id(dr) in used:
            continue
        k = color_kind(dr["fill"])
        r = dr["rect"]
        # белые мелочи внутри плашек (глифы) и прочие остатки пропускаем
        if any(inside(r, tr, 1) for tr in tag_rects):
            continue
        if k == "dark":
            walls.append(dr)
        elif k == "white" and r.width > 40 and r.height > 40:
            voids.append(dr)

    # --- сегментация
    floor_mask = rasterize(page.rect, floors)
    wall_mask = rasterize(page.rect, walls)
    void_mask = rasterize(page.rect, voids) if voids else np.zeros_like(floor_mask)
    wm = wall_mask.astype(np.uint8) * 255
    seg_cache = {}

    def segmentation(door):
        if door not in seg_cache:
            L = int(door * Z)
            closed = cv2.morphologyEx(wm, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (L, 1)))
            closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, L)))
            free = floor_mask & (closed == 0) & ~void_mask
            seg_cache[door] = cv2.connectedComponents(free.astype(np.uint8), connectivity=4)[1]
        return seg_cache[door]

    def component_at(labels, rect):
        # плашка сама по себе «пол» (её нет в стенах), берём самую частую метку под ней
        x0, y0 = int(rect.x0 * Z), int(rect.y0 * Z)
        x1, y1 = int(rect.x1 * Z), int(rect.y1 * Z)
        win = labels[max(0, y0):y1, max(0, x0):x1]
        vals, cnt = np.unique(win[win > 0], return_counts=True)
        return int(vals[np.argmax(cnt)]) if len(vals) else 0

    def contour_of(labels, label):
        m = (labels == label).astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cs, key=cv2.contourArea)
        area = cv2.contourArea(c)
        hull = cv2.contourArea(cv2.convexHull(c)) or 1
        c = cv2.approxPolyDP(c, 1.2 * Z, True)
        pts = [[round(float(p[0][0]) / Z * S, 1), round(float(p[0][1]) / Z * S, 1)] for p in c]
        return pts, area / Z / Z, area / hull

    def room_shape(rect):
        """Перебираем ширину проёма, пока контур не станет «комнатным»."""
        best = None
        for door in DOORS:
            labels = segmentation(door)
            lab = component_at(labels, rect)
            if not lab:
                continue
            pts, area, solidity = contour_of(labels, lab)
            cand = (pts, area, solidity, door, (door, lab))
            if solidity > 0.85 and area < MAX_ROOM:
                return cand
            if best is None or solidity > best[2] + 0.05:
                best = cand
        return best or ([], 0, 0, None, None)

    # --- пары «название над кодом»
    code_re = re.compile(r"^(B\d{3,4}|F\d{3})$")
    by_rect = sorted(tags, key=lambda t: (t["rect"].y0, t["rect"].x0))
    rooms, labels_out = [], []
    consumed = set()
    for t in by_rect:
        if id(t) in consumed:
            continue
        code = t["text"].replace(" ", "")
        if code_re.match(code):
            # ищем плашку-название прямо над ней
            name = None
            for u in by_rect:
                if u is t or id(u) in consumed:
                    continue
                if abs(u["rect"].y1 - t["rect"].y0) < 2.5 and abs(u["rect"].x0 - t["rect"].x0) < 2.5:
                    name = u
                    break
            consumed.add(id(t))
            if name:
                consumed.add(id(name))
            label = name["text"] if name else ""
            kind = name["kind"] if name else "dark"
            anchor = name["rect"] | t["rect"] if name else t["rect"]
            rooms.append({"id": code, "label": label, "color": kind, "anchor": anchor})
        else:
            # одиночная плашка без кода
            m = re.match(r"^Аудитория «(.+?)»?$", t["text"])
            if m:
                consumed.add(id(t))
                rooms.append({"id": m.group(1).strip("«» "), "label": "Аудитория", "color": t["kind"], "anchor": t["rect"]})

    for t in by_rect:
        if id(t) in consumed:
            continue
        labels_out.append({"text": t["text"], "color": t["kind"],
                           "x": round((t["rect"].x0 + t["rect"].x1) / 2 * S, 1),
                           "y": round((t["rect"].y0 + t["rect"].y1) / 2 * S, 1),
                           "big": t["rect"].height > 30})

    out_rooms = []
    seen_label = {}
    for r in rooms:
        pts, area, sol, _door, key = room_shape(r["anchor"])
        if sol <= 0.85 and area >= MAX_ROOM and r["id"] not in HALLS:
            pts, key = [], None  # протекло в коридор: оставляем только подпись
        seen_label.setdefault(key, []).append(r["id"])
        a = r["anchor"]
        out_rooms.append({
            "id": r["id"], "label": r["label"], "color": r["color"],
            "pts": pts, "area": round(area),
            "tag": [round((a.x0 + a.x1) / 2 * S, 1), round((a.y0 + a.y1) / 2 * S, 1)],
        })
    shared = {k: v for k, v in seen_label.items() if len(v) > 1}

    out_icons = []
    for ic in icons:
        r = ic["rect"]
        cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
        out_icons.append({
            "x": round(cx * S, 1), "y": round(cy * S, 1),
            "parts": [{"d": path_d(dr, (cx, cy)), "c": color_kind(dr["fill"]),
                       "eo": bool(dr.get("even_odd"))} for dr in ic["parts"]],
        })

    return {
        "n": floor_n,
        "extent": [round(v * S, 1) for v in (plan.x0 - 20, plan.y0 - 20, plan.x1 + 20, plan.y1 + 20)],
        "floorPaths": [{"d": path_d(dr), "eo": bool(dr.get("even_odd"))} for dr in floors],
        "wallPaths": [{"d": path_d(dr), "eo": bool(dr.get("even_odd"))} for dr in walls],
        "voidPaths": [{"d": path_d(dr), "eo": bool(dr.get("even_odd"))} for dr in voids],
        "rooms": out_rooms,
        "labels": labels_out,
        "icons": out_icons,
    }, shared


def main():
    doc = pymupdf.open(SRC)
    floors = {}
    for i in range(1, len(doc)):
        page = doc[i]
        title = decode(page.get_text().split("\n")[1]) if page.get_text() else ""
        m = re.search(r"(\d+)", title)
        n = int(m.group(1)) if m else i
        data, shared = parse_page(page, n)
        floors[n] = data
        big = [r["id"] for r in data["rooms"] if r["area"] > 25000]
        empty = [r["id"] for r in data["rooms"] if not r["pts"]]
        print(f"Этаж {n}: помещений {len(data['rooms'])}, подписей {len(data['labels'])}, "
              f"иконок {len(data['icons'])}, стен {len(data['wallPaths'])}"
              + (f"; общие контуры {list(shared.values())}" if shared else "")
              + (f"; подозрительно большие {big}" if big else "")
              + (f"; без контура {empty}" if empty else ""))

    payload = {"id": "DUCAT", "name": "Дукат", "short": "Дукат", "floors": floors}
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("/* Сгенерировано scripts/parse_ducat.py из PDF-плана. Не править руками. */\n")
        f.write("window.CAMPUSES = window.CAMPUSES || {};\nwindow.CAMPUSES.DUCAT = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"-> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
