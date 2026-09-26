import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Сайт живёт на GitHub Pages в подпапке, поэтому пути относительные.
// Тяжёлые данные (расписание, векторы этажей) лежат в public/data и грузятся
// обычными скриптами до приложения: ночное обновление расписания не трогает бандл.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 8765 },
  preview: { port: 8765 },
});
