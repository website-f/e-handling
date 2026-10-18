# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

FROM nginx:1.29-alpine
COPY gateway/nginx.conf /etc/nginx/nginx.conf
COPY gateway/proxy-common.conf gateway/security-headers.conf /etc/nginx/
COPY --from=web /web/dist /usr/share/nginx/html
# Mount point for the photos volume. Owned by the worker's uid so whichever container creates
# the volume first, the worker can still write to it.
RUN install -d -o 10001 -g 10001 /usr/share/nginx/photos
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
