import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Версия сборки уходит в обращения с плана: по ней видно, на какой версии нашли ошибку.
// В GitHub Actions это хеш коммита, локально "dev".
const sha: string | undefined = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GITHUB_SHA;
const build = sha ? `${sha.slice(0, 7)} ${new Date().toISOString().slice(0, 10)}` : "dev";

// Сайт живёт на GitHub Pages в подпапке, поэтому пути относительные.
// Тяжёлые данные (расписание, векторы этажей) лежат в public/data и грузятся
// обычными скриптами до приложения: ночное обновление расписания не трогает бандл.
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { __BUILD__: JSON.stringify(build) },
  server: { port: 8765 },
  preview: { port: 8765 },
});
