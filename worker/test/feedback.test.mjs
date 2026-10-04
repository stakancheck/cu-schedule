// Обращения: проверка, ловушка, повторы и разметка issue. GitHub подменяем.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { buildIssue, parseFeedback } from "../src/feedback.js";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";
const env = { GITHUB_TOKEN: "t", GITHUB_REPO: "o/r", ALLOWED_ORIGINS: "" };

function post(body, ip = "1.1.1.1") {
  return worker.fetch(new Request("http://x/v1/feedback", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA, "CF-Connecting-IP": ip }, body: JSON.stringify(body),
  }), env);
}
const ok = (extra = {}) => ({
  kind: "map", text: "На плане нет двери в кухню на втором этаже, она там есть", consent: true, took: 9000,
  pin: { campus: "CT", floor: 2, x: 1200.34, y: 800.5, room: "B311", near: "Кухня" },
  device: { app: "abc123", viewport: [390, 700], screen: [390, 844], dpr: 3, lang: "ru-RU", theme: "dark", touch: true }, ...extra,
});

function mockGithub() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/issues/7" }), { status: 201 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("обращение превращается в issue с координатами и устройством", async () => {
  const gh = mockGithub();
  try {
    const res = await post(ok({ contact: "@student" }), "2.2.2.2");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, number: 7, url: "https://github.com/o/r/issues/7" });
    const c = gh.calls[0];
    assert.equal(c.url, "https://api.github.com/repos/o/r/issues");
    assert.equal(c.init.headers.Authorization, "Bearer t");
    const { title, body, labels } = c.body;
    assert.match(title, /^\[План CT 2\] На плане нет двери/);
    assert.deepEqual(labels, ["feedback", "map-error", "campus:CT", "floor:2"]);
    assert.match(body, /1200\.3, 800\.5/);
    assert.match(body, /iOS 18, Safari 18/);
    assert.match(body, /`@student`/);
    const meta = JSON.parse(/<!-- cu-feedback (.*) -->/.exec(body)[1]);
    assert.equal(meta.pin.floor, 2);
    assert.equal(meta.pin.x, 1200.3);
    assert.equal(meta.device.os, "iOS 18");
    assert.equal("text" in meta, false);
  } finally { gh.restore(); }
});

test("ловушка и слишком быстрая отправка", async () => {
  const gh = mockGithub();
  try {
    const bot = await post(ok({ website: "http://spam" }), "3.3.3.3");
    assert.equal(bot.status, 200);
    assert.equal(gh.calls.length, 0);
    const fast = await post(ok({ took: 500 }), "3.3.3.4");
    assert.equal(fast.status, 429);
  } finally { gh.restore(); }
});

test("модерация и согласие", async () => {
  const gh = mockGithub();
  try {
    assert.equal((await post(ok({ text: "это хуйня полная а не план" }), "4.4.4.4")).status, 422);
    assert.equal((await post(ok({ consent: false }), "4.4.4.4")).status, 422);
    assert.equal((await post(ok({ pin: { campus: "XX", floor: 1, x: 1, y: 1 } }), "4.4.4.4")).status, 400);
    assert.equal(gh.calls.length, 0);
  } finally { gh.restore(); }
});

test("повтор и частота", async () => {
  const gh = mockGithub();
  try {
    const t = "Лестница на 5 этаже показана не там, где она на самом деле";
    assert.equal((await post(ok({ text: t }), "5.5.5.5")).status, 200);
    assert.equal((await post(ok({ text: t }), "5.5.5.6")).status, 409);
    for (const n of [1, 2]) assert.equal((await post(ok({ text: `Туалет на этаже ${n} подписан неправильно на плане` }), "5.5.5.5")).status, 200);
    assert.equal((await post(ok({ text: "Ещё одно замечание про вход в здание со двора" }), "5.5.5.5")).status, 429);
  } finally { gh.restore(); }
});

test("текст в issue обезврежен", () => {
  const f = parseFeedback(ok({ text: "Привет, смотри #5 и *жирный* текст на плане здесь [ссылка](x)" }), UA);
  const { body } = buildIssue(f, "fp");
  assert.ok(!body.includes("#5 ") && !body.includes("*жирный*"));
  assert.ok(!/-->.*-->/s.test(body));
});

test("без токена приём выключен", async () => {
  const r = await worker.fetch(new Request("http://x/v1/feedback", { method: "POST", body: "{}" }), {});
  assert.equal(r.status, 503);
});
