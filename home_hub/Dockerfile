# Home Hub add-on. Built by the Supervisor (or CI buildx) from build.yaml's BUILD_FROM.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22

# ---- build stage: compile TypeScript, keep production deps only ----
FROM ${BUILD_FROM} AS build
RUN apk add --no-cache nodejs npm
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- runtime stage: Node 22 + compiled JS, nothing else ----
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
ENV NODE_ENV=production

# init: false and no s6 services: Node runs as PID 1 and handles SIGTERM itself
# (writes home/state online=false, then exits). The base image's /init is not used.
ENTRYPOINT []
CMD ["node", "/app/dist/main.js"]

ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL \
  io.hass.name="Home Hub" \
  io.hass.description="Outbound-only bridge between Home Assistant and Home Hub" \
  io.hass.type="addon" \
  io.hass.arch="${BUILD_ARCH}" \
  io.hass.version="${BUILD_VERSION}"
