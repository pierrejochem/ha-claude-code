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
- **Deleting a session**: point at a row in the sidebar and use the bin button,
  then confirm. It removes the transcript from the add-on's store for good,
  including the sub-agent transcripts belonging to it; there is no undo, and
  nothing outside the add-on is touched. A session still working cannot be
  deleted - stop it, and delete it once it has finished.
- Paste, drop or attach screenshots (PNG, JPEG, GIF, WebP, up to 5 MB each).
- Sessions are saved. Idle ones are closed after a while to free memory and
  resume when you send the next message, also after an add-on restart.

Put standing instructions for Claude in `/homeassistant/CLAUDE.md` (naming
conventions, which files are generated, rooms and people). Claude Code reads
it at the start of every session.

## Sessions from elsewhere

The sidebar lists what is in the add-on's own session store,
`/data/home/.claude/projects`, which is part of Home Assistant backups. Claude
Code sessions are files on the machine that created them: they are not synced
through your Claude account, and there is no API that lists an account's
sessions. So a session you started on your laptop, in another add-on, or at
claude.ai/code does not turn up here by itself. Two options change that.

**Also show sessions from** (`extra_session_dirs`) borrows sessions from other
Claude config folders on this machine. The folder has to be one both sides can
see, which means `/homeassistant`, `/config` or `/share` - an add-on cannot read
another add-on's `/data`, so `/share` is usually the one to pick. Run the other
CLI with its config folder there:

```
CLAUDE_CONFIG_DIR=/share/claude claude
```

then add `/share/claude` to the option. The add-on copies the transcripts it
finds into its own store and keeps the copies up to date, so a session picks up
messages it gained elsewhere a few seconds later. Nothing in the folder you point
at is written to or deleted, and when you remove the folder from the option the
copies go again. Deleting a borrowed session in the panel removes the add-on's
copy and notes that you did, so it is not copied in again while the original is
still there; the original itself stays put, and deleting it there is the only way
to get rid of it for good. Copies cost disk in `/data` and go into backups with the rest of
the add-on's store, so a folder full of long sessions is worth a look before you
point at it.

A borrowed session that ran in `/homeassistant`, `/config` or `/share` continues
normally. One that ran anywhere else - a laptop path, another container - is
shown in italics and opens read-only, because the folder it worked in is not
here. Once you do continue a borrowed session in the panel, the add-on keeps its
own copy of it from then on: the two histories have diverged, and the original
stays as it was.

**Show sessions on claude.ai** (`remote_control`) turns on Remote Control for
every new session, so each one appears in your session list at
[claude.ai/code](https://claude.ai/code) and in the Claude app, where you can
follow it or send it a message from your phone. Claude keeps running in this
add-on and works on your configuration either way; the remote view is a window
onto this process, not a copy of it.

It needs the **Claude subscription token** on a Pro, Max, Team or Enterprise plan
- Claude Code refuses API keys for this - and on Team or Enterprise an owner has
to enable Remote Control in the [Claude Code admin
settings](https://claude.ai/admin-settings/claude-code) first. The add-on asks
for it two ways at once, because the Agent SDK has no switch of its own: the
`--remote-control` flag on each session, and `remoteControlAtStartup` in
`/data/home/.claude/settings.json`, which it adds when the option is on and
removes when it is off. Nothing else in that file is touched. While a session is
connected its transcript is stored on Anthropic's servers so the devices stay in
sync; file access and commands stay here. The add-on log says at startup whether
Remote Control is on, and why not when it is not.

The reverse trip is not possible from the panel: a *cloud* session, one that ran
on Anthropic's infrastructure from claude.ai/code or the Claude app, can only be
pulled into a terminal with `claude --teleport`, which needs a git checkout of
the repository that session worked on.

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
| `extra_session_dirs` | empty | Other Claude config folders to list sessions from |
| `remote_control` | `false` | Put new sessions in your claude.ai/code session list |

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
- **A folder in `extra_session_dirs` is ignored.** The log says which one and
  why: it is outside `/homeassistant`, `/config` and `/share`, it holds no
  `projects` subfolder, or it is the add-on's own store.
- **A borrowed session will not continue.** If its folder is not reachable from
  this add-on it stays read-only; the panel says so when you open it.
- **Sessions do not appear on claude.ai.** Remote Control needs the
  subscription token, not an API key, and on Team or Enterprise it has to be
  enabled for the organisation; the log line at startup names the reason. If the
  log says it is on and the sessions still do not show up, Claude Code may be
  declining to bridge a session it did not start interactively - open a session
  in the panel and check the list at claude.ai/code before and after.
- The add-on log (Settings, Apps, Claude Code, Log) shows Claude Code's own
  stderr, prefixed with the session id.
