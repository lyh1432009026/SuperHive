// 文档站本地静态服务：直接读 apps/docs/dist，只监听 127.0.0.1。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

export async function serveDocs(dist) {
  if (!fs.existsSync(path.join(dist, "index.html")))
    throw new Error(`没有文档站构建产物：${dist}（先 pnpm --filter @superhive/docs build）`);
  const server = http.createServer((request, response) => {
    let file = path.join(dist, decodeURIComponent(new URL(request.url, "http://x").pathname));
    if (!file.startsWith(dist)) {
      response.statusCode = 403;
      return response.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, "index.html");
    if (!fs.existsSync(file)) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
