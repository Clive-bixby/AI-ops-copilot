import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

/**
 * Static server for the built SPA.
 *
 * `vite preview` used to serve the production image. It is a development
 * server: no cache headers, no compression, and it drags Vite and the whole dev
 * dependency tree into the runtime image. This serves `dist` with the headers a
 * static host would send, and needs nothing from node_modules.
 *
 *   /assets/*   hashed build output  -> immutable, one year
 *   index.html  the app shell        -> no-cache, so a deploy is picked up
 *   other paths SPA client routes    -> index.html (the router owns them)
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.PORT || 4173);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg\+xml)/;

/** Only the hashed build output is safe to cache forever. */
const IMMUTABLE_PREFIX = "/assets/";

async function fileAt(candidate) {
  try {
    const stats = await stat(candidate);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

/**
 * Map a request path to a file inside `dist`, or null when it escapes the root.
 * The check compares resolved paths, so `..` segments and encoded traversal
 * cannot reach outside the build output.
 */
function resolveWithinRoot(pathname) {
  const candidate = path.resolve(root, `.${pathname}`);

  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  return candidate;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    send(response, 400, "Bad request");
    return;
  }

  let filePath = resolveWithinRoot(pathname);

  if (filePath === null) {
    send(response, 403, "Forbidden");
    return;
  }

  let stats = await fileAt(filePath);

  // A directory or an unknown extension-less path is a client route.
  if (!stats && !path.extname(pathname)) {
    filePath = path.join(root, "index.html");
    stats = await fileAt(filePath);
  }

  if (!stats) {
    send(response, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const isShell = path.basename(filePath) === "index.html";

  const headers = {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": pathname.startsWith(IMMUTABLE_PREFIX)
      ? "public, max-age=31536000, immutable"
      : isShell
        ? "no-cache"
        : "public, max-age=3600",
  };

  const acceptsGzip = /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
  const compress = acceptsGzip && COMPRESSIBLE.test(contentType) && stats.size > 1024;

  if (compress) {
    headers["Content-Encoding"] = "gzip";
    headers.Vary = "Accept-Encoding";
  } else {
    headers["Content-Length"] = String(stats.size);
    if (COMPRESSIBLE.test(contentType)) headers.Vary = "Accept-Encoding";
  }

  response.writeHead(200, headers);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);

  stream.on("error", () => {
    // The headers are already sent; the only honest remaining action is to end
    // the response so the client sees a truncated body rather than a hang.
    response.destroy();
  });

  if (compress) {
    stream.pipe(createGzip()).pipe(response);
  } else {
    stream.pipe(response);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "web.started", port, root }));
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: "info", message: "web.stopping", signal }));
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
