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
  sessionConfig: SessionConfig,
  existingSessionId?: string
): Promise<SessionEntry> {
  const provider = createACPProvider({
    command: agent.command,
    args: agent.args ?? [],
    env: agent.env,
    authMethodId: agent.authMethodId,
    session: sessionConfig,
    persistSession: true,
    sessionDelayMs: 1000,
    existingSessionId,
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
    res.status(201).json({
      sessionId: entry.id,
      createdAt: entry.createdAt,
    });
  } catch (error) {
    console.error("Failed to create ACP session", error);
    res.status(500).json({
      error: "session_create_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// Update provider for an existing session
app.post("/sessions/:id/provider", async (req, res) => {
  const existingSessionId = req.params.id;

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
    const updated = await initACPProvider(agent, sessionConfig, existingSessionId);
    res.status(200).json({
      sessionId: updated.id,
      models: updated.availableModels,
      modes: updated.availableModes,
      agent: updated.agent,
    });
  } catch (error) {
    console.error("Failed to update provider", error);
    res.status(500).json({ error: "provider_update_failed" });
  }
});

// SSE chat streaming
app.post("/sessions/:id/chat/stream", async (req, res) => {
  const existingSessionId = req.params.id;
  const body = req.body as (ChatStreamBody & { agentCommand?: string }) | undefined;
  if (!body || !body.prompt || !body.agentCommand) {
    res.status(400).json({ error: "prompt_required" });
    return;
  }

  console.log("Chat streaming", body);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.flushHeaders?.();

  const agent: SessionAgentConfig = { command: body.agentCommand };
  const sessionConfig: SessionConfig = { cwd: process.cwd(), mcpServers: [] };
  const entry = await initACPProvider(agent, sessionConfig, existingSessionId);
  const model = entry.provider.languageModel(entry.currentModel, entry.currentMode);

  try {
    const { fullStream } = streamText({
      model,
      prompt: body.prompt,
      tools: entry.provider.tools,
      includeRawChunks: true,
    });

    console.log("Full stream", fullStream);

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