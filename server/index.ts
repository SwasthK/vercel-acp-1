import express from "express";
import {
  ACPProvider,
  createACPProvider,
  type ACPProviderSettings,
} from "@mcpc-tech/acp-ai-provider";
import { streamText } from "ai";
import type { Request, Response } from "express";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type SessionNotification,
  type Client,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";

// Basic CORS to allow custom UIs from other origins
function corsMiddleware(req: Request, res: Response, next: () => void) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
}

type SessionAgentConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  authMethodId?: string;
};

type SessionConfig = {
  cwd: string;
  mcpServers: ACPProviderSettings["session"]["mcpServers"];
};

type McpServerInput =
  | {
      type: "stdio";
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http" | "sse";
      name: string;
      url: string;
      headers?: Record<string, string>;
    };

type SessionEntry = {
  id: string;
  provider: ACPProvider;
  createdAt: number;
  updatedAt: number;
  agent: SessionAgentConfig;
  sessionConfig: SessionConfig;
  acpSessionId?: string;
  availableModels?: string[];
  availableModes?: string[];
  currentModel?: string;
  currentMode?: string;
};

type CreateSessionBody = {
  agentCommand: string;
  args?: string[];
  env?: Record<string, string>;
  authMethodId?: string;
  cwd?: string;
  mcpServers?: McpServerInput[];
};

type SetModelBody = {
  modelId?: string;
  modeId?: string;
};

type ChatStreamBody = {
  prompt: string;
};

// Fast + reliable: keep ACP providers in memory.
// Codex `existingSessionId` resume is currently failing with -32002, so we avoid it.
const sessions = new Map<string, SessionEntry>();

function getSessionOr404(id: string, res: Response): SessionEntry | undefined {
  const entry = sessions.get(id);
  if (!entry) {
    res.status(404).json({ error: "session_not_found" });
    return undefined;
  }
  return entry;
}

