import "server-only";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { detectAuthType, getCodexVersion, getLoginStatus, resolveCodexBinary } from "./runner";

export type CodexAuthType = "chatgpt" | "api_key" | "unknown";
export type CodexStatus = "not_installed" | "not_logged_in" | "logged_in" | "error";

export type CodexStatusDto = {
  status: CodexStatus;
  binary: {
    path: string | null;
    version: string | null;
    resolvedFrom: "env" | "PATH" | null;
  };
  auth: {
    type: CodexAuthType | null;
    accountHint: string | null;
    authFile: string | null;
    storageMode: "file" | null;
  };
  usingSubscription: boolean;
  lastCheckedAt: string;
  errorMessage: string | null;
};

function authFilePath(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(process.env.HOME || "/root", ".codex");
  return path.join(home, "auth.json");
}

function readAuthFileShape(): { authFile: string | null; typeHint: CodexAuthType | null } {
  const p = authFilePath();
  if (!existsSync(p)) return { authFile: p, typeHint: null };
  try {
    const buf = readFileSync(p, { encoding: "utf8", flag: "r" });
    const head = buf.slice(0, 4096);
    const keyRegex = /"([A-Za-z0-9_]+)"\s*:/g;
    const keys = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = keyRegex.exec(head))) keys.add(m[1]);
    if (keys.has("tokens")) return { authFile: p, typeHint: "chatgpt" };
    if (keys.has("OPENAI_API_KEY")) return { authFile: p, typeHint: "api_key" };
    return { authFile: p, typeHint: null };
  } catch {
    return { authFile: p, typeHint: null };
  }
}

function baseStatus(
  status: CodexStatus,
  binaryPath: string | null,
  version: string | null,
  resolvedFrom: "env" | "PATH" | null,
  lastCheckedAt: string,
): CodexStatusDto {
  return {
    status,
    binary: { path: binaryPath, version, resolvedFrom },
    auth: {
      type: null,
      accountHint: null,
      authFile: binaryPath ? authFilePath() : null,
      storageMode: null,
    },
    usingSubscription: false,
    lastCheckedAt,
    errorMessage: null,
  };
}

export async function probeCodexStatus(): Promise<CodexStatusDto> {
  const lastCheckedAt = new Date().toISOString();
  const binaryPath = resolveCodexBinary();
  if (!binaryPath) return baseStatus("not_installed", null, null, null, lastCheckedAt);

  const resolvedFrom = process.env.CODEX_BIN_PATH?.trim() ? "env" : "PATH";
  const version = await getCodexVersion(binaryPath).catch(() => null);
  const loginState = await getLoginStatus(binaryPath).catch(() => "unknown" as const);

  if (loginState === "not_logged_in") {
    return baseStatus("not_logged_in", binaryPath, version, resolvedFrom, lastCheckedAt);
  }

  if (loginState === "unknown") {
    return {
      ...baseStatus("error", binaryPath, version, resolvedFrom, lastCheckedAt),
      errorMessage: "could not determine login state",
    };
  }

  let authType: CodexAuthType = await detectAuthType(binaryPath).catch(() => "unknown" as const);
  const shape = readAuthFileShape();
  if (authType === "unknown" && shape.typeHint) authType = shape.typeHint;

  return {
    status: "logged_in",
    binary: { path: binaryPath, version, resolvedFrom },
    auth: {
      type: authType,
      accountHint: null,
      authFile: shape.authFile ?? authFilePath(),
      storageMode: "file",
    },
    usingSubscription: authType === "chatgpt",
    lastCheckedAt,
    errorMessage: null,
  };
}
