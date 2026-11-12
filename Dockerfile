# syntax=docker/dockerfile:1

# ---- build stage: compile TS + build the PWA ----
# Base pinned by exact Node version + digest (pazka/hosh-management#5, CVE-2026-111497);
# Dependabot (docker ecosystem) bumps tag and digest together. CI and release.yml run
# scripts/check-node-version.sh on the built image before anything is pushed.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
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
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8080
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# After installing prod deps, drop npm from the runtime image entirely: the app
# runs with plain `node` (CMD + HEALTHCHECK), and npm's bundled node_modules
# ship a vulnerable tar (CVE-2026-59873, tar 7.5.16 < 7.5.19) flagged by Trivy.
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist

# Data volume (SQLite db + media). Two ways to run this image:
#  - legacy box compose: image user `node` (uid 1000), owner of /data;
#  - hosh-deploy (docker-compose.example.yml): `user: "10001:10001"`, read-only rootfs.
# A fresh named volume copies this directory's owner and mode, so group 10001
# gets write access too (0770: nobody else). PORT and DATA_DIR come from env.
RUN mkdir -p /data && chown node:10001 /data && chmod 0770 /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
