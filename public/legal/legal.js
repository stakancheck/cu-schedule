/* Реквизиты оператора и версия документов: правятся здесь, один раз для всех страниц.
   Пока поле не заполнено, на странице видна красная заглушка. */
(function () {
  var CONFIG = {
    name: "Суханов Артём Алексеевич",            // ФИО оператора (физическое лицо) полностью
    email: "stakancheck@gmail.com",           // почта для обращений
    tg: "stakancheck",   // Telegram без @
    version: "1.0",
    date: "4 октября 2026 г.",
    site: "https://stakancheck.github.io/cu-schedule/",
  };
  var TODO = { name: "[ФИО оператора]", email: "[почта для обращений]" };
  function fill(el) {
    var k = el.getAttribute("data-op");
    var v = CONFIG[k];
    if (k === "tg") {
      el.innerHTML = '<a href="https://t.me/' + v + '">@' + v + "</a>";
    } else if (k === "email" && v) {
      el.innerHTML = '<a href="mailto:' + v + '">' + v + "</a>";
    } else if (k === "site") {
      el.innerHTML = '<a href="' + v + '">' + v + "</a>";
    } else if (v) {
      el.textContent = v;
    } else {
      el.textContent = TODO[k] || "";
      el.className = "todo";
    }
  }
  document.querySelectorAll("[data-op]").forEach(fill);
})();
