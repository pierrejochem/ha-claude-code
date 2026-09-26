// Makes sessions from other Claude config folders on this machine visible to
// the Agent SDK.
//
// The SDK reads sessions from exactly one config folder: $HOME/.claude, or
// CLAUDE_CONFIG_DIR when set. listSessions, getSessionInfo and
// getSessionMessages take a project `dir`, which filters by working folder, but
// no config folder, and the variable that picks one is read by the CLI the SDK
// spawns - so a second config folder cannot be passed per call. Sessions
// created by a `claude` CLI elsewhere on this machine therefore never show up
// in the panel, however well the folder they live in is shared with this
// container.
//
// So this module copies each foreign transcript into the add-on's own projects
// folder, keeping the source's project folder name. Listing, replay and resume
// then all work through the SDK unchanged, and this add-on stays out of the
// .jsonl format itself, which Claude Code documents as internal and changes
// between releases. Symlinks would have saved the copy, but the SDK's session
// listing walks directory entries with isFile(), so a link is skipped.
//
// Every copy is recorded in an index beside them, and only what the index
// accounts for is ever refreshed or removed. Two rules follow from it:
//
//   - A transcript the add-on itself wrote is never touched.
//   - Once a borrowed session is continued here, so the copy has moved on from
//     the source, the copy is left alone and becomes the add-on's own.

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { errorMessage } from './wire.js';

/** What a copy was made from, so a later run can tell whether it is current. */
interface CopyRecord {
  source: string;
  /** mtime and size of the source when it was copied. */
  sourceMtimeMs: number;
  sourceSize: number;
  /** mtime and size of the copy just after writing it. */
  copyMtimeMs: number;
  copySize: number;
}

/** Keyed by the copy's path relative to `<own>/projects`. */
type CopyIndex = Record<string, CopyRecord>;

export interface MirrorReport {
  /** Extra config folders that held a projects folder we could read. */
  sources: number;
  /** Transcripts copied in this run, new ones and refreshed ones alike. */
  copied: number;
  /** Copies removed because their source is gone or no longer configured. */
  pruned: number;
  /** Copies kept although their source moved on, because they were continued here. */
  adopted: number;
  errors: string[];
}

const INDEX_FILE = '.ha-borrowed-sessions.json';

async function entries(dir: string): Promise<Dirent[]> {
  return await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function statOf(target: string): Promise<{ mtimeMs: number; size: number } | null> {
  return await fsp.stat(target).then(
    (s) => ({ mtimeMs: s.mtimeMs, size: s.size }),
    () => null
  );
}

function insideAny(dirs: string[], candidate: string): boolean {
  return dirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep));
}

async function readIndex(file: string): Promise<CopyIndex> {
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or half-written index degrades to "everything here is the
    // add-on's own", which leaves copies in place rather than deleting them.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CopyIndex) : {};
  } catch {
    return {};
  }
}

async function writeIndex(file: string, index: CopyIndex): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(index, null, 1));
  await fsp.rename(tmp, file);
}

/** True when the copy on disk is still the one the record describes. */
function untouched(record: CopyRecord, copy: { mtimeMs: number; size: number }): boolean {
  return record.copyMtimeMs === copy.mtimeMs && record.copySize === copy.size;
}

/**
 * Brings the copies under `<own>/projects` in step with `extraDirs`: one copy per
 * `<extraDir>/projects/<project>/<session>.jsonl`, refreshed when the source has
 * changed, and removed once its folder is unconfigured or its source deleted.
 */
