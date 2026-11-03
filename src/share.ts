import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// The share folder is the only place the daemon reads from. Everything here
// fails closed: symlinks are never followed (one could point anywhere), sizes
// are checked from lstat before a byte is read, and only text gets through.

export const SHARE_LIMITS = { fileBytes: 64 * 1024, totalBytes: 256 * 1024 } as const;

export type ShareFile = { readonly path: string; readonly content: string };
export type Skipped = { readonly path: string; readonly reason: string };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Relative posix paths of every regular file and symlink under dir, sorted. Dotfiles are ignored. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith("."))
      .map(async (e) => {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        return e.isDirectory() && !e.isSymbolicLink() ? walk(dir, rel) : [rel];
      }),
  );
  return nested.flat().sort();
}

export async function readShare(dir: string): Promise<{ readonly files: readonly ShareFile[]; readonly skipped: readonly Skipped[] }> {
  const files: ShareFile[] = [];
  const skipped: Skipped[] = [];
  let total = 0;
  for (const path of await walk(dir)) {
    const info = await lstat(join(dir, path));
    if (info.isSymbolicLink()) {
      skipped.push({ path, reason: "symlink" });
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > SHARE_LIMITS.fileBytes) {
      skipped.push({ path, reason: "too large" });
      continue;
    }
    if (total + info.size > SHARE_LIMITS.totalBytes) {
      skipped.push({ path, reason: "over total budget" });
      continue;
    }
    const bytes = await readFile(join(dir, path));
    let content: string;
    try {
      content = strictUtf8.decode(bytes);
    } catch {
      skipped.push({ path, reason: "not text" });
      continue;
    }
    if (content.includes("\u0000")) {
      skipped.push({ path, reason: "not text" });
      continue;
    }
    total += info.size;
    files.push({ path, content });
  }
  return { files, skipped };
}
