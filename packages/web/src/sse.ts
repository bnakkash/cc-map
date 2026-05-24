import { useEffect } from "react";
import { getToken } from "./api.js";

export type SseEvent =
  | { type: "delta"; added: Array<{ id: string; sessionId: string; [k: string]: unknown }>; sessionsTouched: Array<{ sessionId: string; nodeCount: number; promptCount: number; lastActivityAt: string | null; [k: string]: unknown }> }
  | { type: "active-session"; sessionId: string | null; at: string | null };

/**
 * Opens an SSE connection to /api/stream. The native EventSource API can't set
 * custom headers, so we pass the token via query string.
 *
 * `onConnect` fires on initial open AND on every auto-reconnect — use it to
 * re-fetch full state and backfill any events missed during the disconnect window
 * (EventSource doesn't replay missed events on reconnect).
 */
export function useSse(
  onEvent: (e: SseEvent) => void,
  onConnect?: () => void,
): void {
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
    es.onopen = () => {
      // eslint-disable-next-line no-console
      console.log("[cc-map] sse connected");
      onConnect?.();
    };
    es.onerror = () => {
      // EventSource will auto-reconnect. onopen fires again on success.
      // eslint-disable-next-line no-console
      console.log("[cc-map] sse error — reconnecting");
    };
    return () => es.close();
  }, [onEvent, onConnect]);
}
