# Changelog

## 0.3.0

- The sidebar can show sessions from other Claude config folders on this
  machine, through the new **Also show sessions from** option: point it at a
  folder both this add-on and another `claude` can reach, such as
  `/share/claude`. Claude Code keeps sessions as files per machine and has no
  account-level list, so this is what makes a session started outside the panel
  visible in it.
- Sessions whose working folder is outside `/homeassistant`, `/config` and
  `/share` are no longer hidden from the sidebar. They are shown in italics and
  open read-only, and the server now refuses to resume one instead of running it
  outside the folders the add-on is supposed to stay in.
- New **Show sessions on claude.ai** option turns on Remote Control, so each new
  session appears in the session list at claude.ai/code and in the Claude app
  and can be steered from a phone. Claude still runs in the add-on. It needs the
  subscription token, and the log says at startup whether it is on and why not
  when it is not. While the option is on the add-on keeps
  `remoteControlAtStartup` in its own `settings.json`, and removes it again when
  the option goes off; nothing else in that file is touched.

## 0.2.0

- The add-on's server and panel are now written in TypeScript and built
  during the image build. The migration also fixes two defects present in
  0.1.0: permission cards rendering the literal word "null" when a
  permission had no description, reason, blocked path or sub-agent flag, and
  the server crashing on a `null` WebSocket payload (reachable only from the
  Home Assistant ingress proxy).
- The working-folder popover no longer closes when you click into a subfolder.
- Reopening a session from the sidebar now transfers the same slimmed messages
  the session sent while it was running, instead of the raw transcript. Image
  payloads are dropped, which the panel never rendered anyway, and tool results
  longer than 30 000 characters are clipped exactly as they were live — so a
  replayed transcript now matches what the session showed, rather than more.
- Installing from the store no longer compiles the add-on on your device; it
  downloads a ready-built image instead. The download is a similar size either
  way — what goes away is the build step.

## 0.1.0

- First version: ingress panel, saved and resumable sessions, streaming
  replies, tool rows with diffs, approvals with "Always allow", plan approval,
  clarifying questions, image attachments, folder picker, light and dark theme.
- `ha-api` helper for the Core REST API and Supervisor Core endpoints.
