import { logger } from "./core/logger.js";
import { resolveAllowedOrigins } from "./config/security.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 3000);
const allowedOrigins = resolveAllowedOrigins();
const app = createApp();

app.listen(PORT, () => {
  logger.info("server.started", {
    port: PORT,
    healthPath: "/health",
    allowedOrigins:
      allowedOrigins.length > 0 ? allowedOrigins : "(none - same-origin only)",
  });
});

process.on("SIGTERM", () => {
  logger.info("server.stopping", { signal: "SIGTERM" });
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("server.stopping", { signal: "SIGINT" });
  process.exit(0);
});
