import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { logActivity } from "@/lib/logger";
import { isKnownCli } from "@/lib/cli-registry";
import { resolveDownloadSource } from "@/lib/download-session";

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string; session: string }> }
): Promise<NextResponse> {
  const { project, session } = await params;
  const cliParam = request.nextUrl.searchParams.get("cli") ?? "claude";
  if (!isKnownCli(cliParam)) {
    return jsonError("Unknown cli", 400);
  }
  const cli = cliParam;

  let source;
  try {
    source = await resolveDownloadSource(cli, project, session);
  } catch (e) {
    if (e instanceof RangeError) return jsonError("Invalid project or session", 400);
    return jsonError("Failed to resolve session log", 500);
  }
  if (!source) return jsonError("Session log not found", 404);

  logActivity("anonymous", "download-log", `cli=${cli} project=${project} session=${session}`);

  if (source.kind === "synthesized") {
    return new NextResponse(source.body, {
      headers: {
        "Content-Type": source.contentType,
        "Content-Disposition": `attachment; filename="${session}.${source.extension}"`,
      },
    });
  }

  try {
    // Eagerly check file existence — createReadStream errors are async and would
    // escape the try/catch after response headers are already sent.
    await stat(source.path);
    const nodeStream = createReadStream(source.path);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    return new NextResponse(webStream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${session}.jsonl"`,
      },
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || e instanceof RangeError) {
      return jsonError("Session log not found", 404);
    }
    return jsonError("Failed to read session log", 500);
  }
}
