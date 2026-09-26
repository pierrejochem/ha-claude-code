// Turns Remote Control on for the sessions this add-on starts, so each one
// appears in the session list at claude.ai/code and in the Claude app and can be
// steered from a phone. Claude keeps running here either way.
//
// Two triggers, because the Agent SDK has no option of its own for Remote
// Control and only one of the CLI's is certain to apply to a non-interactive
// session:
//
//   - `--remote-control`, passed through the SDK's extraArgs (see
//     sdkOptions in options.ts). The CLI documents it as starting an
//     interactive session with Remote Control on.
//   - `remoteControlAtStartup` in the user settings file, which the CLI
//     describes as starting the Remote Control bridge automatically each
//     session. It has to be the user-level file: the CLI ignores the key in
//     project and local settings on purpose.
//
// This module owns the second one. It edits that single key and leaves the rest
// of the file, including "always allow" rules, exactly as it found it.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './wire.js';

export const SETTINGS_KEY = 'remoteControlAtStartup';

export type SettingOutcome =
  | { state: 'set' | 'cleared' | 'unchanged' }
  | { state: 'failed'; reason: string };

/**
 * Brings `remoteControlAtStartup` in `<configDir>/settings.json` in line with
 * `enabled`. A settings file that is not readable JSON is left alone and
 * reported: rewriting it would throw away whatever it holds.
 */
export async function applyRemoteControlSetting(enabled: boolean, configDir: string): Promise<SettingOutcome> {
  const file = path.join(configDir, 'settings.json');
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);

  let settings: Record<string, unknown> = {};
  if (raw !== null && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      return { state: 'failed', reason: `${file} is not readable JSON (${errorMessage(err)}), so it was left alone` };
    }
  }

  const current = settings[SETTINGS_KEY];
  if (enabled && current === true) return { state: 'unchanged' };
  // Only a key this add-on would have written is removed; a `false` someone set
  // by hand is left in place, since it says the same thing.
  if (!enabled && current !== true) return { state: 'unchanged' };

  if (enabled) settings[SETTINGS_KEY] = true;
  else delete settings[SETTINGS_KEY];

  try {
    await fsp.mkdir(configDir, { recursive: true });
    const tmp = `${file}.ha-tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    await fsp.rename(tmp, file);
  } catch (err) {
    return { state: 'failed', reason: `could not write ${file}: ${errorMessage(err)}` };
  }
  return { state: enabled ? 'set' : 'cleared' };
}
