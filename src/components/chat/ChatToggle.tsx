"use client";

import { setChatOpen, useChatOpen } from "./chat-store";

/** "💬 Preguntar a la IA" in the topbar. */
export function ChatToggle() {
  const open = useChatOpen();
  return (
    <button
      type="button"
      className={`icon-btn primary${open ? " on" : ""}`}
      onClick={() => setChatOpen(!open)}
    >
      💬 Preguntar a la IA
    </button>
  );
}
