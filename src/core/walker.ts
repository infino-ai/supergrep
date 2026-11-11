// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Gitignore-aware repository walk. Respects .gitignore files at every level
// (each applies to its own subtree), always skips VCS internals, vendored /
// generated directories, and the index directory itself.

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ignoreFactory, { type Ignore } from "ignore";
import { INDEX_DIR_NAME } from "./config.js";

// Vendored/generated directories skipped wherever they appear, gitignored or
// not - indexing them helps no one and bloats every search.
//
// Agent worktrees under `.claude/worktrees/` are deliberately NOT here, and
// the reason is worth writing down because adding them looks like an obvious
// win. They are full second checkouts, so walking them duplicates the whole
// tree - and a worktree holds a live branch, which is the code most worth
// searching, so skipping it hides exactly that.
//
// The duplication is handled where it belongs, by content: identical files are
// chunked once under their shallowest path (`canonicalPaths` in `indexer.ts`),
// so a second checkout costs almost nothing and only the files a branch
// actually changed add rows. Measured on a sixteen-repository workspace:
// 11,761 of 20,513 candidate files were byte-identical copies.
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", INDEX_DIR_NAME,
  "node_modules", "vendor", "dist", "build", "target", "out",
  "__pycache__", ".next", ".nuxt", ".venv", "venv", ".tox",
  ".gradle", ".idea", ".vscode", "coverage", ".cache", ".turbo",
]);

interface IgnoreLayer {
  /** Path of the directory the .gitignore lives in, relative to root ("" at root). */
  base: string;
  ig: Ignore;
}

export interface WalkedFile {
  /** Repo-root-relative path, "/"-separated. */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Whether `.gitignore` files are honoured (default true). Off indexes
   * gitignored content too; `SKIP_DIRS` and `.cxignore` still apply either
   * way. */
  respectGitignore?: boolean;
  /** Patterns that re-admit paths `.gitignore` excluded - gitignore syntax,
   * matched against repo-relative paths. The narrow tool for the common case:
   * one gitignored sibling repository or generated tree you do want indexed,
   * without turning `.gitignore` off wholesale.
   *
   * It cannot re-admit anything `.cxignore` or `SKIP_DIRS` excluded, because
   * those are not git's opinion - one is yours and the other is never useful
   * to index. */
  include?: string[];
}

export interface WalkResult {
  files: WalkedFile[];
  /** Directories left out because a `.gitignore` matched them, root-relative
   * and outermost-only (the walk does not descend, so each entry stands for
   * its whole subtree). Empty when nothing was ignored, or when the walk was
   * asked not to honour `.gitignore`. `SKIP_DIRS` prunes are deliberately NOT
   * here: `.git` and `node_modules` are the normal state of every walk and
   * reporting them would bury the ones that matter. */
  ignoredDirs: string[];
}

/** Yield candidate files under `root`, gitignore-aware, sorted shallow-first
 * (a README or top-level src file beats a deeply nested one when a cap
 * truncates), plus the directories `.gitignore` kept out.
 *
 * The ignored list exists because `.gitignore` means "do not version-control"
 * and not "do not search": a workspace whose sibling repos are gitignored, a
 * generated docs tree, a vendored dependency somebody greps - all are worth
 * indexing, and dropping them silently turns "no match" into a wrong answer
 * the caller cannot see. The walk still honours `.gitignore` by default; it
 * just stops being quiet about it. */
export function walkRepo(root: string, options: WalkOptions = {}): WalkResult {
  const files: WalkedFile[] = [];
  const ignoredDirs: string[] = [];
  const patterns = (options.include ?? []).filter((p) => p.trim() !== "");
  walk(root, "", [], [], {
    acc: files,
    respectGitignore: options.respectGitignore !== false,
    ...(patterns.length > 0 ? { included: ignoreFactory().add(patterns) } : {}),
    ignoredDirs,
  });
  files.sort((a, b) => {
    const depth = a.path.split("/").length - b.path.split("/").length;
    return depth !== 0 ? depth : a.path.localeCompare(b.path);
  });
  ignoredDirs.sort();
  return { files, ignoredDirs };
}

/** The search-scope ignore file, read at every level exactly as `.gitignore`
 * is. It exists because `.gitignore` answers "do not version-control" and the
 * walk needs an answer to "do not search", which is a different question: a
 * gitignored sibling repository is worth indexing, and a committed 40MB
 * fixture directory is not. `.gitignore` cannot express the second without
 * also changing what git tracks.
 *
 * So this one is unconditional. `--no-ignore` turns off `.gitignore`, never
 * this, and `--include` cannot re-admit what it excluded - if you wrote it
 * down, you meant it. */
const CX_IGNORE_FILE = ".cxignore";

function loadIgnoreFile(dir: string, base: string, name: string): IgnoreLayer | undefined {
  try {
    const content = readFileSync(join(dir, name), "utf8");
    return { base, ig: ignoreFactory().add(content) };
  } catch {
    return undefined;
  }
}

