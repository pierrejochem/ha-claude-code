# Claude Code for Home Assistant

Claude Code runs inside this add-on and works directly in your Home Assistant
configuration folder. You talk to it from a panel in the sidebar that follows
the Claude Desktop app: sessions on the left, the conversation in the middle,
approvals above the message box.

## Sign Claude in

The add-on needs one credential. Use whichever you have.

**Claude subscription (Pro, Max, Team, Enterprise).** On any computer with
Claude Code installed, run:

```
claude setup-token
```

Approve it in the browser, copy the token it prints, and paste it into
**Claude subscription token** on the add-on's Configuration tab. The token is
valid for a year and can only make model requests.

**Anthropic API key.** Paste a key from the Claude Console into **Anthropic
API key**. Usage is billed per token. If both fields are filled, Claude Code
uses the API key.

Save, restart the add-on, and open **Claude Code** in the sidebar.

## Using the panel

- **New session** starts Claude in the default working folder
  (`/homeassistant`, your configuration). The folder button next to the message
  box lets you pick a subfolder before the first message. A session stays in
  the folder it was started in.
- **Permission mode** decides how much Claude asks:
  - *Ask permissions*: asks before every edit and command.
  - *Accept edits*: file edits go through, commands still ask.
  - *Plan mode*: Claude only reads, then shows a plan for you to approve.
  - *Auto mode*: a classifier decides. Not available on every plan; if it is
    not, the panel shows the error and you can switch back.
- **Approvals** appear above the message box. *Always allow* stores a rule so
  the same kind of action stops asking. *Deny* can carry a note telling Claude
  what to do instead.
- **Stop** interrupts the current turn. You can also type while Claude works;
  the message is queued into the running task.
- Paste, drop or attach screenshots (PNG, JPEG, GIF, WebP, up to 5 MB each).
- Sessions are saved. Idle ones are closed after a while to free memory and
  resume when you send the next message, also after an add-on restart.

Put standing instructions for Claude in `/homeassistant/CLAUDE.md` (naming
conventions, which files are generated, rooms and people). Claude Code reads
it at the start of every session.

## What Claude can reach

| Inside the add-on | What it is |
| --- | --- |
| `/homeassistant` | Your Home Assistant configuration, read and write |
| `/config` | This add-on's own folder (`/addon_configs/..._claude_code`), backups go to `/config/backups` |
| `/share` | The shared folder |

With **Let Claude talk to Home Assistant** on, Claude's shell gets the
Supervisor token and a small helper:

```
ha-api GET  /core/api/states/light.kitchen
ha-api POST /core/api/services/automation/reload
ha-api POST /core/check        # validate the configuration
ha-api POST /core/restart
```

The add-on asks for the `homeassistant` Supervisor role, which covers the Core
endpoints above and nothing broader (no add-on management, no host control).

## Safety notes

Read these once; this add-on edits a running home.

- There is no bypass-permissions mode in the panel on purpose. *Accept edits*
  plus *Always allow* rules cover the convenient cases and keep commands
  visible.
- **Keep secrets out of reach** blocks Claude's Read and Edit tools from
  `secrets.yaml`, `.storage/auth*` and `.cloud/`. It is best effort: a shell
  command that you approve (`cat secrets.yaml`) still reads the file. Look at
  commands before allowing them.
- Everything Claude reads is sent to Anthropic to produce the answer. That
  includes entity names, states and YAML it opens.
- The panel is admin-only and only reachable through Home Assistant ingress.
  The server refuses every connection that does not come from the ingress
  proxy.
- Take a Home Assistant backup before letting Claude do a large refactor. The
  add-on's own folder, including saved sessions and rules, is part of backups.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `claude_oauth_token` | empty | Token from `claude setup-token` |
| `anthropic_api_key` | empty | Console API key, used instead of the token when set |
| `default_model` | empty | Model alias or name for new sessions, for example `sonnet` |
| `default_permission_mode` | `default` | `default`, `acceptEdits`, `plan` or `auto` |
| `working_directory` | `/homeassistant` | Folder new sessions start in |
| `expose_ha_api` | `true` | Give Claude's shell the Supervisor token and `ha-api` |
| `protect_secrets` | `true` | Deny rules for secrets and auth files |
| `max_live_sessions` | `3` | Claude Code processes kept running at once |
| `idle_timeout_minutes` | `20` | Close an idle process after this long |

Each running session is its own Claude Code process, roughly 300 to 500 MB.
On a 4 GB Raspberry Pi 5 keep `max_live_sessions` at 2 or 3.

## Troubleshooting

- **The panel says Claude is not signed in.** No token or key is saved, or the
  add-on was not restarted after saving.
- **"Failed to authenticate"** as Claude's reply: the token or key is wrong or
  expired. Generate a new one.
- **"Native CLI binary ... not found"** in a session: npm skipped the platform
  package during the image build. Rebuild the add-on and read the build log.
- **Search or file listing fails:** the image must contain `ripgrep` and run
  with `USE_BUILTIN_RIPGREP=0`; both are set in the Dockerfile.
- The add-on log (Settings, Apps, Claude Code, Log) shows Claude Code's own
  stderr, prefixed with the session id.