function normalizeMcpServers(
  input: McpServerInput[] | undefined
): SessionConfig["mcpServers"] {
  if (!input || input.length === 0) return [];

  return input.map((s) => {
    if (s.type === "stdio") {
      return {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: Object.entries(s.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      };
    }

    return {
      type: s.type,
      name: s.name,
      url: s.url,
      headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    };
  });
}

async function initACPProvider(
  agent: SessionAgentConfig,
  sessionConfig: SessionConfig
): Promise<SessionEntry> {
  const provider = createACPProvider({
    command: agent.command,
    args: agent.args ?? [],
    env: {
      ...agent.env,
      ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    },
    authMethodId: agent.authMethodId,
    session: sessionConfig,
    persistSession: true,
    sessionDelayMs: 1000
  });

  const acpSession = await provider.initSession();
  const id = acpSession.sessionId;
  const createdAt = Date.now();

  const models =
    acpSession.models?.availableModels?.map((m: any) => m.modelId ?? m.id) ??
    [];
  const modes =
    acpSession.modes?.availableModes?.map((m: any) => m.modeId ?? m.id) ?? [];

  const entry: SessionEntry = {
    id,
    provider,
    createdAt,
    updatedAt: createdAt,
    agent,
    sessionConfig,
    acpSessionId: id,
    availableModels: models,
    availableModes: modes,
    currentModel: models[0],
    currentMode: modes[0],
  };

  return entry;
}

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 8080;

app.use(express.json());
app.use(corsMiddleware);

app.get("/health", (_req, res) => {
  res.status(200).json({ message: "OK" });
});

// Session CRUD
app.post("/sessions", async (req, res) => {
  const body = req.body as CreateSessionBody | undefined;
  if (!body || !body.agentCommand) {
    res.status(400).json({ error: "agentCommand_required" });
    return;
  }

  const agent: SessionAgentConfig = {
    command: body.agentCommand,
    args: body.args,
    env: body.env,
    authMethodId:
      body.authMethodId ??
      (process.env.OPENAI_API_KEY ? "openai-api-key" : undefined),
  };

  const sessionConfig: SessionConfig = {
    cwd: body.cwd ?? process.cwd(),
    mcpServers: normalizeMcpServers(body.mcpServers),
  };

  try {
    const entry = await initACPProvider(agent, sessionConfig);
    sessions.set(entry.id, entry);
    res.status(201).json({
      sessionId: entry.id,
      createdAt: entry.createdAt,
      models: entry.availableModels,
      modes: entry.availableModes,
    });
  } catch (error) {
    console.error("Failed to create ACP session", error);
    const err: unknown = error;
    const safeStringify = (v: unknown) => {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };

    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : // Many libraries throw plain objects; preserve their contents.
            safeStringify(err);

    res.status(500).json({
      error: "session_create_failed",
      message,
      details: safeStringify(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
});

// Update provider for an existing session
app.post("/sessions/:id/provider", async (req, res) => {
  const id = req.params.id;

  const body = req.body as (CreateSessionBody & { authMethodId?: string }) | undefined;
  if (!body || !body.agentCommand) {
    res.status(400).json({ error: "agentCommand_required" });
    return;
  }

  const entry = getSessionOr404(id, res);
  if (!entry) return;

  const agent: SessionAgentConfig = {
    command: body.agentCommand,
    args: body.args,
    env: body.env,
    // Default required for ACP authMethods, if not provided.
    authMethodId:
      body.authMethodId ??
      (process.env.OPENAI_API_KEY ? "openai-api-key" : undefined),
  };
  const sessionConfig: SessionConfig = {
    cwd: body.cwd ?? process.cwd(),
    mcpServers: normalizeMcpServers(body.mcpServers),
  };

  try {
    try {
      entry.provider.cleanup();
    } catch {}

    const updated = await initACPProvider(agent, sessionConfig);
    const merged: SessionEntry = {
      ...updated,
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: Date.now(),
    };
    sessions.set(entry.id, merged);

    res.status(200).json({
      sessionId: merged.id,
      models: merged.availableModels,
      modes: merged.availableModes,
      agent: merged.agent,
    });
  } catch (error) {
    console.error("Failed to update provider", error);
    res.status(500).json({ error: "provider_update_failed" });
  }
});

class HistoryClient implements Client {
  private onSessionUpdate?: (n: SessionNotification) => void;
  setSessionUpdateHandler(handler: (notification: SessionNotification) => void) {
    this.onSessionUpdate = handler;
  }
  sessionUpdate(params: SessionNotification): Promise<void> {
    this.onSessionUpdate?.(params);
    return Promise.resolve();
  }
  requestPermission(): any {
    return Promise.resolve({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  }
  writeTextFile(): any {
    throw new Error("Not implemented");
  }
  readTextFile(): any {
    throw new Error("Not implemented");
  }
}

// Fetch conversation by asking the agent to replay history via ACP `session/load`.
// This does NOT rely on our in-memory transcript.
app.get("/sessions/:id/history", async (req, res) => {
  const sessionId = req.params.id;
  const agentCommand = String(req.query.agentCommand ?? "").trim();
  if (!agentCommand) {
    res.status(400).json({ error: "agentCommand_required" });
    return;
  }

  const cwd = String(req.query.cwd ?? process.cwd());
  const authMethodId =
    String(req.query.authMethodId ?? "").trim() ||
    (process.env.OPENAI_API_KEY ? "openai-api-key" : "");

  const updates: SessionNotification[] = [];

  const child = spawn(agentCommand, [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    },
  });

  try {
    if (!child.stdout || !child.stdin) {
      res.status(500).json({ error: "spawn_failed" });
      return;
    }

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;

    const client = new HistoryClient();
    client.setSessionUpdateHandler((n) => updates.push(n));

    const conn = new ClientSideConnection(() => client, ndJsonStream(input, output));
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    // If auth method is available, try to authenticate proactively.
    if (authMethodId) {
      try {
        await conn.authenticate({ methodId: authMethodId });
      } catch {
        // ignore; many agents do lazy auth
      }
    }

    await conn.loadSession({ sessionId, cwd, mcpServers: [] });

    // Small delay to allow any trailing replay notifications to flush.
    await new Promise((r) => setTimeout(r, 250));

    res.status(200).json({ sessionId, updates });
  } catch (e) {
    const err: unknown = e;
    const safeStringify = (v: unknown) => {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };
    res.status(502).json({
      error: "history_load_failed",
      message: err instanceof Error ? err.message : safeStringify(err),
      details: safeStringify(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    try {
      child.kill();
    } catch {}
  }
});

// SSE chat streaming
app.post("/sessions/:id/chat/stream", async (req, res) => {
  const id = req.params.id;
  const body = req.body as
    | (ChatStreamBody & { agentCommand?: string })
    | undefined;
  if (!body || !body.prompt) {
    res.status(400).json({ error: "prompt_required" });
    return;
  }

  const entry = getSessionOr404(id, res);
  if (!entry) return;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.flushHeaders?.();

  const model = entry.provider.languageModel(entry.currentModel, entry.currentMode);

  try {
    const { fullStream } = streamText({
      model,
      prompt: body.prompt,
      tools: entry.provider.tools,
      includeRawChunks: true,
    });

    for await (const part of fullStream) {
      if (part.type === "text-delta") {
        const payload = { text: part.text };
        res.write(`event: token\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } else if (part.type === "raw" && part.rawValue) {
        let data: unknown;
        try {
          data = JSON.parse(part.rawValue as string);
        } catch {
          data = part.rawValue;
        }
        res.write(`event: raw\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    }

    res.write(`event: done\n`);
    res.write(`data: {}\n\n`);
    res.end();
  } catch (error) {
    console.error("Error during chat stream", error);
    const err: unknown = error;
    const safeStringify = (v: unknown) => {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };
    const errStr = safeStringify(err);
    // Ensure the real error is visible in PM2 logs (plain objects otherwise show as [object Object]).
    console.error("Error during chat stream (safe)", errStr);
    try {
      res.write(`event: error\n`);
      res.write(
        `data: ${JSON.stringify({
          error: "stream_failed",
          details: errStr,
        })}\n\n`
      );
    } finally {
      res.end();
    }
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Listening on port ${port}...`);
});