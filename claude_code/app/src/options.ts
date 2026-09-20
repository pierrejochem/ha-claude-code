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

export function authConfigured(): boolean {
  // On macOS the CLI login lives in the Keychain, which we cannot probe; assume it in dev.
  if (DEV) return true;
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
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
