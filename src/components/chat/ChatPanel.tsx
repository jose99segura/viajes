"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setChatOpen, useChatOpen } from "./chat-store";
import { TripCard } from "./TripCard";
import { favoriteKey } from "@/lib/favorites";
import { splitReply } from "@/lib/chat/markdown";

/**
 * "Preguntar a la IA" — the chat aside. Port of the chat half of app.js.
 *
 * The conversation lives in this component: it is a scratch conversation
 * about the current snapshot, not something to persist. The assistant's
 * reply streams in over SSE from /api/chat; marker lines in it become
 * TripCards the user can save straight into favourites.
 */

const SUGGESTIONS = [
  "¿Cuál es el mejor finde para ir a Alicante?",
  "¿Compensa salir desde LUX o mejor Ryanair desde HHN?",
  "Quiero 4 noches sin pedir día libre. ¿Qué me recomiendas?",
  "¿Han bajado los precios desde la última captura?",
];

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: boolean;
}

interface Status {
  ready: boolean;
  provider?: string;
  model?: string;
  reason?: string;
}

async function fetchStatus(): Promise<Status> {
  try {
    return (await (await fetch("/api/chat/status")).json()) as Status;
  } catch {
    return { ready: false, reason: "No se pudo comprobar el estado." };
  }
}

/** null on failure: the save buttons just keep their last state. */
async function fetchFavoriteKeys(): Promise<Set<string> | null> {
  try {
    const data = (await (await fetch("/api/favorites")).json()) as { keys: string[] };
    return new Set(data.keys);
  } catch {
    return null;
  }
}

export function ChatPanel() {
  const open = useChatOpen();
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [favKeys, setFavKeys] = useState<Set<string>>(new Set());
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const loadFavs = useCallback(() => {
    fetchFavoriteKeys().then((keys) => {
      if (keys) setFavKeys(keys);
    });
  }, []);

  // Provider status and saved keys, once the panel is first opened. State
  // is set only after the awaits, never synchronously in the effect body.
  useEffect(() => {
    if (!open || status !== null) return;
    let alive = true;
    (async () => {
      const [s, keys] = await Promise.all([fetchStatus(), fetchFavoriteKeys()]);
      if (!alive) return;
      setStatus(s);
      if (keys) setFavKeys(keys);
    })();
    const focus = setTimeout(() => input.current?.focus(), 180);
    return () => {
      alive = false;
      clearTimeout(focus);
    };
  }, [open, status]);

  // Keep the newest message in view as it streams.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (input.current) {
      input.current.value = "";
      input.current.style.height = "auto";
    }
    const history = messages.filter((m) => !m.streaming && !m.error);
    const outgoing = [...history, { role: "user" as const, content: trimmed }];
    setMessages([...outgoing, { role: "assistant", content: "", streaming: true }]);
    setBusy(true);

    const update = (patch: Partial<Message>) =>
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        return [...ms.slice(0, -1), { ...last, ...patch }];
      });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: outgoing.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let content = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop()!;
        for (const evt of events) {
          if (!evt.startsWith("data: ")) continue;
          const raw = evt.slice(6);
          if (raw === "[DONE]") continue;
          const parsed = JSON.parse(raw) as { text?: string; error?: string };
          if (parsed.error) {
            content = parsed.error;
            update({ content, error: true });
          } else {
            content += parsed.text ?? "";
            update({ content });
          }
        }
      }
    } catch (err) {
      update({ content: `Error de conexión: ${(err as Error).message}`, error: true });
    }
    update({ streaming: false });
    setBusy(false);
  }

  return (
    <aside className={`chat${open ? " open" : ""}`} id="chat">
      <div className="chat-head">
        <span
          className={`dot${status?.ready ? "" : " off"}`}
          title={status?.ready ? `${status.provider} · ${status.model}` : undefined}
        />
        <b>Asistente</b>
        <div className="grow" />
        <button type="button" title="Limpiar conversación" onClick={() => setMessages([])}>
          ⟲
        </button>
        <button type="button" title="Cerrar" onClick={() => setChatOpen(false)}>
          ✕
        </button>
      </div>

      <div className="chat-log" ref={log}>
        {!messages.length ? (
          <>
            <div className="chat-empty">
              {status === null ? (
                "Comprobando…"
              ) : status.ready ? (
                <>
                  Pregúntame sobre tus vuelos. Veo el snapshot actual de precios, las
                  combinaciones de ida y vuelta y el histórico.
                  <br />
                  <span style={{ fontSize: 11.5 }}>modelo: {status.model ?? "?"}</span>
                </>
              ) : (
                <>
                  <b>Chat no disponible.</b>
                  <br />
                  {status.reason ?? "Falta configurar la API."}
                </>
              )}
            </div>
            {status?.ready && (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}${m.error ? " error" : ""}`}>
              <div className="who">{m.role === "user" ? "tú" : "asistente"}</div>
              <div className="body">
                {m.role === "user" || m.error ? (
                  m.content
                ) : (
                  splitReply(m.content).map((part, j) =>
                    part.kind === "html" ? (
                      // mdToHtml escapes the model's text before adding any
                      // markup of its own; nothing here is raw model output.
                      <span key={j} dangerouslySetInnerHTML={{ __html: part.html }} />
                    ) : (
                      <TripCard
                        key={j}
                        fav={part.fav}
                        saved={favKeys.has(favoriteKey(part.fav))}
                        onToggled={loadFavs}
                      />
                    ),
                  )
                )}
                {m.streaming && <span className="typing" />}
              </div>
            </div>
          ))
        )}
      </div>

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(input.current?.value ?? "");
        }}
      >
        <textarea
          ref={input}
          rows={1}
          placeholder="Pregunta sobre tus vuelos…"
          disabled={!status?.ready}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.currentTarget.value);
            }
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
          }}
        />
        <button type="submit" title="Enviar" disabled={busy || !status?.ready}>
          ↑
        </button>
      </form>
    </aside>
  );
}