export async function mirrorSessions(extraDirs: string[], own: string): Promise<MirrorReport> {
  const report: MirrorReport = { sources: 0, copied: 0, pruned: 0, adopted: 0, errors: [] };
  const target = path.join(own, 'projects');
  const indexFile = path.join(own, INDEX_FILE);
  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (err) {
    report.errors.push(`could not open ${target}: ${errorMessage(err)}`);
    return report;
  }

  const index = await readIndex(indexFile);
  const next: CopyIndex = {};

  for (const dir of extraDirs) {
    const source = path.join(dir, 'projects');
    const projects = await entries(source);
    if (!projects.length) continue;
    report.sources++;
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const from = path.join(source, project.name);
      for (const file of await entries(from)) {
        // isFile() is lstat-based here, matching how the SDK enumerates its own
        // sessions: a symlink in the source folder is skipped either way.
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const key = path.join(project.name, file.name);
        // The same session id in two configured folders: the first one wins,
        // rather than the two overwriting each other on alternate runs.
        if (next[key]) continue;
        const transcript = path.join(from, file.name);
        const copy = path.join(target, key);
        try {
          const record = index[key];
          const sourceStat = await statOf(transcript);
          if (!sourceStat) continue;
          const copyStat = await statOf(copy);

          if (copyStat && !record) continue; // the add-on's own transcript wins
          if (copyStat && record && !untouched(record, copyStat)) {
            // Continued here since the copy was made. Leaving it out of `next`
            // keeps it and stops tracking it, so the source can never overwrite
            // that history; the prune pass below counts it.
            continue;
          }
          if (
            copyStat &&
            record &&
            record.source === transcript &&
            record.sourceMtimeMs === sourceStat.mtimeMs &&
            record.sourceSize === sourceStat.size
          ) {
            next[key] = record; // already current
            continue;
          }

          await fsp.mkdir(path.dirname(copy), { recursive: true });
          const tmp = `${copy}.ha-tmp`;
          await fsp.copyFile(transcript, tmp);
          await fsp.rename(tmp, copy);
          const written = await statOf(copy);
          if (!written) throw new Error('the copy disappeared as it was written');
          next[key] = {
            source: transcript,
            sourceMtimeMs: sourceStat.mtimeMs,
            sourceSize: sourceStat.size,
            copyMtimeMs: written.mtimeMs,
            copySize: written.size,
          };
          report.copied++;
        } catch (err) {
          report.errors.push(`could not copy ${transcript}: ${errorMessage(err)}`);
        }
      }
    }
  }

  // Anything the index still claims that this run did not account for: its
  // source is gone, or its folder is no longer configured.
  for (const [key, record] of Object.entries(index)) {
    if (next[key]) continue;
    const copy = path.join(target, key);
    const copyStat = await statOf(copy);
    if (!copyStat) continue;
    if (!untouched(record, copyStat)) {
      report.adopted++; // continued here, so it stays and stops being tracked
      continue;
    }
    if (insideAny(extraDirs, record.source) && (await statOf(record.source))) {
      // Still configured and still there, but this run did not reach it - an
      // unreadable folder, say. Keep the copy and the record rather than
      // dropping a session over a transient error.
      next[key] = record;
      continue;
    }
    try {
      await fsp.unlink(copy);
      report.pruned++;
      await fsp.rmdir(path.dirname(copy)).catch(() => undefined);
    } catch (err) {
      report.errors.push(`could not remove ${copy}: ${errorMessage(err)}`);
    }
  }

  try {
    if (Object.keys(next).length) await writeIndex(indexFile, next);
    else await fsp.rm(indexFile, { force: true });
  } catch (err) {
    report.errors.push(`could not write ${indexFile}: ${errorMessage(err)}`);
  }
  return report;
}

// The panel asks for the session list on every reconnect and after every
// session event, so the walk is coalesced: one run at a time, and at most one
// run per THROTTLE_MS unless a caller insists.
const THROTTLE_MS = 5000;
let inFlight: Promise<MirrorReport> | null = null;
let last: { at: number; report: MirrorReport } | null = null;

export function syncSessionMirror(
  extraDirs: string[],
  own: string,
  { force = false }: { force?: boolean } = {}
): Promise<MirrorReport> {
  if (inFlight) return inFlight;
  if (!force && last && Date.now() - last.at < THROTTLE_MS) return Promise.resolve(last.report);
  inFlight = mirrorSessions(extraDirs, own)
    .then((report) => {
      last = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
