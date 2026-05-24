import { useEffect } from "react";
import { getToken } from "./api.js";

export type SseEvent =
  | { type: "delta"; added: Array<{ id: string; sessionId: string; [k: string]: unknown }>; sessionsTouched: Array<{ sessionId: string; nodeCount: number; promptCount: number; lastActivityAt: string | null; [k: string]: unknown }> }
  | { type: "active-session"; sessionId: string | null; at: string | null };

/**
 * Opens an SSE connection to /api/stream. The native EventSource API can't set
 * custom headers, so we pass the token via query string.
 */
export function useSse(onEvent: (e: SseEvent) => void): void {
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const url = `/api/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    const handler = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as SseEvent;
        onEvent(data);
      } catch {
        // ignore malformed
      }
    };

    es.addEventListener("delta", handler);
    es.addEventListener("active-session", handler);
    es.onerror = () => {
      // EventSource will auto-reconnect. We don't surface the error.
    };
    return () => es.close();
  }, [onEvent]);
}
