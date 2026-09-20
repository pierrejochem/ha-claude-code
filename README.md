# Claude Code for Home Assistant

A Home Assistant app (add-on) that runs Claude Code on your Home Assistant
machine and gives it a Claude Desktop-style panel in the sidebar.

```
claude_code/
  config.yaml          app manifest: ingress panel, folder mappings, options
  Dockerfile           Alpine base + Node + the packages Claude Code needs on musl
  run.sh               sets HOME=/data/home so sessions and rules persist
  app/
    src/server.ts        HTTP + WebSocket server, ingress-only
    src/live-session.ts  one Agent SDK query() per running session
    src/prompt.ts        Home Assistant context appended to the system prompt
    bin/ha-api            curl wrapper for the Core and Supervisor APIs
    public/               the panel (built from src/web with esbuild)
```

## Install

1. Settings > Apps > App store > menu > **Repositories**, and add
   `https://github.com/pierrejochem/ha-claude-code`.
2. "Claude Code" appears in the store. **Install** — this pulls a prebuilt image,
   so it takes about as long as the download.
3. Configuration tab: paste a token from `claude setup-token` or an API key.
4. Start, then open **Claude Code** in the sidebar.

## Run your own changes on Home Assistant

1. Copy the `claude_code` folder to `/addons/claude_code` on the Home Assistant
   machine (Samba share `addons`, or the SSH app).
2. Delete the `image:` line from `/addons/claude_code/config.yaml`. Without that,
   the Supervisor pulls the published image instead of building your copy.
3. Settings > Apps > App store > menu > **Check for updates**. "Claude Code"
   appears under **Local apps**.
4. Install. The image is built on the device; on a Raspberry Pi 5 expect a few
   minutes, most of it downloading the Claude Code binary (about 200 MB).

## Work on the panel without Home Assistant

```
cd claude_code/app
npm install
npm run dev        # builds, then http://localhost:8099, working folder = current directory
```

Dev mode skips the ingress IP check and uses whatever Claude Code login the
machine already has.

## How it fits together

The browser holds one WebSocket to the add-on. Every running session is an
Agent SDK `query()` in streaming-input mode: user messages are pushed into an
async queue, SDK messages are logged with a sequence number and broadcast, and
token deltas are broadcast without being logged. A reconnecting browser sends
the last sequence number it saw and gets the rest, which matters on phones
where ingress sockets drop often. Permission prompts are the SDK's
`canUseTool` callback held open until the panel answers.
