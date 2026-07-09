# syntax=docker/dockerfile:1

# ---- Stage 1: build the React SPA (build platform; output is arch-neutral) ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ---- Stage 2: build the Go binary (cross-compiled from the build platform) ----
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Replace the placeholder dist with the freshly built SPA before embedding.
COPY --from=web /web/dist ./web/dist
ARG VERSION=docker
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} go build \
    -ldflags="-s -w -X github.com/jonnyczi/restic-ui/internal/api.Version=${VERSION}" \
    -o /out/restic-ui ./cmd/restic-ui

# ---- Stage 3: fetch pinned restic + rclone binaries (checksum-verified) ----
FROM --platform=$BUILDPLATFORM alpine:3.20 AS tools
ARG TARGETARCH
ARG RESTIC_VERSION=0.17.3
ARG RCLONE_VERSION=1.68.2
RUN apk add --no-cache curl bzip2 unzip ca-certificates
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    restic_file="restic_${RESTIC_VERSION}_linux_${arch}.bz2"; \
    curl -fsSL -o "/tmp/${restic_file}" \
      "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${restic_file}"; \
    curl -fsSL -o /tmp/restic.sums \
      "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS"; \
    (cd /tmp && grep " ${restic_file}\$" restic.sums | sha256sum -c -); \
    bunzip2 "/tmp/${restic_file}"; \
    install -m 0755 "/tmp/restic_${RESTIC_VERSION}_linux_${arch}" /usr/local/bin/restic; \
    rclone_file="rclone-v${RCLONE_VERSION}-linux-${arch}.zip"; \
    curl -fsSL -o "/tmp/${rclone_file}" \
      "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/${rclone_file}"; \
    curl -fsSL -o /tmp/rclone.sums \
      "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/SHA256SUMS"; \
    (cd /tmp && grep " ${rclone_file}\$" rclone.sums | sha256sum -c -); \
    unzip -j "/tmp/${rclone_file}" "*/rclone" -d /tmp; \
    install -m 0755 /tmp/rclone /usr/local/bin/rclone

# ---- Stage 4: runtime image ----
FROM alpine:3.20
# ca-certificates: TLS to backends; tzdata: schedules honour TZ;
# su-exec + shadow: PUID/PGID privilege drop; openssh-client: restic SFTP backend.
RUN apk add --no-cache ca-certificates tzdata su-exec shadow openssh-client

COPY --from=tools /usr/local/bin/restic /usr/local/bin/restic
COPY --from=tools /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=build /out/restic-ui /usr/local/bin/restic-ui
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DATA_DIR=/config \
    PORT=8080 \
    PUID=1000 \
    PGID=1000

VOLUME ["/config"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["restic-ui"]
