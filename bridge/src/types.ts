export interface CreateSessionRequest {
  session: string;
  /** Optional browser runtime. Patchright remains the default. */
  runtime?: 'patchright' | 'camoufox';
  /** Persistent browser profile directory path. */
  profile?: string;
  /** Storage state JSON file path or inline storage state object. */
  storageState?: string | {
    cookies?: unknown[];
    origins?: unknown[];
    [key: string]: unknown;
  };
  /** Auto-save/load state persistence name for the daemon. */
  sessionName?: string;
  proxy?: {
    server: string;
    bypass?: string;
    username?: string;
    password?: string;
  };
  headless?: boolean;
  headers?: Record<string, string>;
  viewport?: { width: number; height: number };
  userAgent?: string;
}

export interface CreateSessionResponse {
  session: string;
  status: 'created';
  created_at: string;
}

export interface CommandRequest {
  id?: string;
  action: string;
  [key: string]: unknown;
}

export interface CommandResponse {
  id: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface SessionInfo {
  id: string;
  status: 'active' | 'idle';
  created_at: string;
  last_used: string;
  pid: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  active_sessions: number;
  max_sessions: number;
  uptime_seconds: number;
}
