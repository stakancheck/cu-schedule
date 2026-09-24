// Адрес API личного расписания (Cloudflare Worker из папки worker/).
// Если адрес пустой, вход и «Мои пары» на сайте не показываются.
// На localhost используется локальный сервер: cd worker && npm run dev
window.CU_CONFIG = {
  api: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "http://localhost:8787"
    : "https://cu-schedule-api.cu-schedule-api.workers.dev",
};
