// Способы входа. Каждый умеет две вещи: проверить данные при входе
// (login -> credentials) и превратить сохранённые credentials в заголовок для CalDAV.
// Всё остальное (события, отметки) одинаково для любого способа.
//
// Чтобы добавить вход через Яндекс ID (SSO университета), нужен провайдер "yandex":
//   - GET /v1/auth/yandex/start -> редирект на oauth.yandex.ru/authorize с доступом к календарю;
//   - GET /v1/auth/yandex/callback -> обмен code на access/refresh token (нужен секрет приложения);
//   - credentials = { access, refresh, exp }, authorization = "OAuth " + access;
//   - перед запросом, если exp прошёл, обновить токен по refresh и выдать клиенту новую сессию.
// Клиенту достаточно получить ту же сессию, что и при входе по паролю.

import { HttpError } from "./caldav.js";

const basic = (login, password) => {
  const bytes = new TextEncoder().encode(`${login}:${password}`);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return "Basic " + btoa(s);
};

export const providers = {
  caldav: {
    title: "Пароль приложения Яндекса",
    async login(body) {
      const login = String(body.login || "").trim().toLowerCase();
      const password = String(body.password || "").replace(/\s+/g, "");
      if (!/^[^@\s]+@[^@\s]+$/.test(login)) throw new HttpError(400, "bad_login", "Введите почту целиком, например ivanov@edu.centraluniversity.ru");
      if (!password) throw new HttpError(400, "bad_password", "Введите пароль приложения");
      return { login, password };
    },
    authorization: (c) => basic(c.login, c.password),
    emails: (c) => [c.login],
  },
};

export function provider(id) {
  const p = providers[id];
  if (!p) throw new HttpError(400, "bad_provider", `Неизвестный способ входа: ${id}`);
  return p;
}
