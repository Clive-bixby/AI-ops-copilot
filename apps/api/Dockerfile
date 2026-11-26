# OpsPilot API image.
#
# The API runs TypeScript directly through tsx (the project has no compiled
# build output), so this is a single-stage image. Dependencies are installed
# from the committed apps/api/package-lock.json with `npm ci` so every build
# resolves the same versions.

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./

# tsx is a devDependency but is required to run the service, so dev deps are
# installed too. --include=dev makes that explicit and keeps npm from pruning
# them when NODE_ENV=production.
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
# Supervisor for the single-container topology (API + worker in one process
# group). Unused by the default CMD below.
COPY run-all.mjs ./

# Uploaded originals are written here by multer and deleted once their text has
# been extracted; docker-compose mounts a volume here. The directory is created
# and handed to the runtime user before the volume mounts, because a named volume
# is initialised from the image path and inherits its ownership.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# The image ships no build output and the process only needs to read its source
# and write /app/uploads. Reusing the uid 1000 user that the base image already
# has (and that apps/web also uses) avoids a useradd layer; it is deliberately
# not a recursive chown, which would invalidate the cache on every source edit.
USER node

EXPOSE 3000

# /ready gates on Postgres, so a container whose database is unreachable is
# reported unhealthy instead of receiving traffic. /health is liveness only.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The Node process is PID 1 on purpose. `npm start` would make npm the signal
# target: SIGTERM killed npm, and the server's shutdown handler -- the one that
# drains in-flight requests and closes the pool -- never ran. The image then
# exited 1 on every deploy instead of stopping cleanly. `npm start` remains the
# local command; the container invokes the entry point directly.
CMD ["node", "--import", "tsx", "src/index.ts"]
