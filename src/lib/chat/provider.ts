/**
 * Which LLM answers, and how its stream is read. Port of provider() /
 * _stream_gemini() / _stream_claude() in flighttracker/chat.py.
 *
 * Both providers are called over plain REST with fetch. No SDK: the Python
 * side avoided google-genai because of a native dependency, and here an SDK
 * would add a dependency for two HTTP calls whose wire formats are stable.
 * Gemini wins when both keys are set, as before.
 */

export type Provider = "gemini" | "claude";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class MissingCredentials extends Error {}

const GEMINI_DEFAULT_MODEL = "gemini-3.7-flash";
const CLAUDE_MODEL = "claude-opus-5";

export function provider(): { name: Provider; model: string } {
  if (process.env.GEMINI_API_KEY) {
    return { name: "gemini", model: process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: "claude", model: CLAUDE_MODEL };
  }
  throw new MissingCredentials(
    "Falta la API key. Añade GEMINI_API_KEY (o ANTHROPIC_API_KEY) al entorno y reinicia.",
  );
}

/** Text chunks of the reply. Throws MissingCredentials before streaming. */
export async function* streamReply(
  system: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const { name, model } = provider();
  if (name === "gemini") yield* streamGemini(model, system, messages);
  else yield* streamClaude(model, system, messages);
}

/** "data: ..." lines out of an SSE body, one payload at a time. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  // UTF-8 with stream: true, so a "€" split across chunks is not mangled.
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data: ")) yield line.slice(6).trim();
    }
  }
}

async function* streamGemini(
  model: string,
  system: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`,
  );
  url.searchParams.set("alt", "sse");
  url.searchParams.set("key", process.env.GEMINI_API_KEY!);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: 8000 },
    }),
  });
  if (!res.ok || !res.body) {
    let detail = (await res.text()).slice(0, 400);
    if (res.status === 404) {
      detail =
        `El modelo '${model}' no existe o no está disponible para tu clave. ` +
        `Cambia GEMINI_MODEL. (${detail})`;
    }
    throw new Error(`Gemini ${res.status}: ${detail}`);
  }
  for await (const payload of sseData(res.body)) {
    if (payload === "[DONE]") break;
    let chunk: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    for (const cand of chunk.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        if (part.text) yield part.text;
      }
    }
  }
}

async function* streamClaude(
  model: string,
  system: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      stream: true,
      // Cached: the snapshot is the same for every turn of a conversation.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  for await (const payload of sseData(res.body)) {
    let evt: { type?: string; delta?: { type?: string; text?: string } };
    try {
      evt = JSON.parse(payload);
    } catch {
      continue;
    }
    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
      yield evt.delta.text;
    }
    if (evt.type === "message_stop") break;
  }
}
