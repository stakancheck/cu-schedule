// Сессия - зашифрованный (AES-GCM) токен, который хранит только браузер студента.
// Сервер ничего не хранит: всё нужное для входа в CalDAV лежит внутри токена,
// прочитать его можно только ключом SESSION_KEY. Смена ключа завершает все сессии.

import { HttpError } from "./caldav.js";

const b64url = {
  encode(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const keys = new Map();
async function key(secret) {
  if (!secret) throw new HttpError(500, "config", "На сервере не задан SESSION_KEY");
  if (!keys.has(secret)) {
    const raw = b64url.decode(secret.replace(/=+$/, ""));
    if (raw.length !== 32) throw new HttpError(500, "config", "SESSION_KEY должен быть 32 байта в base64");
    keys.set(secret, await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return keys.get(secret);
}

export async function seal(payload, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ ...payload, v: 1, iat: Date.now() }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64url.encode(out);
}

export async function unseal(token, secret) {
  try {
    const bytes = b64url.decode(token);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await key(secret), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, "session", "Сессия недействительна, войдите заново");
  }
}
