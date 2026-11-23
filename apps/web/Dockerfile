# OpsPilot web image.
#
# Vite inlines VITE_* variables at build time, so the API URL has to be a build
# argument rather than a runtime environment variable.
#
# The runtime stage deliberately has no node_modules: `server.mjs` serves the
# built files with plain Node and the cache headers a static host would send.
# It used to run `npx vite preview` -- a development server -- which also meant
# the whole dev dependency tree shipped in the production image.

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .

ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs

# The node image ships an unprivileged `node` user; serving static files does
# not need root.
USER node

EXPOSE 4173

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
