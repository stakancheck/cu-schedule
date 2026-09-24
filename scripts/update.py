#!/usr/bin/env python3
"""Скачивает свежее расписание с cu-schedule.ru и пересобирает базу, если оно изменилось.

Источник: та же выгрузка, что кнопка «Скачать Excel -> Списком -> Всё расписание».
Изменение определяем по sha256 файла (сервер не поддерживает If-Modified-Since).

Код выхода 0 в обоих случаях. Для GitHub Actions пишет в $GITHUB_OUTPUT
changed=true|false и message=<строка для коммита>, а сводку в $GITHUB_STEP_SUMMARY.

Запуск: python3 scripts/update.py [--force]
"""
import csv
import hashlib
import os
import sys
import tempfile
import urllib.request
from collections import Counter
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "raspisanie-spiskom.xlsx"
CSV = ROOT / "data/schedule.csv"
URL = "https://cu-schedule.ru/api/timetable/export?format=list&scope=all"
UA = "cu-schedule-updater (+https://github.com/stakancheck/cu-schedule)"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


def download(dst: Path) -> str:
    req = urllib.request.Request(URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        ctype = resp.headers.get("Content-Type", "")
        if "spreadsheetml" not in ctype:
            raise SystemExit(f"Сервер вернул не xlsx: {ctype!r}")
        dst.write_bytes(resp.read())
        return resp.headers.get("Last-Modified", "")


def read_events(path: Path) -> Counter:
    if not path.exists():
        return Counter()
    with open(path, encoding="utf-8") as f:
        return Counter((r["date"], r["start"], r["end"], r["title"], r["rooms"]) for r in csv.DictReader(f))


def emit(**kv) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


def main() -> None:
    force = "--force" in sys.argv
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / "fresh.xlsx"
        last_modified = download(fresh)
        if not force and sha256(fresh) == sha256(XLSX):
            summary(f"Расписание не изменилось (сервер: {last_modified or 'нет даты'}).")
            emit(changed="false")
            return

        before = read_events(CSV)
        XLSX.write_bytes(fresh.read_bytes())

    updated = ""
    if last_modified:
        updated = parsedate_to_datetime(last_modified).isoformat()
    os.environ["SCHEDULE_UPDATED_AT"] = updated

    sys.path.insert(0, str(ROOT / "scripts"))
    import build_db  # noqa: E402  (шапку xlsx проверяет сам build_db)
    build_db.SRC = XLSX
    build_db.main()

    after = read_events(CSV)
    added, removed = after - before, before - after
    dates = sorted({k[0] for k in (added + removed)})
    span = f"{dates[0]} – {dates[-1]}" if dates else "нет"
    if added or removed:
        msg = f"Обновление расписания: +{sum(added.values())} −{sum(removed.values())} пар"
    else:
        msg = "Обновление расписания: изменены детали пар"
    summary(f"### {msg}\n\nДанные сервера от: {last_modified or 'нет даты'}\n\nЗатронутые даты: {span}")
    for title, sign, items in (("Добавлены", "+", added), ("Удалены", "−", removed)):
        if items:
            summary(f"\n**{title}** (первые 15):")
            for k in sorted(items)[:15]:
                summary(f"- {sign} {k[0]} {k[1]}–{k[2]} {k[4] or 'без аудитории'}: {k[3]}")
    emit(changed="true", message=msg)


if __name__ == "__main__":
    main()
