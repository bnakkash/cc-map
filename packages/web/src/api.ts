// Shared API types kept in sync with @cc-map/server. Could be a shared package later.

export interface SessionListItem {
  sessionId: string;
  projectSlug: string;
  cwd: string | null;
  nodeCount: number;
  promptCount: number;
  startedAt: string | null;
  lastActivityAt: string | null;
}

export interface ActiveSessionInfo {
  sessionId: string | null;
  at: string | null;
}

export interface SessionsResponse {
  sessions: SessionListItem[];
  activeSession: ActiveSessionInfo;
}

export interface ChipItem {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  subtype: string | null;
  timestamp: string;
  preview: string;
  contentLength: number;
  isSidechain: boolean;
  sharedWith: string[];
}

export interface SessionMeta {
  sessionId: string;
  projectSlug: string;
  filePath: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  cwd: string | null;
  nodeCount: number;
  promptCount: number;
}

export interface ChipsResponse {
  sessionId: string;
  meta: SessionMeta;
  chips: ChipItem[];
}

export interface NodeResponse {
  node: ChipItem & {
    projectSlug: string;
    cwd: string | null;
    gitBranch: string | null;
    agentId: string | null;
    classification: { role: "user" | "assistant"; subtype?: string };
  };
  raw: unknown;
}

// ───── Token handling ─────

const TOKEN_KEY = "cc-map-token";

export function getToken(): string | null {
  // Prefer URL ?token=...
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    // Clean URL
    params.delete("token");
    const newSearch = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash,
    );
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ───── REST ─────

const BASE = ""; // proxied to localhost:5781 in dev, served from same origin in prod

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  sessions: () => get<SessionsResponse>("/api/sessions"),
  chips: (sessionId: string) => get<ChipsResponse>(`/api/sessions/${sessionId}/chips`),
  node: (sessionId: string, uuid: string) =>
    get<NodeResponse>(`/api/sessions/${sessionId}/nodes/${uuid}`),
};
