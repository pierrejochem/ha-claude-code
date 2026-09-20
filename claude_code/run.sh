#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e

# /data is the only persistent volume. Claude Code keeps sessions, settings
# and "always allow" rules under $HOME/.claude, so HOME has to live there.
export HOME=/data/home
mkdir -p "$HOME" /config/backups

bashio::log.info "Starting Claude Code panel on port 8099"
cd /opt/app
exec node dist/server.js
