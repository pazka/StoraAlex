# syntax=docker/dockerfile:1

# ---- build stage: compile TS + build the PWA ----
FROM node:24-slim AS build
WORKDIR /app
# .npmrc (ignore-scripts=true) is copied so the build install also runs with
# lifecycle scripts disabled. Native deps (sharp, @node-rs/argon2) ship prebuilt
# binaries as optional dependencies, so they install fine without scripts.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.base.json tsconfig.server.json tsconfig.client.json vite.config.ts index.html ./
COPY scripts ./scripts
COPY public ./public
COPY src ./src
RUN npm run build

# ---- runtime stage: production deps only, non-root ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8080
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Data volume (SQLite db + media) owned by the unprivileged node user.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
