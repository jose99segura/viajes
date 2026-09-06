import { captureSpan, latestPackages, latestSnapshot } from "@/db/queries";
import { buildContext } from "@/lib/chat/context";
import { SYSTEM_INTRO } from "@/lib/chat/prompt";
import {
  MissingCredentials,
  streamReply,
  type ChatMessage,
} from "@/lib/chat/provider";
import { loadConfig } from "@/lib/config";

/**
 * The chat endpoint: the conversation in, the reply streamed out as SSE —
 * `data: {"text": ...}` chunks, `data: {"error": ...}` on failure, then
 * `data: [DONE]`. Same wire format as the Flask /api/chat, so the panel's
 * reader ported as-is.
 *
 * The snapshot is rendered into the system prompt per request. It is a
 * few thousand tokens and changes with every fetch; caching it across
 * requests would mean answering from a stale snapshot after a fetch.
 */

export const dynamic = "force-dynamic";

const MAX_HISTORY = 20;

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  // Keep only the fields the providers accept, and cap history length.
  const messages: ChatMessage[] = (payload.messages ?? [])
    .slice(-MAX_HISTORY)
    .filter(
      (m): m is ChatMessage =>
        (m.role === "user" || m.role === "assistant") && !!m.content,
    )
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) {
    return Response.json({ error: "messages requeridos" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const event = (data: unknown) =>
    encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const cfg = loadConfig();
        const [rows, packages, captures] = await Promise.all([
          latestSnapshot(),
          latestPackages(),
          captureSpan(),
        ]);
        const system = `${SYSTEM_INTRO}\n\n${buildContext(rows, packages, captures, cfg)}`;
        for await (const chunk of streamReply(system, messages)) {
          controller.enqueue(event({ text: chunk }));
        }
      } catch (err) {
        const message =
          err instanceof MissingCredentials
            ? err.message
            : `${(err as Error).name}: ${(err as Error).message}`;
        controller.enqueue(event({ error: message }));
      }
      controller.enqueue(event("[DONE]"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      // Tells a buffering proxy (Traefik, nginx) to pass chunks through.
      "X-Accel-Buffering": "no",
    },
  });
}
