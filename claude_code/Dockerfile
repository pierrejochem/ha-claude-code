# Supervisor 2026.04+ no longer injects BUILD_FROM and build.yaml is unused,
# so the base image is named here. Pin a dated tag once you have it running.
FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

# libgcc, libstdc++ and ripgrep are what the native Claude Code binary needs
# on Alpine/musl. git, jq, curl and openssh are for Claude's own shell.
RUN apk add --no-cache \
      nodejs npm \
      libgcc libstdc++ ripgrep \
      git jq curl openssh-client-default

ENV NODE_ENV=production \
    USE_BUILTIN_RIPGREP=0 \
    DISABLE_AUTOUPDATER=1

WORKDIR /opt/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app/ ./
RUN install -m 0755 /opt/app/bin/ha-api /usr/local/bin/ha-api

COPY run.sh /run.sh
RUN chmod a+x /run.sh

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="aarch64|amd64"

CMD [ "/run.sh" ]
