import test from "node:test";
import assert from "node:assert/strict";
import { moderateText, moderateContact, quote } from "../src/moderation.js";

const good = [
  "На 3 этаже ЦТ нет туалета рядом с N318, на плане он есть",
  "Дверь в B311 открывается в другую сторону, поправьте",
  "небанальная ошибка в подписи кухни на плане",
  "педикюр кабинет подписан неправильно на втором этаже",
  "аудитории 318 320 322 324 подписаны наоборот на плане",
  "при нажатии на лифт приложение зависает на айфоне",
  "Нет розетки у окна в коворкинге на 2 этаже",
];
const bad = {
  profanity: ["Это полная хуйня, план неверный", "х у й а не план совсем", "pizda а не карта", "this is shit and wrong"],
  code: ["<script>alert(1)</script> привет", "привет ' OR 1=1 -- как дела", "{{constructor}} тест тест"],
  gibberish: ["aaaaaaaaaaaaa bbbbb", "asdfghjkl qwerty zxcvb", "ыыыыыы жжжжж фффф", "Ошибка", "бзпстшщ кцнгшщзх фывапрол"],
  link: ["Смотри на https://spam.ru всё тут", "заходи на сайт example.com сейчас"],
  pii: ["звоните +7 999 123 45 67 пожалуйста срочно", "напишите @durov когда исправите пожалуйста", "пишите на test@mail.ru по этому поводу"],
  spam: ["Заработок на ставках без вложений каждый день", "Казино онлайн бонус каждому"],
  short: ["Ошибка"],
};

test("нормальные обращения проходят", () => {
  for (const t of good) assert.equal(moderateText(t).ok, true, t);
});
for (const [code, list] of Object.entries(bad)) {
  test("отклоняется: " + code, () => {
    for (const t of list) {
      const r = moderateText(t);
      assert.equal(r.ok, false, t);
      assert.ok(r.message);
    }
  });
}
test("лимит длины", () => assert.equal(moderateText("слово ".repeat(300)).code, "long"));
test("контакты", () => {
  for (const c of ["@stakancheck", "a@b.ru", "+7 (999) 123-45-67", "t.me/abcde", ""]) assert.equal(moderateContact(c).ok, true, c);
  for (const c of ["привет", "<b>", "x".repeat(200)]) assert.equal(moderateContact(c).ok, false, c);
  assert.equal(moderateContact("t.me/abcde").text, "@abcde");
});
test("цитата обезвреживает упоминания, ссылки на issue и разметку", () => {
  const q = quote("hi @user #12 <b> *x*\nline2");
  assert.ok(!/@user/.test(q) && !/#12/.test(q) && !/<b>/.test(q) && !/\*x\*/.test(q));
  assert.ok(q.split("\n").every((l) => l.startsWith("> ")));
});
