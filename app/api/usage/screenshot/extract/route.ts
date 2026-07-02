import "server-only";

import { NextResponse } from "next/server";
import { applyExplicitProvider, buildExtractResult } from "@/lib/usage/screenshot-parser";
import {
  ProviderUsageSnapshotSchema,
  type ProviderUsageSnapshot,
} from "@/lib/usage/snapshot-shape";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB hard cap on uploaded image.

/**
 * POST /api/usage/screenshot/extract
 *
 * Accepts a multipart/form-data upload with an image file + optional
 * `providerId` (`minimax` | `codex`) + optional `notes`. Returns a
 * candidate snapshot shell that the UI must display + edit + confirm
 * before any value is persisted.
 *
 * Hard rules (enforced here):
 *   * This endpoint NEVER calls provider websites, provider APIs, or
 *     OpenAI. It does NOT perform OCR. It only runs a label-substring
 *     heuristic against the filename and (optional) textual payload
 *     the client may have attached.
 *   * The response ALWAYS carries `extractionMode: "manual_placeholder"`
 *     and `requiresUserConfirmation: true`. The candidate fields are
 *     empty unless the user (or the client) typed values into them.
 *   * The body is capped at 8 MB. Larger uploads return 413.
 */
export async function POST(req: Request) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", message: "Multipart form-data is required." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  const providerIdRaw = formData.get("providerId");
  const notesRaw = formData.get("notes");

  const explicitProviderId =
    typeof providerIdRaw === "string" && (providerIdRaw === "minimax" || providerIdRaw === "codex")
      ? providerIdRaw
      : null;
  const notes = typeof notesRaw === "string" ? notesRaw.slice(0, 2000) : null;

  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "invalid_body", message: "Missing 'file' part." },
      { status: 400 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: `Image exceeds ${MAX_BYTES / (1024 * 1024)} MB cap.` },
      { status: 413 },
    );
  }

  // We never decode the image (no OCR). For the heuristic we read the
  // first ~64 KB of the bytes as ASCII so a partial OCR transcript or
  // a base64-encoded text comment embedded by the client still matches
  // labels. Images are not OCR'd.
  const headerBuf = await file.slice(0, 64 * 1024).arrayBuffer();
  const headerText = bufferToText(headerBuf);

  const filename =
    "name" in file && typeof (file as { name?: unknown }).name === "string"
      ? (file as File).name
      : "screenshot.png";

  // Optional inline field overrides. The UI passes the user's typed
  // values through the form so the candidate preserves them between
  // the drop event and the confirm event.
  const fields = readFields(formData);

  const result = buildExtractResult({
    filename,
    base64Content: headerText,
    explicitProviderId,
    notes,
    fields,
  });

  if (!result.ok) {
    return NextResponse.json({ error: "invalid_body", errors: result.errors }, { status: 400 });
  }

  let candidate: ProviderUsageSnapshot = result.value.candidate;
  if (explicitProviderId) {
    candidate = applyExplicitProvider(candidate, explicitProviderId);
    // Re-validate after override.
    const re = ProviderUsageSnapshotSchema.safeParse(candidate);
    if (!re.success) {
      return NextResponse.json(
        {
          error: "invalid_body",
          errors: re.error.issues.map((iss) => ({
            path: iss.path.join(".") || "<root>",
            message: iss.message,
          })),
        },
        { status: 400 },
      );
    }
    candidate = re.data;
  }

  return NextResponse.json(
    {
      extractionMode: "manual_placeholder" as const,
      detectedProvider: result.value.detectedProvider,
      providerConfidence: result.value.providerConfidence,
      matchedLabels: result.value.matchedLabels,
      requiresUserConfirmation: true as const,
      candidate,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function bufferToText(buf: ArrayBuffer): string {
  // Decode as latin1 so every byte becomes a printable char. This
  // lets the heuristic match against raw image bytes without crashing
  // on invalid UTF-8 sequences.
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function readFields(formData: FormData): Record<string, unknown> {
  const json = formData.get("fields");
  if (typeof json !== "string" || json.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty fields
  }
  return {};
}
