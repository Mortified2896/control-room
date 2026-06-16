import { getAvailableModels } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = getAvailableModels();
  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
