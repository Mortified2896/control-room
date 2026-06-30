import "server-only";

import { basename, resolve } from "node:path";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tryDb, withClient } from "@/lib/db";
import type { ProjectRow } from "./types";

const execFileAsync = promisify(execFile);
export const PROJECTS_ROOT = "/home/hermes/workspace/repos";

type RawProject = {
  id: string;
  name: string;
  local_path: string;
  git_remote_url: string | null;
  git_branch: string | null;
  created_at: Date;
  updated_at: Date;
  last_opened_at: Date | null;
};

function toProjectRow(r: RawProject): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    localPath: r.local_path,
    repoPath: r.local_path,
    gitRemoteUrl: r.git_remote_url,
    gitBranch: r.git_branch,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    lastOpenedAt: r.last_opened_at?.toISOString() ?? null,
  };
}

export type ProjectPathValidation =
  | { ok: true; realPath: string }
  | { ok: false; reason: "missing" | "not_directory" | "outside_workspace" | "not_git_repo" };

export type BrowsedProjectFolder = {
  name: string;
  localPath: string;
  isGitRepo: boolean;
  isAlreadyProject: boolean;
  gitRemoteUrl: string | null;
  gitBranch: string | null;
};

export async function validateProjectPath(localPath: string): Promise<ProjectPathValidation> {
  const trimmed = localPath.trim();
  if (!trimmed) return { ok: false, reason: "missing" };

  let pathReal: string;
  let rootReal: string;
  try {
    await access(trimmed, constants.F_OK);
    const s = await stat(trimmed);
    if (!s.isDirectory()) return { ok: false, reason: "not_directory" };
    pathReal = await realpath(trimmed);
    rootReal = await realpath(PROJECTS_ROOT);
  } catch {
    return { ok: false, reason: "missing" };
  }

  const rootWithSlash = rootReal.endsWith("/") ? rootReal : `${rootReal}/`;
  if (pathReal !== rootReal && !pathReal.startsWith(rootWithSlash)) {
    return { ok: false, reason: "outside_workspace" };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", pathReal, "rev-parse", "--is-inside-work-tree"],
      {
        timeout: 2000,
        maxBuffer: 1024 * 16,
      },
    );
    if (stdout.trim() !== "true") return { ok: false, reason: "not_git_repo" };
  } catch {
    return { ok: false, reason: "not_git_repo" };
  }

  return { ok: true, realPath: pathReal };
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      {
        timeout: 2000,
        maxBuffer: 1024 * 16,
      },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function gitValue(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 2000,
      maxBuffer: 1024 * 64,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function browseProjectFolders(path = PROJECTS_ROOT): Promise<BrowsedProjectFolder[]> {
  const rootReal = await realpath(PROJECTS_ROOT);
  let browseReal: string;
  try {
    browseReal = await realpath(resolve(path));
  } catch {
    browseReal = rootReal;
  }

  const rootWithSlash = rootReal.endsWith("/") ? rootReal : `${rootReal}/`;
  if (browseReal !== rootReal && !browseReal.startsWith(rootWithSlash)) {
    throw Object.assign(new Error("outside_workspace"), { code: "outside_workspace" });
  }

  const projects = await listProjects();
  const openedPaths = new Set(projects.map((project) => project.localPath));
  const entries = await readdir(browseReal, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const localPath = `${browseReal}/${entry.name}`;
        const gitRepo = await isGitRepo(localPath);
        return {
          name: entry.name,
          localPath,
          isGitRepo: gitRepo,
          isAlreadyProject: openedPaths.has(localPath),
          gitRemoteUrl: gitRepo ? await gitValue(localPath, ["remote", "get-url", "origin"]) : null,
          gitBranch: gitRepo ? await gitValue(localPath, ["branch", "--show-current"]) : null,
        } satisfies BrowsedProjectFolder;
      }),
  );

  return folders.sort((a, b) => {
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listProjects(): Promise<ProjectRow[]> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawProject>(
      `SELECT id, name, local_path, git_remote_url, git_branch, created_at, updated_at, last_opened_at
       FROM projects
       ORDER BY last_opened_at DESC NULLS LAST, updated_at DESC
       LIMIT 100`,
    );
    return rows.map(toProjectRow);
  }, []);
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawProject>(
      `SELECT id, name, local_path, git_remote_url, git_branch, created_at, updated_at, last_opened_at
       FROM projects WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? toProjectRow(rows[0]) : null;
  }, null);
}

export async function openProject(localPath: string): Promise<ProjectRow> {
  const validated = await validateProjectPath(localPath);
  if (!validated.ok) throw Object.assign(new Error(validated.reason), { code: validated.reason });

  const normalized = validated.realPath;
  const name = basename(normalized);
  const gitRemoteUrl = await gitValue(normalized, ["remote", "get-url", "origin"]);
  const gitBranch = await gitValue(normalized, ["branch", "--show-current"]);

  return withClient(async (c) => {
    try {
      const { rows } = await c.query<RawProject>(
        `INSERT INTO projects (name, local_path, repo_path, git_remote_url, git_branch, last_opened_at)
         VALUES ($1, $2, $2, $3, $4, now())
         ON CONFLICT (local_path) DO UPDATE SET
           name = EXCLUDED.name,
           repo_path = EXCLUDED.repo_path,
           git_remote_url = EXCLUDED.git_remote_url,
           git_branch = EXCLUDED.git_branch,
           last_opened_at = now()
         RETURNING id, name, local_path, git_remote_url, git_branch, created_at, updated_at, last_opened_at`,
        [name, normalized, gitRemoteUrl, gitBranch],
      );
      return toProjectRow(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code !== "42703") throw err;
      const { rows } = await c.query<RawProject>(
        `INSERT INTO projects (name, local_path, git_remote_url, git_branch, last_opened_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (local_path) DO UPDATE SET
           name = EXCLUDED.name,
           git_remote_url = EXCLUDED.git_remote_url,
           git_branch = EXCLUDED.git_branch,
           last_opened_at = now()
         RETURNING id, name, local_path, git_remote_url, git_branch, created_at, updated_at, last_opened_at`,
        [name, normalized, gitRemoteUrl, gitBranch],
      );
      return toProjectRow(rows[0]);
    }
  });
}
