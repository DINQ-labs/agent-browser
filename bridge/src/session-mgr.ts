import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { CreateSessionRequest, SessionInfo, CommandRequest, CommandResponse } from './types.js';

const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_SESSION_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_DAEMON_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return !['0', 'false', 'no', ''].includes(normalized);
}

function isValidSessionId(sessionId: string): boolean {
  // Avoid path traversal and weird socket filenames.
  return /^[a-zA-Z0-9_-]{1,64}$/.test(sessionId);
}

function getSocketDir(): string {
  // Isolate the bridge's daemons by default so we don't collide with user sessions.
  // Still allow override via AGENT_BROWSER_SOCKET_DIR (same env var the daemon uses).
  return (
    process.env.AGENT_BROWSER_SOCKET_DIR ||
    path.join(os.tmpdir(), `agent-browser-bridge-${process.pid}`)
  );
}

function getSocketPath(socketDir: string, sessionId: string): string {
  return path.join(socketDir, `${sessionId}.sock`);
}

function buildProxyUrl(proxy: NonNullable<CreateSessionRequest['proxy']>): string {
  // agent-browser expects a single proxy URL string. If username/password are provided,
  // embed them into the URL when possible.
  const raw = proxy.server;
  try {
    const url = new URL(raw);
    if (proxy.username) url.username = proxy.username;
    if (proxy.password) url.password = proxy.password;
    return url.toString();
  } catch {
    // If parsing fails, fall back to the raw string (may already include creds).
    return raw;
  }
}

interface ManagedSession {
  id: string;
  pid: number;
  process: ChildProcess;
  createdAt: Date;
  lastUsed: Date;
  socketDir: string;
  socketPath: string;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly socketDir: string;
  private readonly maxSessions: number;
  private readonly sessionTimeoutMs: number;
  private readonly daemonStartupTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(options?: {
    socketDir?: string;
    maxSessions?: number;
    sessionTimeoutSeconds?: number;
    daemonStartupTimeoutMs?: number;
    commandTimeoutMs?: number;
  }) {
    this.socketDir = options?.socketDir ?? getSocketDir();
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.sessionTimeoutMs =
      (options?.sessionTimeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_SECONDS) * 1000;
    this.daemonStartupTimeoutMs =
      options?.daemonStartupTimeoutMs ?? DEFAULT_DAEMON_STARTUP_TIMEOUT_MS;
    this.commandTimeoutMs = options?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

    fs.mkdirSync(this.socketDir, { recursive: true });
  }

  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30_000);
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;

    for (const sessionId of Array.from(this.sessions.keys())) {
      void this.closeSession(sessionId);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  get maxSessionsLimit(): number {
    return this.maxSessions;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      status: 'active',
      created_at: s.createdAt.toISOString(),
      last_used: s.lastUsed.toISOString(),
      pid: s.pid,
    }));
  }

  async createSession(req: CreateSessionRequest): Promise<void> {
    const sessionId = req.session;
    if (!sessionId) {
      throw new Error('session is required');
    }
    if (!isValidSessionId(sessionId)) {
      throw new Error('Invalid session id (allowed: [a-zA-Z0-9_-], max 64 chars)');
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session '${sessionId}' already exists`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Max sessions (${this.maxSessions}) reached`);
    }

    const socketPath = getSocketPath(this.socketDir, sessionId);
    const pidPath = path.join(this.socketDir, `${sessionId}.pid`);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // ignore
    }

    const daemonPath = fileURLToPath(new URL('../../dist/daemon.js', import.meta.url));

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENT_BROWSER_SESSION: sessionId,
      AGENT_BROWSER_SOCKET_DIR: this.socketDir,
    };

    if (req.headless === false) {
      env.AGENT_BROWSER_HEADED = '1';
    } else {
      delete env.AGENT_BROWSER_HEADED;
    }

    if (req.userAgent) {
      env.AGENT_BROWSER_USER_AGENT = req.userAgent;
    }

    if (req.proxy) {
      env.AGENT_BROWSER_PROXY = buildProxyUrl(req.proxy);
      if (req.proxy.bypass) {
        env.AGENT_BROWSER_PROXY_BYPASS = req.proxy.bypass;
      }
    }

    const child = spawn('node', [daemonPath], {
      env,
      stdio: 'inherit',
      detached: false,
    });

    if (!child.pid) {
      throw new Error('Failed to start daemon: missing pid');
    }

    child.once('exit', () => {
      this.sessions.delete(sessionId);
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(pidPath);
      } catch {
        // ignore
      }
    });

    await this.waitForSocket(socketPath, this.daemonStartupTimeoutMs);

    const managed: ManagedSession = {
      id: sessionId,
      pid: child.pid,
      process: child,
      createdAt: new Date(),
      lastUsed: new Date(),
      socketDir: this.socketDir,
      socketPath,
    };

    this.sessions.set(sessionId, managed);

    // Apply post-launch configuration. These commands will auto-launch the browser on first use.
    if (req.headers) {
      await this.sendCommand(sessionId, { action: 'headers', headers: req.headers });
    }
    if (req.viewport) {
      await this.sendCommand(sessionId, {
        action: 'viewport',
        width: req.viewport.width,
        height: req.viewport.height,
      });
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await this.sendCommand(sessionId, { action: 'close' });
    } catch {
      // ignore and force-kill below
    }

    await this.waitForExit(session.process, 2_000).catch(() => {});
    if (!session.process.killed) {
      session.process.kill('SIGKILL');
    }
    this.sessions.delete(sessionId);
  }

  async sendCommand(sessionId: string, command: CommandRequest): Promise<CommandResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const cmd: CommandRequest = { ...command };
    if (!cmd.id) {
      cmd.id = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    session.lastUsed = new Date();
    const resp = await this.sendToSocket(session.socketPath, cmd, this.commandTimeoutMs);
    return resp;
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(socketPath)) {
        try {
          await this.tryConnect(socketPath);
          return;
        } catch {
          // not ready yet
        }
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for daemon socket: ${socketPath}`);
  }

  private async tryConnect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connect timeout'));
      }, 250);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async sendToSocket(
    socketPath: string,
    command: CommandRequest,
    timeoutMs: number
  ): Promise<CommandResponse> {
    return await new Promise<CommandResponse>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Command timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;

        const line = buffer.slice(0, idx);
        clearTimeout(timer);
        socket.end();
        try {
          const parsed = JSON.parse(line) as CommandResponse;
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });

      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket.once('connect', () => {
        const payload = JSON.stringify(command) + '\n';
        socket.write(payload);
      });
    });
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed.getTime() < this.sessionTimeoutMs) continue;
      void this.closeSession(id);
    }
  }
}

