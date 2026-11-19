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

# Uploaded originals are written here by multer and deleted once their text has
# been extracted; docker-compose mounts a volume here.
RUN mkdir -p /app/uploads

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
