// Локальный запуск API без wrangler: node dev.mjs (порт 8787).
// Ключ сессий хранится в .dev.vars (создаётся сам), чтобы вход переживал перезапуск.

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import worker from "./src/index.js";

const varsFile = new URL("./.dev.vars", import.meta.url);
const env = { ALLOWED_ORIGINS: "http://localhost:8765" };
if (fs.existsSync(varsFile)) {
  for (const line of fs.readFileSync(varsFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
}
if (!env.SESSION_KEY) {
  env.SESSION_KEY = crypto.randomBytes(32).toString("base64");
  fs.appendFileSync(varsFile, `SESSION_KEY="${env.SESSION_KEY}"\n`);
}

const port = +process.env.PORT || 8787;
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  const r = await worker.fetch(request, env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  console.log(req.method, req.url.replace(/\?.*/, ""), r.status);
}).listen(port, () => console.log(`API: http://localhost:${port}`));
