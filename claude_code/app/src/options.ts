// Add-on configuration: /data/options.json, the filesystem roots Claude is
// allowed to reach, the path-containment check that enforces that, the
// credential check, and the Agent SDK options shared by every session.
// Ported from server.js:18-20 and :25-106.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemAppend } from './prompt.js';
import type { PermissionMode, Root } from './shared/protocol.js';

// DEV=1 runs the panel outside Home Assistant (npm run dev): no ingress IP
// check, and the current directory becomes a working folder.
export const DEV = process.env.DEV === '1';
export const PORT = Number(process.env.PORT || 8099);
export const INGRESS_PROXY = '172.30.32.2';

// ------------------------------------------------------------------ options

export interface AddonOptions {
  claude_oauth_token: string;
  anthropic_api_key: string;
  default_model: string;
  default_permission_mode: PermissionMode;
  working_directory: string;
  expose_ha_api: boolean;
  protect_secrets: boolean;
  max_live_sessions: number;
  idle_timeout_minutes: number;
  extra_session_dirs: string[];
  remote_control: boolean;
}

export function loadOptions(): AddonOptions {
  const defaults: AddonOptions = {
    claude_oauth_token: '',
    anthropic_api_key: '',
    default_model: '',
    default_permission_mode: 'default',
    working_directory: '/homeassistant',
    expose_ha_api: true,
    protect_secrets: true,
    max_live_sessions: 3,
    idle_timeout_minutes: 20,
    extra_session_dirs: [],
    remote_control: false,
  };
  try {
    const file = process.env.OPTIONS_PATH || '/data/options.json';
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AddonOptions>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

const ROOT_LABELS: Record<string, string> = {
  '/homeassistant': 'Home Assistant config',
  '/config': 'Add-on files',
  '/share': 'Share',
};

export function discoverRoots(dev: boolean): Root[] {
  const found = Object.keys(ROOT_LABELS)
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p, label: ROOT_LABELS[p] }));
  if (dev) found.push({ path: process.cwd(), label: 'Dev folder' });
  return found;
}

export function makeIsInsideRoots(roots: Root[]): (candidate: string | null | undefined) => boolean {
  return (candidate) => {
    if (!candidate) return false;
    const resolved = path.resolve(candidate);
    return roots.some((r) => resolved === r.path || resolved.startsWith(r.path + path.sep));
  };
}

// ------------------------------------------------------------- session dirs

// The one Claude config folder the Agent SDK reads: $HOME/.claude, which run.sh
// points at /data/home so sessions survive a restart. CLAUDE_CONFIG_DIR moves
// it, so honour that too.
export const configDir = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), '.claude');

export interface ExtraDirChecks {
  isInside: (candidate: string) => boolean;
  hasProjects: (dir: string) => boolean;
  own: string;
}

export interface ExtraSessionDirs {
  dirs: string[];
  rejected: Array<{ path: string; reason: string }>;
}

/**
 * The extra Claude config folders to borrow sessions from. A folder counts
 * only when it sits inside the roots this add-on can reach, is not the add-on's
 * own config folder, and holds a `projects` subfolder — anything else is a
 * typo, and silently mirroring nothing would look like the option is ignored.
 */
export function resolveExtraSessionDirs(raw: unknown, checks: ExtraDirChecks): ExtraSessionDirs {
  const dirs: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  for (const entry of Array.isArray(raw) ? (raw as unknown[]) : []) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const dir = path.resolve(entry.trim());
    if (dirs.includes(dir)) continue;
    if (dir === checks.own) {
      rejected.push({ path: dir, reason: "is the add-on's own session folder" });
    } else if (!checks.isInside(dir)) {
      rejected.push({ path: dir, reason: 'is outside the folders this add-on can reach' });
    } else if (!checks.hasProjects(dir)) {
      rejected.push({ path: dir, reason: 'holds no projects folder, so it is not a Claude config folder' });
    } else {
      dirs.push(dir);
    }
  }
  return { dirs, rejected };
}

// ------------------------------------------------------------------- auth

