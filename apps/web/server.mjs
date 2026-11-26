import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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

/**
 * The API origin the bundle was built against.
 *
 * The CSP has to name it explicitly, so it is read from the same variable the
 * build inlined (`VITE_API_URL`) and required to be an absolute origin: a
 * malformed value would block every API call in the browser instead, and a
 * silent fallback would hide the mismatch.
 */
function apiOriginFromEnv() {
  const raw = (process.env.VITE_API_URL ?? "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
  } catch {
    // Reported below with the value, so the operator can see what was set.
  }

  throw new Error(
    `VITE_API_URL must be an absolute http(s) URL for the CSP connect-src (got "${raw}").`
  );
}

/**
 * SHA-256 of every inline script in the built shell.
 *
 * `index.html` boots the saved theme before React mounts. Its hash is computed
 * from the built file instead of being hard-coded, so changing the snippet
 * cannot leave the CSP pointing at the previous one. External scripts (the
 * module bundle) stay covered by `'self'`.
 */
async function inlineScriptHashes() {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const hashes = [];

  for (const match of html.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    hashes.push(createHash("sha256").update(match[1]).digest("base64"));
  }

  return hashes;
}

const API_ORIGIN = apiOriginFromEnv();
const INLINE_SCRIPT_HASHES = await inlineScriptHashes();

/**
 * Scripts are same-origin plus the shell's one hashed inline bootstrap, with no
 * `'unsafe-inline'`. Inline styles stay allowed because the UI sets React
 * `style` attributes, and the Google Fonts hosts are named because it loads them.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  [
    "script-src 'self'",
    ...INLINE_SCRIPT_HASHES.map((hash) => `'sha256-${hash}'`),
  ].join(" "),
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `connect-src 'self' ${API_ORIGIN}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

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
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
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
