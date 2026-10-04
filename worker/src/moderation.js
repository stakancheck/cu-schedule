// Базовая модерация обращений: чистка текста, мат, скрипты и разметка, ссылки и персональные данные,
// спам, бессмыслица. Без внешних сервисов: только правила, как в обычных антиспам-фильтрах поддержки.
// Возвращает { ok, text } или { ok: false, code, message } с понятной причиной для автора.

export const LIMITS = { textMin: 10, textMax: 1000, contactMax: 80 };

const reject = (code, message) => ({ ok: false, code, message });

/* ------------------------------------------------------------ чистка */

// управляющие, невидимые и двунаправленные символы: ими прячут текст и ломают разметку
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function clean(s, { multiline = false } = {}) {
  let t = String(s ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(/\r\n?/g, "\n");
  t = multiline ? t.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n") : t.replace(/\s+/g, " ");
  return t.trim();
}

/* ------------------------------------------------------------ код и разметка */

const CODE = [
  /<\s*\/?\s*[a-z!][^>]*>/i,                       // любой HTML-тег
  /javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i,
  /\bon[a-z]{3,}\s*=\s*["'a-z(]/i,                 // onerror=, onload=
  /\b(?:eval|alert|prompt|confirm|document\.cookie|window\.location|fetch|XMLHttpRequest)\s*\(/i,
  /\b(?:union\s+select|select\s.+\sfrom|insert\s+into|drop\s+table|delete\s+from|or\s+1\s*=\s*1)\b/i,
  /\$\{[^}]*\}|\{\{[^}]*\}\}|<%|%>/,               // шаблонные вставки
  /(?:^|\s)(?:sudo|rm\s+-rf|curl|wget|powershell|cmd\.exe)\s/i,
  /\.\.\/|\.\.\\/,
  /```/,
];

/* ------------------------------------------------------------ ссылки и личные данные */

const URL_RE = /(?:https?:\/\/|www\.|ftp:\/\/)\S+|\b[a-z0-9][a-z0-9-]*\.(?:ru|com|net|org|io|me|xyz|top|club|site|online|shop|info|biz|cc|ly|gg|tk|su|рф)\b/i;
const EMAIL_RE = /[\w.+-]+\s*(?:@|\(at\)|\[at\]|собака)\s*[\w-]+\.[\w.-]+/i;
const HANDLE_RE = /(?:^|\s)@[a-z0-9_]{4,}/i;
const PHONE_RE = /(?:\+\d|\b[78]\s*[(.-]?)\s*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}/;

/* ------------------------------------------------------------ мат и оскорбления */

// похожие латинские буквы и цифры -> кириллица: «xуй», «п1зда», «b l y a d»
const HOMOGLYPHS = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у", "0": "о", "3": "з", "6": "б" };
const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[a-z0-9]/g, (c) => HOMOGLYPHS[c] || c);

// основы пишем с разрешёнными приставками, чтобы «небанальный» не принимался за мат
const PRE = "(?:|на|за|по|вы|до|об|от|подъ?|объ?|съ?|раз|рас|при|пере|про|не|вз|вс|ни|у|о|с|в|ис|из|недо|пиздо|хуе|еб|долбо|мозго|пизде)?";
const MAT = new RegExp("^" + PRE + "(?:хуй|хуя|хуе|хуи|хуев|хуит|пизд|пезд|ебан|ебат|ебал|ебну|ебла|ебуч|ебырь|еблан|ебло|ебись|бляд|блят|блять|бля|сука|суки|сучар|сучк|мудак|мудил|мудень|пидор|пидар|пидр|педик(?:и|а|ов)?$|гомик|залуп|шлюх|шалав|дроч|гандон|гондон|хер(?:ня|ов)$|муд[оа]зв|уебищ|говнюк|мразь|мрази|ублюд|выродок|дебил|идиот|кретин|тупица|урод|чмо|скотин)");
const MAT_LAT = /\b(?:pizd\w*|(?:hui|huy|xuy|xui)\w*|ebat\w*|ebal\w*|blyad\w*|blyat\w*|suka|pidor\w*|pidar\w*|mudak\w*|fuck\w*|shit\w*|bitch\w*|cunt|nigg\w+|fagg?ot|asshole|dickhead|motherfucker)\b/i;

function profanity(text) {
  if (MAT_LAT.test(text)) return true;
  const words = norm(text).split(/[^а-я]+/).filter(Boolean);
  // «х у й» и «п.и.з.д.а»: три и больше одиночных букв подряд склеиваем в слово
  const merged = [];
  let run = "";
  const flush = () => { if (run.length >= 3) merged.push(run); run = ""; };
  for (const w of words) {
    if (w.length === 1) { run += w; continue; }
    flush();
    merged.push(w);
  }
  flush();
  return merged.some((w) => MAT.test(w));
}

/* ------------------------------------------------------------ спам */

const SPAM = /казино|casino|ставк[аиу]|букмекер|заработ(?:ок|ай|ать)|быстр\w+ займ|микрозайм|криптовалют|биткоин|bitcoin|форекс|forex|виагр|viagra|подписывайс|переходи\b|реклама\b|накрутк|порно|porn|18\+|эскорт|интим|купить\b.*\bдешев|заказать\b.*\bдиплом|курсовую на заказ|гарантия 100/i;

/* ------------------------------------------------------------ бессмыслица */

const VOWELS = /[аеёиоуыэюяaeiouy]/i;
const KEYBOARD = /qwert|werty|asdfg|sdfgh|zxcvb|xcvbn|йцуке|цукен|фывап|ывапр|ячсми|чсмит|ячсм|ыва[пр]/i;

function gibberish(text) {
  const letters = text.match(/[а-яёa-z]/gi) || [];
  const visible = text.replace(/\s/g, "").length;
  if (visible && letters.length / visible < 0.5) return true;                 // цифры, знаки, эмодзи
  const words = text.toLowerCase().match(/[а-яёa-z]{2,}/g) || [];
  if (words.length < 2) return true;                                          // одно слово не обращение
  if (/(.)\1{5,}/.test(text) || /(.{2,6})\1{4,}/.test(text)) return true;    // «аааааааа», «ахахахахах»
  if (KEYBOARD.test(text)) return true;                                       // «фывапр», «qwerty»
  if (visible > 24 && new Set(text.replace(/\s/g, "")).size / visible < 0.12) return true;
  const bad = words.filter((w) => w.length >= 5 && (!VOWELS.test(w) || /[бвгджзйклмнпрстфхцчшщbcdfghjklmnpqrstvwxz]{6,}/i.test(w.replace(/[ьъ]/g, "")))).length;
  return bad / words.length > 0.34;
}

/* ------------------------------------------------------------ проверка */

export function moderateText(raw) {
  const text = clean(raw, { multiline: true });
  if (text.length < LIMITS.textMin) return reject("short", "Опишите подробнее: хотя бы одно предложение, что не так и как должно быть.");
  if (text.length > LIMITS.textMax) return reject("long", `Слишком длинно: до ${LIMITS.textMax} символов.`);
  if (CODE.some((re) => re.test(text))) return reject("code", "В тексте нашлась разметка или код. Опишите словами, без тегов и команд.");
  if (URL_RE.test(text)) return reject("link", "Ссылки не принимаем. Опишите место словами, а отметку поставьте на карте.");
  if (EMAIL_RE.test(text) || PHONE_RE.test(text) || HANDLE_RE.test(text)) return reject("pii", "Контакт укажите в отдельном поле, а не в тексте: обращение публичное.");
  if (profanity(text)) return reject("profanity", "Уберите грубые слова: так обращение разберут быстрее.");
  if (SPAM.test(text)) return reject("spam", "Похоже на рекламу. Мы принимаем только замечания по плану и приложению.");
  if (gibberish(text)) return reject("gibberish", "Не удалось разобрать текст. Опишите, что не так, обычными словами.");
  return { ok: true, text };
}

// Контакт: Telegram, почта или телефон. Необязательный, поэтому лишнее просто отбрасываем
export function moderateContact(raw) {
  const c = clean(raw);
  if (!c) return { ok: true, text: "" };
  if (c.length > LIMITS.contactMax) return reject("contact", "Контакт слишком длинный.");
  if (CODE.some((re) => re.test(c)) || /[<>`\\]/.test(c)) return reject("contact", "В контакте лишние символы.");
  if (profanity(c) || SPAM.test(c)) return reject("contact", "Проверьте контакт: он выглядит странно.");
  const ok = /^@?[a-z][a-z0-9_]{3,31}$/i.test(c)                                                    // Telegram
    || /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(c)                                                       // почта
    || /^\+?\d[\d\s().-]{8,18}\d$/.test(c)                                                             // телефон
    || /^(?:https?:\/\/)?t\.me\/[a-z][a-z0-9_]{3,31}$/i.test(c);
  if (!ok) return reject("contact", "Контакт: @telegram, почта или телефон.");
  return { ok: true, text: c.replace(/^(?:https?:\/\/)?t\.me\//i, "@") };
}

/* ------------------------------------------------------------ вывод в GitHub */

// Текст пользователя идёт в issue только цитатой и обезвреженным: без упоминаний, ссылок на другие
// issue, разметки и HTML. Автор issue - владелец токена, поэтому «@имя» не должно никого пинговать.
export function quote(text) {
  return text
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
    .replace(/[`*_~|\\[\]]/g, (c) => "\\" + c)
    .replace(/@/g, "@⁠")
    .replace(/#(?=\d)/g, "#⁠")
    .split("\n")
    .map((l) => "> " + l)
    .join("\n");
}

// Короткий отпечаток для поиска повторов (не криптография)
export async function fingerprint(text) {
  const norm = text.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9]+/g, " ").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return [...new Uint8Array(buf).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