export function authConfigured(): boolean {
  // On macOS the CLI login lives in the Keychain, which we cannot probe; assume it in dev.
  if (DEV) return true;
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return fs.existsSync(path.join(configDir, '.credentials.json'));
}

/**
 * Why Remote Control cannot start with the credentials configured, or null when
 * nothing obvious stands in its way. Remote Control needs a claude.ai login:
 * the CLI refuses API keys, and a gateway in ANTHROPIC_BASE_URL turns it off.
 * Passing --remote-control anyway would fail every session, so the caller drops
 * the flag and logs the reason instead.
 */
export function remoteControlBlocker(
  o: AddonOptions,
  env: Record<string, string | undefined> = process.env
): string | null {
  if (!o.remote_control) return null;
  if (o.anthropic_api_key || env.ANTHROPIC_API_KEY) {
    return 'an Anthropic API key is configured, and Claude Code takes it in preference to the subscription token; Remote Control needs the token';
  }
  if (!o.claude_oauth_token && !env.CLAUDE_CODE_OAUTH_TOKEN) return 'no Claude subscription token is configured';
  const base = env.ANTHROPIC_BASE_URL;
  if (base && !/^https:\/\/api\.anthropic\.com\/?$/.test(base.trim())) {
    return `ANTHROPIC_BASE_URL points at ${base}, and Remote Control only works against api.anthropic.com`;
  }
  return null;
}

// Options shared by every session. cwd, model, mode and resume are per session.
export function sdkOptions({
  options,
  roots,
  version,
}: {
  options: AddonOptions;
  roots: Root[];
  version: string;
}): Record<string, unknown> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `ha-claude-code/${version}` };
  if (!options.expose_ha_api) delete env.SUPERVISOR_TOKEN;

  // Remote Control registers the session with the Anthropic API so it appears
  // in the session list at claude.ai/code and in the Claude app, where it can
  // be steered from a phone. Claude keeps running here either way: the remote
  // surface is a window onto this process, not a copy of it. The SDK has no
  // option of its own for it, so pass the CLI's documented flag through
  // extraArgs, and name the sessions after this machine rather than the
  // container's hostname.
  const remoteControl = options.remote_control && !remoteControlBlocker(options, env);
  if (remoteControl) env.CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX ||= 'homeassistant';

  const disallowedTools: string[] = [];
  if (options.protect_secrets) {
    // "//" anchors a rule at the filesystem root.
    for (const tool of ['Read', 'Edit']) {
      disallowedTools.push(
        `${tool}(//homeassistant/secrets.yaml)`,
        `${tool}(//homeassistant/.storage/auth)`,
        `${tool}(//homeassistant/.storage/auth_provider.*)`,
        `${tool}(//homeassistant/.storage/onboarding)`,
        `${tool}(//homeassistant/.cloud/**)`
      );
    }
  }

  return {
    env,
    ...(remoteControl ? { extraArgs: { 'remote-control': null } } : {}),
    disallowedTools,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildSystemAppend({ exposeHaApi: options.expose_ha_api, roots }),
    },
    // Loads CLAUDE.md, .claude/settings*.json and skills from the working folder and from ~/.claude.
    settingSources: ['user', 'project', 'local'],
  };
}

// ------------------------------------------------------------- singletons

export const options = loadOptions();
if (options.anthropic_api_key) process.env.ANTHROPIC_API_KEY = options.anthropic_api_key;
if (options.claude_oauth_token) process.env.CLAUDE_CODE_OAUTH_TOKEN = options.claude_oauth_token;

export const roots = discoverRoots(DEV);
export const isInsideRoots = makeIsInsideRoots(roots);

export const defaultCwd =
  isInsideRoots(options.working_directory) && fs.existsSync(options.working_directory)
    ? options.working_directory
    : roots[0]?.path || process.cwd();

export const extraSessionDirs = resolveExtraSessionDirs(options.extra_session_dirs, {
  isInside: isInsideRoots,
  hasProjects: (dir) => fs.existsSync(path.join(dir, 'projects')),
  own: configDir,
});
