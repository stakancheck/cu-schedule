#!/usr/bin/env python3
"""Парсер PDF-планов кампусов -> js/plans-<кампус>.js.

Оба плана (Дукат и ЦТ) сделаны по одному шаблону: 1 страница описания
+ по странице на этаж.
  * пол      - серая заливка (0.9);
  * стены    - тёмные заливки вне плашек и иконок;
  * плашки   - прямоугольники с текстом (цвет = тип помещения), под
               цветной плашкой с названием лежит чёрная с кодом;
  * иконки   - квадраты 12-30pt без текста, забираем векторы как есть;
  * улицы    - серые пунктиры и подписи вокруг здания (есть только у ЦТ).
Контуры помещений ищем растровой сегментацией: стены рисуем в маску,
дверные проёмы закрываем морфологией по линиям, берём компоненту под
плашкой кода и векторизуем её контур.

Текст в PDF закодирован со сдвигом: кириллица лежит в 0x10-0x4F,
часть заглавных подменена глифами Mac-кодировки. Декодируем эвристикой.

Запуск:
  python3 scripts/parse_plan.py ducat [plan-ducat.pdf]
  python3 scripts/parse_plan.py ct [ЦТ_план.pdf]
"""
import json
import re
import sys
from pathlib import Path

import cv2
import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parent.parent

CAMPUSES = {
    "ducat": {
        "id": "DUCAT", "name": "Дукат", "short": "Дукат",
        "src": "Downloads/plan-ducat.pdf", "out": "js/plans-ducat.js",
        "code": r"^(B\d{3,4}|F\d{3})$",
        "halls": {"F101", "B1004", "B1006"},  # действительно большие залы
        "doors": [26, 40, 60, 90],  # пробуемые ширины проёмов, pt
        "angles": [0, 90],          # направления стен, градусы
    },
    "ct": {
        "id": "CT", "name": "Центральный телеграф", "short": "ЦТ",
        "src": "Downloads/ЦТ_план.pdf", "out": "js/plans-ct.js",
        "code": r"^[NSEW]\d{3}(\.\d)?$",
        "halls": set(),
        "class_label": "Аудитория",  # учебные показываем, даже если пар в них нет
        "doors": [12, 18, 26, 40],  # стены тонкие, проёмы узкие, коридоры тоже
        # южное крыло повёрнуто на ~6°, восточное на ~13° от вертикали
        "angles": [0, -3, -6, -9, 3, 90, 77, 81, 85, 95, 99, 103],
    },
}

S = 2.5      # масштаб pt -> единицы плана
Z = 4        # масштаб растра для сегментации (px на pt)
MAX_ROOM = 30000          # pt^2: больше - скорее всего протекли в коридор
OPEN = 10                 # pt: отростки уже этого срезаем

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
    # ЦТ: коды лежат обычным ASCII, N/S/E/W + номер, бывает с «.1»
    if re.fullmatch(r"[NSEW]\d{3}(\.\d)?[,.]?", w):
        return w
    if re.fullmatch(r"[\d\x13,.\-–]+", w):
        return w.replace("\x13", "–")
    if re.fullmatch(r"[FNSEW]\d{3}\x13[FNSEW]\d{3}", w):
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
    (r"\b(есепш|адиост)", r"Р\1"),
    (r"(?<=[а-яё])\((?=[а-яё])", " "),  # перенос строки внутри плашки
    (r"\s*\($", ""),
    (r"^на (\d)-9$", r"на \1-й"),  # «й» лежит в 0x39, как цифра 9
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
    if b > 0.9 and r < 0.6 and g < 0.45:
        return "staff"      # фиолетовый ЦТ
    if g > 0.7 and b > 0.7 and r < 0.5:
        return "wip"        # голубой «Work in progress» ЦТ
    if abs(r - g) < 0.02 and abs(g - b) < 0.02 and 0.3 < r < 0.7:
        return "gray"       # улицы, стрелки, их подписи
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


def line_kernel(length, angle):
    """Отрезок под углом: закрывает проём в стене, идущей под этим углом."""
    a = np.radians(angle)
    dx, dy = np.cos(a) * length / 2, np.sin(a) * length / 2
    w, h = int(abs(dx)) * 2 + 1, int(abs(dy)) * 2 + 1
    k = np.zeros((h, w), np.uint8)
    cv2.line(k, (int(w / 2 - dx), int(h / 2 - dy)), (int(w / 2 + dx), int(h / 2 + dy)), 1, 1)
    return k


def inside(inner, outer, tol=0.5):
    return (inner.x0 >= outer.x0 - tol and inner.y0 >= outer.y0 - tol
            and inner.x1 <= outer.x1 + tol and inner.y1 <= outer.y1 + tol)


