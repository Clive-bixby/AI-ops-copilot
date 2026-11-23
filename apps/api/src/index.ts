import { envFileLoaded } from "./config/env.js";

import { logger } from "./core/logger.js";
import { pool } from "./core/db.js";
import { closeQueues } from "./core/queue.js";
import { resolveAllowedOrigins } from "./config/security.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 3000);
const allowedOrigins = resolveAllowedOrigins();
const app = createApp();

/**
 * How long a deploy waits for in-flight requests before the process is killed.
 * A request that is still running after this is reported rather than silently
 * cut: the exit code is non-zero so the platform records a failed stop.
 */
const SHUTDOWN_GRACE_MS = 10_000;

const server = app.listen(PORT, () => {
  logger.info("server.started", {
    port: PORT,
    healthPath: "/health",
    readyPath: "/ready",
    envFileLoaded,
    allowedOrigins:
      allowedOrigins.length > 0 ? allowedOrigins : "(none - same-origin only)",
  });
});

let shuttingDown = false;

/**
 * Stop accepting connections, let the requests already running finish, then
 * close the datastores.
 *
 * This used to call `process.exit(0)` straight from the signal handler, so every
 * deploy severed in-flight requests (a client sees a connection reset where a
 * response was in progress) and abandoned the queue socket.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info("server.stopping", { signal });

  const forceExit = setTimeout(() => {
    logger.error("server.forced_exit", { signal, graceMs: SHUTDOWN_GRACE_MS });
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);

  // Unref so the timer alone cannot keep the process alive.
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Keep-alive sockets held open by an idle browser would otherwise delay
      // close() until their timeout.
      server.closeIdleConnections();
    });

    await closeQueues();
    await pool.end();

    clearTimeout(forceExit);
    logger.info("server.stopped", { signal });
    process.exit(0);
  } catch (error) {
    logger.error("server.shutdown_failed", { signal, error });
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
