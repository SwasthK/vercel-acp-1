import express from "express";
import {
  ACPProvider,
  createACPProvider,
  type ACPProviderSettings,
} from "@mcpc-tech/acp-ai-provider";
import { streamText } from "ai";
import type { Request, Response } from "express";

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

const sessions = new Map<string, SessionEntry>();

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
    env: agent.env,
    authMethodId: agent.authMethodId,
    session: sessionConfig,
    persistSession: true,
    sessionDelayMs: 1000,
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
    acpSessionId: acpSession.sessionId,
    availableModels: models,
    availableModes: modes,
    currentModel: models[0],
    currentMode: modes[0],
  };

  return entry;
}

function getSessionOr404(id: string, res: Response): SessionEntry | undefined {
  const entry = sessions.get(id);
  if (!entry) {
    res.status(404).json({ error: "session_not_found" });
    return undefined;
  }
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
    authMethodId: body.authMethodId,
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
      mcpServers: entry.sessionConfig.mcpServers,
    });
  } catch (error) {
    console.error("Failed to create ACP session", error);
    res.status(500).json({ error: "session_create_failed" });
  }
});

app.get("/sessions", (_req, res) => {
  const list = Array.from(sessions.values()).map((s) => ({
    sessionId: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    models: s.availableModels,
    modes: s.availableModes,
  }));
  res.status(200).json({ sessions: list });
});

app.get("/sessions/:id", (req, res) => {
  const entry = getSessionOr404(req.params.id, res);
  if (!entry) return;

  res.status(200).json({
    sessionId: entry.id,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    agent: entry.agent,
    models: entry.availableModels,
    modes: entry.availableModes,
    currentModel: entry.currentModel,
    currentMode: entry.currentMode,
    mcpServers: entry.sessionConfig.mcpServers,
  });
});

app.delete("/sessions/:id", (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }

  try {
    entry.provider.cleanup();
  } catch (error) {
    console.error("Error cleaning up provider", error);
  }

  sessions.delete(req.params.id);
  res.status(204).send();
});

// Update provider for an existing session
app.post("/sessions/:id/provider", async (req, res) => {
  const entry = getSessionOr404(req.params.id, res);
  if (!entry) return;

  const body = req.body as CreateSessionBody | undefined;
  if (!body || !body.agentCommand) {
    res.status(400).json({ error: "agentCommand_required" });
    return;
  }

  const agent: SessionAgentConfig = {
    command: body.agentCommand,
    args: body.args,
    env: body.env,
    authMethodId: body.authMethodId,
  };

  try {
    entry.provider.cleanup();
  } catch (error) {
    console.error("Error cleaning up old provider", error);
  }

  try {
    const updated = await initACPProvider(agent, entry.sessionConfig);
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

// Model / mode selection
app.post("/sessions/:id/model", (req, res) => {
  const entry = getSessionOr404(req.params.id, res);
  if (!entry) return;

  const body = req.body as SetModelBody | undefined;
  if (!body) {
    res.status(400).json({ error: "body_required" });
    return;
  }

  if (body.modelId && entry.availableModels && !entry.availableModels.includes(body.modelId)) {
    res.status(400).json({ error: "invalid_model" });
    return;
  }

  if (body.modeId && entry.availableModes && !entry.availableModes.includes(body.modeId)) {
    res.status(400).json({ error: "invalid_mode" });
    return;
  }

  entry.currentModel = body.modelId ?? entry.currentModel;
  entry.currentMode = body.modeId ?? entry.currentMode;
  entry.updatedAt = Date.now();

  res.status(200).json({
    sessionId: entry.id,
    currentModel: entry.currentModel,
    currentMode: entry.currentMode,
  });
});

// MCP configuration
app.get("/sessions/:id/mcp", (req, res) => {
  const entry = getSessionOr404(req.params.id, res);
  if (!entry) return;

  res.status(200).json({ mcpServers: entry.sessionConfig.mcpServers });
});

app.post("/sessions/:id/mcp", async (req, res) => {
  const entry = getSessionOr404(req.params.id, res);
  if (!entry) return;

  const body = req.body as { mcpServers?: McpServerInput[] } | undefined;
  if (!body || !Array.isArray(body.mcpServers)) {
    res.status(400).json({ error: "mcpServers_required" });
    return;
  }

  entry.sessionConfig.mcpServers = normalizeMcpServers(body.mcpServers);

  try {
    entry.provider.cleanup();
  } catch (error) {
    console.error("Error cleaning up provider for MCP update", error);
  }

  try {
    const updated = await initACPProvider(entry.agent, entry.sessionConfig);
    const merged: SessionEntry = {
      ...updated,
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: Date.now(),
    };
    sessions.set(entry.id, merged);

    res.status(200).json({
      sessionId: merged.id,
      mcpServers: merged.sessionConfig.mcpServers,
      models: merged.availableModels,
      modes: merged.availableModes,
    });
  } catch (error) {
    console.error("Failed to update MCP config", error);
    res.status(500).json({ error: "mcp_update_failed" });
  }
});

// SSE chat streaming
app.post("/sessions/:id/chat/stream", async (req, res) => {
  const entry = getSessionOr404(req.params.id, res);
  if (!entry) return;

  const body = req.body as ChatStreamBody | undefined;
  if (!body || !body.prompt) {
    res.status(400).json({ error: "prompt_required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.flushHeaders?.();

  const model = entry.provider.languageModel(
    entry.currentModel,
    entry.currentMode
  );

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
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: "stream_failed" })}\n\n`);
    } finally {
      res.end();
    }
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Listening on port ${port}...`);
});