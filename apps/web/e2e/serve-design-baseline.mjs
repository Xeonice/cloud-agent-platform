/**
 * Static file server for the design-baseline prototype
 * (console-design-pixel-merge task 8.1).
 *
 * Serves `openspec/changes/console-design-pixel-merge/design-baseline/` — the
 * design revision's HTML/CSS/JS prototype — so the visual suite can render the
 * LIVING baselines in the same browser/viewport as the app (design.md D7).
 * Started by `playwright.config.ts` (webServer[0]); not meant to be deployed.
 *
 * Usage: node e2e/serve-design-baseline.mjs [port]
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo-relative root of the design prototype — the baseline SOURCE OF TRUTH. */
const ROOT = path.resolve(
  here,
  "../../../openspec/changes/console-design-pixel-merge/design-baseline",
);

const PORT = Number(process.argv[2] ?? 4317);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.normalize(path.join(ROOT, pathname));
      // Path-traversal guard: never serve outside the baseline root.
      if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const body = await fs.readFile(file);
      res.writeHead(200, {
        "content-type":
          CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        // Always re-read from disk: the prototype IS the living baseline.
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(PORT, () => {
    console.log(
      `[design-baseline] http://localhost:${PORT}/ serving ${ROOT}`,
    );
  });