def parse_page(page, floor_n, cfg):
    drawings = [dr for dr in page.get_drawings() if dr.get("fill")]
    spans = [{**s, "dir": l["dir"], "block": bi} for bi, b in enumerate(page.get_text("dict")["blocks"])
             for l in b.get("lines", []) for s in l["spans"] if s["text"].strip()]

    floors = [dr for dr in drawings if color_kind(dr["fill"]) == "floor"]
    plan = pymupdf.Rect(floors[0]["rect"])
    for dr in floors[1:]:
        plan |= dr["rect"]
    plan_x = plan + (-4, -4, 4, 4)

    def span_center(s):
        x0, y0, x1, y1 = s["bbox"]
        return pymupdf.Point((x0 + x1) / 2, (y0 + y1) / 2)

    in_plan = [dr for dr in drawings if inside(dr["rect"], plan_x) and color_kind(dr["fill"]) != "floor"]

    # --- плашки: прямоугольник (4 линии / re) с текстом внутри; могут
    # выступать за контур здания и стоять вертикально
    tags = []
    for dr in drawings:
        r = dr["rect"]
        kind = color_kind(dr["fill"])
        if not r.intersects(plan) or kind in ("white", "floor", "gray"):
            continue
        vertical = 6 <= r.width <= 30 and r.height >= 40 and r.height > 2 * r.width
        if not (6 <= r.height <= 60 and r.width >= 10) and not vertical:
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
        tags.append({"rect": r, "kind": kind, "raw": raw, "text": decode(raw), "dr": dr,
                     "vertical": vertical, "fs": max(s["size"] for s in txt)})
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
            closed = wm
            for a in cfg["angles"]:
                closed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, line_kernel(door * Z, a))
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
        # срезаем узкие отростки в ниши и проёмы соседних кладовок
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((OPEN * Z, OPEN * Z), np.uint8))
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cs, key=cv2.contourArea)
        area = cv2.contourArea(c)
        hull = cv2.contourArea(cv2.convexHull(c)) or 1
        c = cv2.approxPolyDP(c, 1.2 * Z, True)
        pts = [[round(float(p[0][0]) / Z * S, 1), round(float(p[0][1]) / Z * S, 1)] for p in c]
        return pts, area / Z / Z, area / hull

    def room_shape(rect, rivals):
        """Перебираем ширину проёма, пока контур не станет «комнатным».
        Компонента, под которой лежит плашка другой аудитории, точно протекла."""
        best = None
        for door in cfg["doors"]:
            labels = segmentation(door)
            lab = component_at(labels, rect)
            if not lab or any(component_at(labels, o) == lab for o in rivals):
                continue
            pts, area, solidity = contour_of(labels, lab)
            cand = (pts, area, solidity, door, (door, lab))
            if solidity > 0.85 and area < MAX_ROOM:
                return cand
            if best is None or solidity > best[2] + 0.05:
                best = cand
        return best or ([], 0, 0, None, None)

    # --- пары «название над кодом»
    code_re = re.compile(cfg["code"])
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
                           "big": t["rect"].height > 30 or (t["fs"] > 8 and not t["vertical"]),
                           **({"vertical": True} if t["vertical"] else {})})

    out_rooms = []
    seen_label = {}
    for r in rooms:
        pts, area, sol, _door, key = room_shape(r["anchor"], [o["anchor"] for o in rooms if o is not r])
        if sol <= 0.85 and area >= MAX_ROOM and r["id"] not in cfg["halls"]:
            pts, key = [], None  # протекло в коридор: оставляем только подпись
        seen_label.setdefault(key, []).append(r["id"])
        a = r["anchor"]
        out_rooms.append({
            "id": r["id"], "label": r["label"], "color": r["color"],
            "pts": pts, "area": round(area),
            **({"kind": "class"} if pts and r["label"] == cfg.get("class_label") else {}),
            "tag": [round((a.x0 + a.x1) / 2 * S, 1), round((a.y0 + a.y1) / 2 * S, 1)],
        })
    shared = {k: v for k, v in seen_label.items() if len(v) > 1}

    # --- улицы и стрелки: серые векторы. Подписи к ним нарисованы глифами,
    # но под ними лежит текстовый слой: берём его, чтобы подписи не
    # переворачивались вместе с планом.
    legend = [s for s in spans if re.match(r"Помещения|Кухни, вендинги", decode(s["text"]))]
    legend_top = min((s["bbox"][1] for s in legend), default=page.rect.y1)
    free = []
    for s in spans:
        c = span_center(s)
        if s["bbox"][0] < plan.x0 - 10 or c.y > legend_top - 1 or any(tr.contains(c) for tr in tag_rects):
            continue
        if any(ic["rect"].contains(c) for ic in icons):
            continue
        text = decode(s["text"])
        if re.search(r"\w", text):
            free.append((s, text))
    free_rects = [pymupdf.Rect(s["bbox"]) for s, _ in free]
    # описание этажа: колонка слева от плана под заголовком «Этаж N»
    title = next((s for s in spans if re.match(r"Этаж", decode(s["text"]))), None)
    side = sorted((s for s in spans if title and s["bbox"][2] < plan.x0 and s["bbox"][1] > title["bbox"][3]
                   and s["bbox"][3] < legend_top - 1), key=lambda s: s["bbox"][1])
    summary = ""
    for s_ in side:
        t = decode(s_["text"])
        summary += (" " if summary.endswith(",") else ", " if summary else "") + t
    street_paths, decor_paths = [], []
    for dr in drawings:
        if color_kind(dr["fill"]) != "gray":
            continue
        r = dr["rect"]
        near = [fr for fr in free_rects if fr.intersects(r)]
        if near:
            u = near[0]
            for fr in near[1:]:
                u |= fr
            if inside(r, u, 3):
                continue  # глифы подписи
        (decor_paths if inside(r, plan_x) else street_paths).append(
            {"d": path_d(dr), "eo": bool(dr.get("even_odd"))})
    # Названия улиц и наклонные подписи стрелок идут вдоль линии, прочее
    # (метро, «на 3-й») - блоком строк, который всегда стоит вертикально.
    street_texts, decor_texts = [], []
    blocks = {}
    for s, text in free:
        c = span_center(s)
        dx, dy = s["dir"]
        angle = round(np.degrees(np.arctan2(dy, dx)), 1)
        dst = decor_texts if plan.contains(c) else street_texts
        if angle or re.search(r"улица|переулок|проспект|площадь", text):
            dst.append({"text": text, "x": round(c.x * S, 1), "y": round(c.y * S, 1),
                        "angle": angle, "size": round(s["size"] * S, 1)})
        else:
            blocks.setdefault((id(dst), s["block"]), (dst, []))[1].append((s, text))
    for dst, items in blocks.values():
        box = pymupdf.Rect(items[0][0]["bbox"])
        for s, _ in items[1:]:
            box |= s["bbox"]
        cx, cy = (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2
        dst.append({"x": round(cx * S, 1), "y": round(cy * S, 1), "size": round(items[0][0]["size"] * S, 1),
                    "lines": [{"text": t, "dx": round((s["bbox"][0] - cx) * S, 1),
                               "dy": round((span_center(s).y - cy) * S, 1)} for s, t in items]})

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
        **({"summary": summary} if summary else {}),
        "extent": [round(v * S, 1) for v in (plan.x0 - 20, plan.y0 - 20, plan.x1 + 20, plan.y1 + 20)],
        "floorPaths": [{"d": path_d(dr), "eo": bool(dr.get("even_odd"))} for dr in floors],
        "wallPaths": [{"d": path_d(dr), "eo": bool(dr.get("even_odd"))} for dr in walls],
        "voidPaths": [{"d": path_d(dr), "eo": bool(dr.get("even_odd"))} for dr in voids],
        "rooms": out_rooms,
        "labels": labels_out,
        "icons": out_icons,
        "decorPaths": decor_paths,
        "decorTexts": decor_texts,
        "streets": {"paths": street_paths, "texts": street_texts},
    }, shared


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in CAMPUSES:
        sys.exit(f"Использование: {sys.argv[0]} {{{'|'.join(CAMPUSES)}}} [plan.pdf]")
    cfg = CAMPUSES[sys.argv[1]]
    src = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home() / cfg["src"]
    out = ROOT / cfg["out"]
    doc = pymupdf.open(src)
    floors = {}
    for i in range(1, len(doc)):
        page = doc[i]
        m = re.search(r"Этаж (-?\d+)", decode(page.get_text()))
        n = int(m.group(1)) if m else i
        data, shared = parse_page(page, n, cfg)
        floors[n] = data
        big = [r["id"] for r in data["rooms"] if r["area"] > 25000]
        empty = [r["id"] for r in data["rooms"] if not r["pts"]]
        print(f"Этаж {n}: помещений {len(data['rooms'])}, подписей {len(data['labels'])}, "
              f"иконок {len(data['icons'])}, стен {len(data['wallPaths'])}"
              + (f"; общие контуры {list(shared.values())}" if shared else "")
              + (f"; подозрительно большие {big}" if big else "")
              + (f"; без контура {empty}" if empty else ""))

    # улицы общие для кампуса: координаты страниц совпадают, а на части этажей их не рисовали
    streets = max((f.pop("streets") for f in floors.values()), key=lambda st: len(st["texts"]))
    payload = {"id": cfg["id"], "name": cfg["name"], "short": cfg["short"], "floors": floors}
    if streets["paths"] or streets["texts"]:
        payload["streets"] = streets
        # рамка: здание и подписи улиц (сами пунктиры уходят за край листа)
        e = [f["extent"] for f in floors.values()]
        xs = [t["x"] for t in streets["texts"]] + [v[0] for v in e] + [v[2] for v in e]
        ys = [t["y"] for t in streets["texts"]] + [v[1] for v in e] + [v[3] for v in e]
        x0, y0, x1, y1 = min(xs) - 40, min(ys) - 40, max(xs) + 40, max(ys) + 40
        payload["extent"] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    with open(out, "w", encoding="utf-8") as f:
        f.write(f"/* Сгенерировано scripts/parse_plan.py из PDF-плана. Не править руками. */\n")
        f.write(f"window.CAMPUSES = window.CAMPUSES || {{}};\nwindow.CAMPUSES.{cfg['id']} = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"-> {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
