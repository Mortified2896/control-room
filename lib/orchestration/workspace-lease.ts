import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { WorkspaceBusyError } from "./agent-adapter";

type LeaseRecord = {
  lease_id: string;
  acquired_at: string;
  heartbeat_at: string;
};

export type WorkspaceLease = {
  leaseId: string;
  release: () => Promise<void>;
};

function lockName(workspaceKey: string): string {
  return createHash("sha256").update(workspaceKey).digest("hex");
}

export class WorkspaceLeaseManager {
  readonly root: string;
  readonly staleAfterMs: number;
  readonly heartbeatMs: number;

  constructor(options: { root: string; staleAfterMs?: number; heartbeatMs?: number }) {
    this.root = options.root;
    this.staleAfterMs = options.staleAfterMs ?? 10_000;
    this.heartbeatMs = options.heartbeatMs ?? 1_000;
  }

  async acquire(workspaceKey: string): Promise<WorkspaceLease> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });

    const leaseId = randomUUID();
    const leaseDirectory = join(this.root, lockName(workspaceKey) + ".lock");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(leaseDirectory, { mode: 0o700 });
        return await this.ownLease(leaseDirectory, leaseId);
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }

        if (!(await this.reclaimIfStale(leaseDirectory))) {
          throw new WorkspaceBusyError();
        }
      }
    }

    throw new WorkspaceBusyError();
  }

  private async ownLease(leaseDirectory: string, leaseId: string): Promise<WorkspaceLease> {
    const ownerPath = join(leaseDirectory, "owner.json");
    const acquiredAt = new Date().toISOString();
    let released = false;

    const writeHeartbeat = async () => {
      const record: LeaseRecord = {
        lease_id: leaseId,
        acquired_at: acquiredAt,
        heartbeat_at: new Date().toISOString(),
      };
      const temporaryPath = join(leaseDirectory, "owner." + leaseId + ".tmp");
      const handle = await open(temporaryPath, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, ownerPath);
    };

    let heartbeatWrite = Promise.resolve();
    const queueHeartbeat = () => {
      heartbeatWrite = heartbeatWrite.then(writeHeartbeat);
      return heartbeatWrite;
    };

    await queueHeartbeat();
    const heartbeat = setInterval(
      () => void queueHeartbeat().catch(() => undefined),
      this.heartbeatMs,
    );
    heartbeat.unref();

    return {
      leaseId,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        await heartbeatWrite;

        try {
          const current = JSON.parse(await readFile(ownerPath, "utf8")) as LeaseRecord;
          if (current.lease_id === leaseId) {
            await rm(leaseDirectory, { recursive: true });
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      },
    };
  }

  private async reclaimIfStale(leaseDirectory: string): Promise<boolean> {
    let owner: LeaseRecord;
    try {
      const parsed = JSON.parse(
        await readFile(join(leaseDirectory, "owner.json"), "utf8"),
      ) as unknown;
      if (!isLeaseRecord(parsed)) {
        return this.reclaimUnreadableIfStale(leaseDirectory);
      }
      owner = parsed;
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) {
        return this.reclaimUnreadableIfStale(leaseDirectory);
      }
      throw error;
    }

    const heartbeatAt = Date.parse(owner.heartbeat_at);
    if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= this.staleAfterMs) {
      return false;
    }
    return this.quarantine(leaseDirectory);
  }

  private async reclaimUnreadableIfStale(leaseDirectory: string): Promise<boolean> {
    try {
      const directory = await stat(leaseDirectory);
      if (Date.now() - directory.mtimeMs <= this.staleAfterMs) {
        return false;
      }
      return this.quarantine(leaseDirectory);
    } catch (error) {
      if (isNotFound(error)) return true;
      throw error;
    }
  }

  private async quarantine(leaseDirectory: string): Promise<boolean> {
    const quarantine = leaseDirectory + ".stale-" + randomUUID();
    try {
      await rename(leaseDirectory, quarantine);
    } catch (error) {
      if (isNotFound(error)) return true;
      throw error;
    }
    await rm(quarantine, { recursive: true });
    return true;
  }
}

function isLeaseRecord(value: unknown): value is LeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LeaseRecord>;
  return (
    typeof record.lease_id === "string" &&
    typeof record.acquired_at === "string" &&
    typeof record.heartbeat_at === "string"
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