function isIgnored(relPath: string, isDir: boolean, layers: IgnoreLayer[]): boolean {
  for (const { base, ig } of layers) {
    // A layer only sees paths inside its own directory, relative to it.
    const sub = base === "" ? relPath : relPath.slice(base.length + 1);
    // The ignore package rejects "."-style paths; directories are tested with
    // a trailing slash so `dir/` patterns match.
    if (sub && ig.ignores(isDir ? sub + "/" : sub)) return true;
  }
  return false;
}

/** Why a path is left out, or undefined when it is not: `.cxignore`'s
 * choice ("cx") cannot be overridden, git's ("git") can be by `included`. */
function exclusion(
  childRel: string,
  isDir: boolean,
  gitLayers: IgnoreLayer[],
  cxLayers: IgnoreLayer[],
  included: Ignore | undefined,
): "cx" | "git" | undefined {
  if (isIgnored(childRel, isDir, cxLayers)) return "cx";
  if (!isIgnored(childRel, isDir, gitLayers)) return undefined;
  const sub = isDir ? `${childRel}/` : childRel;
  if (included?.ignores(sub)) return undefined; // re-admitted
  return "git";
}

/** Whether a walk of `root` would admit the file at `rel` (root-relative,
 * "/" or the platform's separator): every directory on the way is a real
 * directory, none of them a skipped one (`SKIP_DIRS`) or ignored, the file is
 * a regular file and not ignored, and no part of the path is a symlink. The
 * same layers apply as in `walkRepo`, read from the same files, so a path
 * passes here exactly when the walk would list it. For callers that hold one
 * path and must not send anything an index of the folder would not: the
 * memory hook (commands/hook-cmd.ts). */
export function walkAdmits(root: string, rel: string, options: WalkOptions = {}): boolean {
  const parts = rel.split(/[\\/]/).filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.includes("..")) return false;
  const respectGitignore = options.respectGitignore !== false;
  const patterns = (options.include ?? []).filter((p) => p.trim() !== "");
  const included = patterns.length > 0 ? ignoreFactory().add(patterns) : undefined;
  let gitLayers: IgnoreLayer[] = [];
  let cxLayers: IgnoreLayer[] = [];
  let dir = root;
  let relSoFar = "";
  for (const [i, name] of parts.entries()) {
    const gitLayer = respectGitignore ? loadIgnoreFile(dir, relSoFar, ".gitignore") : undefined;
    if (gitLayer) gitLayers = [...gitLayers, gitLayer];
    const cxLayer = loadIgnoreFile(dir, relSoFar, CX_IGNORE_FILE);
    if (cxLayer) cxLayers = [...cxLayers, cxLayer];
    const childRel = relSoFar === "" ? name : `${relSoFar}/${name}`;
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    const last = i === parts.length - 1;
    if (last) return stat.isFile() && exclusion(childRel, false, gitLayers, cxLayers, included) === undefined;
    if (!stat.isDirectory() || SKIP_DIRS.has(name.toLowerCase())) return false;
    if (exclusion(childRel, true, gitLayers, cxLayers, included) !== undefined) return false;
    dir = path;
    relSoFar = childRel;
  }
  return false;
}

/** Everything the walk carries down the tree, so adding a rule does not add a
 * positional argument to every recursive call. */
interface WalkState {
  acc: WalkedFile[];
  respectGitignore: boolean;
  /** Re-admits paths `.gitignore` excluded; `undefined` when none were given. */
  included?: Ignore;
  /** Reported to the caller: what `.gitignore` kept out. `.cxignore` and the
   * skip list are deliberately absent - both are choices already written down,
   * and a warning about them would be noise. */
  ignoredDirs: string[];
}

function walk(
  dir: string,
  rel: string,
  gitLayers: IgnoreLayer[],
  cxLayers: IgnoreLayer[],
  state: WalkState,
): void {
  const gitLayer = state.respectGitignore ? loadIgnoreFile(dir, rel, ".gitignore") : undefined;
  const activeGit = gitLayer ? [...gitLayers, gitLayer] : gitLayers;
  const cxLayer = loadIgnoreFile(dir, rel, CX_IGNORE_FILE);
  const activeCx = cxLayer ? [...cxLayers, cxLayer] : cxLayers;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory - skip, don't fail the walk
  }

  /** Whether git's opinion stands: it can be overridden by `--include`, and
   * `.cxignore`'s cannot be overridden at all. */
  const excluded = (childRel: string, isDir: boolean) => exclusion(childRel, isDir, activeGit, activeCx, state.included);

  for (const entry of entries) {
    const name = entry.name;
    const childRel = rel === "" ? name : `${rel}/${name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      const why = excluded(childRel, true);
      if (why !== undefined) {
        // Only git's exclusions are reported: a `.cxignore` entry is the
        // caller's own instruction, and warning about it every run would train
        // them to stop reading the warning that matters.
        if (why === "git") state.ignoredDirs.push(childRel);
        continue;
      }
      walk(join(dir, name), childRel, activeGit, activeCx, state);
    } else if (entry.isFile()) {
      if (excluded(childRel, false) !== undefined) continue;
      let stat;
      try {
        stat = statSync(join(dir, name));
      } catch {
        continue;
      }
      state.acc.push({ path: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    // symlinks are skipped: following them risks cycles and out-of-repo reads
  }
}
