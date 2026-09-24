"""Проверка доступа к Яндекс Календарю по CalDAV и формата событий.

Ничего не сохраняет: печатает список календарей и события на ближайшие дни,
чтобы понять, какие поля (название, время, место) там заполнены.

    YANDEX_LOGIN=ivanov@edu.example.ru python3 scripts/caldav_probe.py [дней] [--expand]

--expand просит сервер самому развернуть повторы в отдельные занятия.

Пароль спрашивается интерактивно (пароль приложения, тип «Календарь»)
или берётся из YANDEX_APP_PASSWORD.
"""

import base64
import datetime as dt
import getpass
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BASE = "https://caldav.yandex.ru"
NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav"}


def request(method, url, auth, body, depth):
    req = urllib.request.Request(
        urllib.parse.urljoin(BASE, url),
        data=body.encode(),
        method=method,
        headers={
            "Authorization": auth,
            "Content-Type": "application/xml; charset=utf-8",
            "Depth": depth,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return ET.fromstring(resp.read())


def propfind(url, auth, prop, depth="0"):
    body = f'<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>{prop}</d:prop></d:propfind>'
    return request("PROPFIND", url, auth, body, depth)


def href_of(tree, path):
    node = tree.find(f".//{path}/d:href", NS)
    if node is None:
        sys.exit(f"В ответе нет {path}")
    return node.text


def unfold(ics):
    lines = []
    for line in ics.replace("\r\n", "\n").split("\n"):
        if line[:1] in (" ", "\t") and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    return lines


def events(ics):
    event = None
    for line in unfold(ics):
        if line == "BEGIN:VEVENT":
            event = {"ATTENDEE": 0}
        elif line == "END:VEVENT" and event is not None:
            yield event
            event = None
        elif event is not None and ":" in line:
            key, value = line.split(":", 1)
            name = key.split(";", 1)[0]
            if name == "ATTENDEE":
                event["ATTENDEE"] += 1
            elif name in ("SUMMARY", "DTSTART", "DTEND", "LOCATION", "ORGANIZER", "DESCRIPTION", "RRULE", "UID", "RECURRENCE-ID"):
                event.setdefault(name, value.replace("\\n", " ").replace("\\,", ","))


def main():
    args = [a for a in sys.argv[1:] if a != "--expand"]
    expand = "--expand" in sys.argv
    days = int(args[0]) if args else 7
    login = os.environ.get("YANDEX_LOGIN") or input("Логин (почта): ").strip()
    password = os.environ.get("YANDEX_APP_PASSWORD") or getpass.getpass("Пароль приложения: ")
    auth = "Basic " + base64.b64encode(f"{login}:{password}".encode()).decode()

    try:
        principal = href_of(propfind("/", auth, "<d:current-user-principal/>"), "d:current-user-principal")
        home = href_of(propfind(principal, auth, "<c:calendar-home-set/>"), "c:calendar-home-set")
        listing = propfind(home, auth, "<d:displayname/><d:resourcetype/>", depth="1")
    except urllib.error.HTTPError as e:
        sys.exit(f"CalDAV ответил {e.code} {e.reason}")

    start = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=days)
    fmt = "%Y%m%dT%H%M%SZ"
    expand_tag = f'<c:expand start="{start.strftime(fmt)}" end="{end.strftime(fmt)}"/>' if expand else ""
    query = (
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        f"<d:prop><c:calendar-data>{expand_tag}</c:calendar-data></d:prop>"
        '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
        f'<c:time-range start="{start.strftime(fmt)}" end="{end.strftime(fmt)}"/>'
        "</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"
    )

    for resp in listing.findall("d:response", NS):
        if resp.find(".//d:resourcetype/c:calendar", NS) is None:
            continue
        href = resp.find("d:href", NS).text
        name = resp.findtext(".//d:displayname", default="(без имени)", namespaces=NS)
        print(f"\n=== {name}  {href}")
        try:
            found = request("REPORT", href, auth, query, "1")
        except urllib.error.HTTPError as e:
            print(f"  REPORT: {e.code} {e.reason}")
            continue
        items = [ev for data in found.iterfind(".//c:calendar-data", NS) for ev in events(data.text or "")]
        items.sort(key=lambda ev: ev.get("DTSTART", ""))
        print(f"  событий за {days} дн.: {len(items)}")
        for ev in items:
            print(f"  {ev.get('DTSTART', '?')} - {ev.get('DTEND', '?')}  {ev.get('SUMMARY', '')}")
            if ev.get("RECURRENCE-ID"):
                print(f"    заменяет повтор от: {ev['RECURRENCE-ID']}")
            print(f"    место: {ev.get('LOCATION', '-')}  | участников: {ev['ATTENDEE']}  | повтор: {ev.get('RRULE', '-')}")
            print(f"    организатор: {ev.get('ORGANIZER', '-')}")
            if ev.get("DESCRIPTION"):
                print(f"    описание: {ev['DESCRIPTION'][:120]}")


if __name__ == "__main__":
    main()
