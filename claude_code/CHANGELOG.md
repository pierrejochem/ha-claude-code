# Changelog

## Unreleased

- The add-on's server and panel are now written in TypeScript and built
  during the image build. The migration also fixes two defects present in
  0.1.0: permission cards rendering the literal word "null" when a
  permission had no description, reason, blocked path or sub-agent flag, and
  the server crashing on a `null` WebSocket payload (reachable only from the
  Home Assistant ingress proxy).

## 0.1.0

- First version: ingress panel, saved and resumable sessions, streaming
  replies, tool rows with diffs, approvals with "Always allow", plan approval,
  clarifying questions, image attachments, folder picker, light and dark theme.
- `ha-api` helper for the Core REST API and Supervisor Core endpoints.
