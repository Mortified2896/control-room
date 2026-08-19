import { NextResponse } from "next/server";
import { browseProjectFolders, PROJECTS_ROOT } from "@/lib/repo/projects";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedPath = url.searchParams.get("path") ?? PROJECTS_ROOT;

  try {
    const folders = await browseProjectFolders(requestedPath);
    return NextResponse.json({ root: PROJECTS_ROOT, folders });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const outsideWorkspace = code === "outside_workspace";
    return NextResponse.json(
      {
        error: outsideWorkspace ? "outside_workspace" : "browse_failed",
        message: outsideWorkspace
          ? "Project browsing is restricted to /home/hermes/workspace/repos"
          : err instanceof Error
            ? err.message
            : "Failed to browse project folders",
        folders: [],
      },
      { status: outsideWorkspace ? 400 : 500 },
    );
  }
}
