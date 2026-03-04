import express from 'express';
import type { Request, Response } from 'express';
import { SessionManager } from './session-mgr.js';
import type { CreateSessionRequest, CommandRequest, HealthResponse } from './types.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const PORT = parseInt(process.env.BRIDGE_PORT || process.env.PORT || '3000', 10);
const app = express();
app.use(express.json({ limit: '10mb' }));

const manager = new SessionManager();
const startTime = Date.now();

// --- Health ---
app.get('/health', (_req: Request, res: Response) => {
  const resp: HealthResponse = {
    status: 'ok',
    active_sessions: manager.activeCount,
    max_sessions: manager.maxSessionsLimit,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
  };
  res.json(resp);
});

// --- Sessions ---
app.get('/sessions', (_req: Request, res: Response) => {
  res.json(manager.listSessions());
});

app.post('/sessions', async (req: Request, res: Response) => {
  try {
    const body = req.body as CreateSessionRequest;
    if (!body.session) {
      res.status(400).json({ error: 'session is required' });
      return;
    }
    await manager.createSession(body);
    res.status(201).json({
      session: body.session,
      status: 'created',
      created_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already exists')
      ? 409
      : message.includes('Max sessions')
        ? 429
        : message.includes('Invalid session')
          ? 400
          : 500;
    res.status(status).json({ error: message });
  }
});

app.delete('/sessions/:id', async (req: Request, res: Response) => {
  try {
    await manager.closeSession(req.params.id);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// --- Commands ---
app.post('/sessions/:id/commands', async (req: Request, res: Response) => {
  try {
    const command = req.body as CommandRequest;
    if (!command.action) {
      res.status(400).json({ error: 'action is required' });
      return;
    }

    // Remote-friendly screenshots: the daemon writes to a file path, which is not accessible
    // to the HTTP caller. When `encoding: "base64"` is requested, write to a temp file,
    // read it back, and return the bytes inline.
    if (command.action === 'screenshot' && command.encoding === 'base64') {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-browser-bridge-shot-'));
      try {
        const format = typeof command.format === 'string' ? command.format : 'png';
        const ext = format === 'jpeg' ? 'jpg' : format;
        const screenshotPath = path.join(tempDir, `screenshot.${ext}`);

        const cmdToSend: CommandRequest = { ...command, path: screenshotPath };
        delete (cmdToSend as Record<string, unknown>).encoding;

        const result = await manager.sendCommand(req.params.id, cmdToSend);
        if (!result.success) {
          res.json(result);
          return;
        }

        const bytes = await fs.readFile(screenshotPath);
        const data = { ...(result.data || {}) } as Record<string, unknown>;
        delete data.path;
        data.screenshot = bytes.toString('base64');

        res.json({ ...result, data });
        return;
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }

    const result = await manager.sendCommand(req.params.id, command);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

// --- Cookies ---
app.post('/sessions/:id/cookies', async (req: Request, res: Response) => {
  try {
    const result = await manager.sendCommand(req.params.id, {
      action: 'cookies_set',
      cookies: req.body.cookies,
    } as CommandRequest);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/sessions/:id/cookies', async (req: Request, res: Response) => {
  try {
    const urlsRaw = req.query.urls;
    const urls =
      typeof urlsRaw === 'string'
        ? urlsRaw.split(',').map((u) => u.trim()).filter(Boolean)
        : undefined;
    const result = await manager.sendCommand(req.params.id, {
      action: 'cookies_get',
      ...(urls && { urls }),
    } as CommandRequest);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// --- State (storageState export) ---
app.get('/sessions/:id/state', async (req: Request, res: Response) => {
  try {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-browser-bridge-state-'));
    const statePath = path.join(tempDir, `${req.params.id}.json`);

    await manager.sendCommand(req.params.id, {
      action: 'state_save',
      path: statePath,
    } as CommandRequest);

    const content = await fs.readFile(statePath, 'utf8');
    let parsed: unknown = content;
    try {
      parsed = JSON.parse(content);
    } catch {
      // leave as string
    }

    await fs.rm(tempDir, { recursive: true, force: true });

    res.json({
      success: true,
      data: {
        state: parsed,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// --- Start ---
manager.start();

const server = app.listen(PORT, () => {
  console.log(`[bridge] agent-browser HTTP bridge listening on :${PORT}`);
  console.log(`[bridge] max_sessions=${manager.maxSessionsLimit}`);
});

// --- Graceful Shutdown ---
function shutdown(signal: string) {
  console.log(`[bridge] ${signal} received, shutting down...`);
  manager.stop();
  server.close(() => {
    console.log('[bridge] Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
