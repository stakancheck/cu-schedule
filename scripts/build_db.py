#!/usr/bin/env python3
"""Собирает базу расписания из xlsx.

Вход:  raspisanie-spiskom.xlsx (листы по неделям, одинаковая шапка).
Выход:
  data/schedule.csv  - одна строка на занятие, аудитории разложены в список;
  data/rooms.csv     - справочник аудиторий: кампус, этаж, число занятий;
  data/schedule.js   - компактная версия для веб-приложения (window.SCHEDULE).

Запуск: python3 scripts/build_db.py [путь_к_xlsx]
"""
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "raspisanie-spiskom.xlsx"
OUT = ROOT / "data"

HEADER = ["Дата", "День недели", "Начало", "Конец", "Курс", "Название",
          "Тип", "Поток", "Аудитория", "Преподаватели"]

# ЦТ: аудитории с префиксом крыла (N/S/E/W) и номером 2xx/3xx.
CT_RE = re.compile(r"^[NSEW][23]\d\d(\.\d)?$")


DUCAT_RE = re.compile(r"^[BF]\d{3,4}$")
DUCAT_NAMED = {"Агат", "Байкал", "Вега", "Сетунь", "Эльбрус"}  # аудитории башни F, 4 этаж


def norm_room(code: str) -> str:
    """S202-1 -> S202.1 (как на табличках ЦТ), кириллическая «В114» -> B114."""
    code = code.strip()
    code = re.sub(r"^В(\d)", r"B\1", code)
    return re.sub(r"^([NSEW]\d{3})-(\d)$", r"\1.\2", code)


def campus_of(room: str) -> str:
    if CT_RE.match(room):
        return "CT"
    if DUCAT_RE.match(room) or room in DUCAT_NAMED:
        return "DUCAT"
    return "OTHER"  # например, «Лекторий»: на планах не нашли


def floor_of(room: str) -> str:
    if room in DUCAT_NAMED:
        return "4"
    m = re.match(r"^[A-Z](\d{3,4})", room)
    if not m:
        return ""
    return m.group(1)[:-2]  # B1004 -> 10, B420 -> 4


def main() -> None:
    wb = openpyxl.load_workbook(SRC, read_only=True)
    events = []
    seen = set()
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        head = next(rows)
        if list(head[:10]) != HEADER:
            raise SystemExit(f"Неожиданная шапка на листе {ws.title}: {head}")
        for r in rows:
            if not r or not r[0]:
                continue
            date, _dow, start, end, course, title, kind, stream, room_raw, teachers = (
                "" if v is None else str(v).strip() for v in r[:10])
            if room_raw in ("", "Не указано"):
                rooms = []
            else:
                rooms = [norm_room(x) for x in room_raw.split("+") if x.strip()]
            key = (date, start, end, title, tuple(rooms), stream, teachers)
            if key in seen:  # в исходнике есть полные дубли строк
                continue
            seen.add(key)
            events.append({
                "date": date, "start": start, "end": end,
                "course": "" if course == "0" else course,
                "title": title, "type": kind, "stream": stream,
                "rooms": rooms, "teachers": teachers, "week": ws.title,
            })

    events.sort(key=lambda e: (e["date"], e["start"], e["end"], ",".join(e["rooms"])))
    OUT.mkdir(exist_ok=True)

    with open(OUT / "schedule.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "start", "end", "title", "course", "type", "stream",
                    "rooms", "campus", "teachers", "week"])
        for e in events:
            campuses = sorted({campus_of(x) for x in e["rooms"]}) or ["NONE"]
            w.writerow([e["date"], e["start"], e["end"], e["title"], e["course"],
                        e["type"], e["stream"], ";".join(e["rooms"]),
                        ";".join(campuses), e["teachers"], e["week"]])

    room_count = Counter(x for e in events for x in e["rooms"])
    with open(OUT / "rooms.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["room", "campus", "floor", "events"])
        for room in sorted(room_count):
            w.writerow([room, campus_of(room), floor_of(room), room_count[room]])

    # Компактный формат: строковые поля через словарь, событие = массив индексов.
    dict_, idx = [], {}

    def s(v: str) -> int:
        if v not in idx:
            idx[v] = len(dict_)
            dict_.append(v)
        return idx[v]

    compact = [[e["date"], e["start"], e["end"], s(e["title"]), s(e["course"]),
                s(e["type"]), s(e["stream"]), [s(x) for x in e["rooms"]],
                s(e["teachers"])] for e in events]
    payload = {
        "source": SRC.name,
        "fields": ["date", "start", "end", "title", "course", "type", "stream",
                   "rooms", "teachers"],
        "strings": dict_,
        "events": compact,
    }
    with open(OUT / "schedule.js", "w", encoding="utf-8") as f:
        f.write("window.SCHEDULE=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    ct = sum(1 for e in events if any(campus_of(x) == "CT" for x in e["rooms"]))
    du = sum(1 for e in events if any(campus_of(x) == "DUCAT" for x in e["rooms"]))
    print(f"Событий: {len(events)} (ЦТ: {ct}, Дукат: {du}), аудиторий: {len(room_count)}")


if __name__ == "__main__":
    main()
