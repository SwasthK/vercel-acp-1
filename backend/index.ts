import express from "express";
import { prisma } from "./lib/prisma";
import { getRandomUUID } from "./lib/get-random-uuid";
import { spritesClient } from "./lib/sprites-client";
import type { CreateSessionBody, SessionAgentConfig, SessionConfig } from "./types";
import { normalizeMcpServers } from "./utils";

const NODE_ENV = process.env.NODE_ENV

const app = express();
app.use((req, res, next) => {
  const origin = String(req.headers.origin ?? "");
  const allowedOrigins = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);

  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use(express.json());
const port = 8081;

async function createSpriteHandler(req: express.Request, res: express.Response) {

  const prefix = "vercel-acp-test"

  const uuid = getRandomUUID();
  const name = `${prefix}-${uuid}`;

  const existingSprite = await prisma.sprite.findFirst({
    where: {
      name: name
    }
  });

  if (existingSprite) {
    // Always stream SSE so the UI can show progress consistently.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    res.write(`event: created\n`);
    res.write(`data: ${JSON.stringify({ sprite: existingSprite })}\n\n`);
    res.write(`event: ready\n`);
    res.write(`data: ${JSON.stringify({ sprite: existingSprite, exitCode: 0 })}\n\n`);
    res.end();
    return;
  } else {
    const spritesApiBase =
      process.env.SPRITES_API_BASE_URL ?? "https://api.sprites.dev/v1";
    const spriteRes = await fetch(
      `${spritesApiBase.replace(/\/$/, "")}/sprites`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          url_settings: {
            auth: "sprite",
          },
        }),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SPRITES_TOKEN}`
        }
      }
    );

    if (!spriteRes.ok) {
      const text = await spriteRes.text().catch(() => "");
      return res.status(500).json({ error: text || "Failed to create sprite" });
    }

    const spriteJson = (await spriteRes.json()) as {
      name?: string
      url?: string
    };

    const spriteName = spriteJson.name ?? name;

    const createdSprite = await prisma.sprite.create({
      data: {
        name: spriteName,
        url: spriteJson.url ?? null,
      }
    });

    // Always stream SSE so the UI can show progress consistently.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent("created", { sprite: createdSprite });

    const sprite = spritesClient.sprite(spriteName);

    const script = [
      // Be tolerant of missing optional vars during provisioning.
      "set -eo pipefail",

      // cleanup
      "rm -rf vercel-acp-1",

      // clone
      "git clone https://github.com/SwasthK/vercel-acp-1.git",

      // install globals
      "bun install -g pm2",
      "bun install -g @zed-industries/codex-acp",
      "bun install -g @zed-industries/claude-agent-acp",

      // Use Bun global bin paths directly; don't rely on rc files.
      'BUN_GLOBAL_BIN="$(bun pm bin -g)"',
      'export PATH="$BUN_GLOBAL_BIN:$PATH"',
      'PM2_BIN="$BUN_GLOBAL_BIN/pm2"',
      'test -x "$PM2_BIN" && "$PM2_BIN" -v',
      'command -v codex-acp',

      // avoid printing secrets; just verify the var exists
      'test -n "$OPENAI_API_KEY" && echo "OPENAI_API_KEY=***" || echo "OPENAI_API_KEY missing/empty"',

      // go to server
      "cd vercel-acp-1/server",

      // install deps
      "bun install",

      // start with pm2 (inject OPENAI_API_KEY explicitly)
      `OPENAI_API_KEY="${process.env.OPENAI_API_KEY ?? ""}" PORT=8080 "$PM2_BIN" start index.ts --name vercel-acp-1 --interpreter bun --restart-delay 5000 --max-restarts 10`,

      // save process list + show status
      '"$PM2_BIN" save',
      '"$PM2_BIN" status',
    ].join("\n");

    const cmd = sprite.spawn("bash", ["-lc", script], {
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      },
    });

    const heartbeat = setInterval(() => {
      res.write(`event: ping\ndata: {}\n\n`);
    }, 15000);

    const cleanup = () => clearInterval(heartbeat);

    req.on("close", () => {
      cleanup();
      try {
        cmd.kill("SIGTERM");
      } catch {
        // ignore
      }
    });

    cmd.stdout.on("data", (chunk: Buffer) =>
      writeEvent("stdout", { chunk: chunk.toString("utf8") })
    );
    cmd.stderr.on("data", (chunk: Buffer) =>
      writeEvent("stderr", { chunk: chunk.toString("utf8") })
    );

    cmd.on("error", (err: Error) => {
      writeEvent("error", { message: err.message });
    });

    cmd.on("exit", (code: number) => {
      writeEvent("ready", { sprite: createdSprite, exitCode: code });
      cleanup();
      res.end();
    });

    return;
  }
}

async function listSpritesHandler(req: express.Request, res: express.Response) {
  const sprites = await prisma.sprite.findMany({
    orderBy: { createdAt: "desc" },
  });
  return res.json({ sprites });
}

async function destroySpriteHandler(req: express.Request, res: express.Response) {
  const { spriteId } = req.body;
  const sprite = await prisma.sprite.findUnique({
    where: { id: spriteId },
  });
  if (!sprite) {
    return res.status(404).json({ error: "Sprite not found" });
  }
  await spritesClient.deleteSprite(sprite.name);
  await prisma.sprite.delete({
    where: { id: spriteId },
  });
  return res.json({ message: "Sprite destroyed" });
}

async function createAgentSessionHandler(req: express.Request, res: express.Response) {
  const body = req.body as CreateSessionBody | undefined;
  if (!body || !body.agentCommand) {
    res.status(400).json({ error: "agentCommand_required" });
    return;
  }

  const { spriteId } = req.body as { spriteId?: number };

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

  const sprite =
    typeof spriteId === "number"
      ? await prisma.sprite.findUnique({ where: { id: spriteId } })
      : await prisma.sprite.findFirst({ orderBy: { createdAt: "desc" } });

  if (!sprite?.url) {
    res.status(400).json({ error: "sprite_url_missing" });
    return;
  }

  try {
    const spriteAuthHeaders: Record<string, string> = {};
    if (process.env.SPRITES_TOKEN) {
      spriteAuthHeaders["Authorization"] = `Bearer ${process.env.SPRITES_TOKEN}`;
    }

    const fetchURL = NODE_ENV === "production" ? `${sprite.url.replace(/\/$/, "")}/sessions` : `${process.env.SERVER_URL}/sessions`;

    // The ACP provider requires an explicit authMethodId to authenticate.
    // From sprite logs, OPENAI env-var authMethod id is `openai-api-key`.
    const fallbackAuthMethodId =
      body.authMethodId ?? (process.env.OPENAI_API_KEY ? "openai-api-key" : undefined);

    const upstreamRes = await fetch(fetchURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...spriteAuthHeaders },
      body: JSON.stringify({
        agentCommand: agent.command,
        args: agent.args,
        env: agent.env,
        authMethodId: fallbackAuthMethodId,
        cwd: sessionConfig.cwd,
        mcpServers: body.mcpServers,
      }),
    });

    if (!upstreamRes.ok) {
      res.status(502).json({
        error: await upstreamRes.text(),
        upstreamStatus: upstreamRes.status,
      });
      return;
    }

    const upstreamText = await upstreamRes.text();
    let data: { sessionId: string };
    try {
      data = JSON.parse(upstreamText) as { sessionId: string };
    } catch {
      res.status(502).json({
        error: "upstream_non_json",
        upstreamStatus: upstreamRes.status,
        upstreamBody: upstreamText.slice(0, 500),
      });
      return;
    }

    const saved = await prisma.agentSession.create({
      data: {
        remoteSessionId: data.sessionId,
        spriteId: sprite.id,
        agentCommand: agent.command,
      },
    });

    res.status(201).json({
      id: saved.id,
      sessionId: saved.remoteSessionId,
      spriteId: saved.spriteId,
      spriteUrl: sprite.url,
      createdAt: saved.createdAt,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

async function agentChatStreamProxy(req: express.Request, res: express.Response) {
  const body = req.body as
    | {
      prompt?: string
      spriteId?: number
      spriteName?: string
      agentCommand?: string
    }
    | undefined

  const prompt = body?.prompt?.trim()
  if (!prompt) {
    res.status(400).json({ error: "prompt_required" })
    return
  }

  const agentCommand = body?.agentCommand
  if (!agentCommand) {
    res.status(400).json({ error: "agentCommand_required" })
    return
  }

  const sprite =
    typeof body?.spriteId === "number"
      ? await prisma.sprite.findUnique({ where: { id: body.spriteId } })
      : body?.spriteName
        ? await prisma.sprite.findUnique({ where: { name: body.spriteName } })
        : await prisma.sprite.findFirst({ orderBy: { createdAt: "desc" } })

  if (!sprite?.url) {
    res.status(400).json({ error: "sprite_url_missing" })
    return
  }


  console.log("Sprite found", sprite);

  const spriteAuthHeaders: Record<string, string> = {}
  if (process.env.SPRITES_TOKEN) {
    spriteAuthHeaders["Authorization"] = `Bearer ${process.env.SPRITES_TOKEN}`
  }

  let session = await prisma.agentSession.findFirst({
    where: { spriteId: sprite.id, agentCommand },
    orderBy: { updatedAt: "desc" },
  })

  if (!session) {
    console.log("Creating session");
    const fetchURL =
      NODE_ENV === "production"
        ? `${sprite.url.replace(/\/$/, "")}/sessions`
        : `${process.env.SERVER_URL}/sessions`

    const maxAttempts = 6
    const baseDelayMs = 1000
    let json: { sessionId?: string } | null = null
    const createEnv =
      process.env.OPENAI_API_KEY
        ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
        : undefined

    // The ACP provider requires an explicit authMethodId to authenticate.
    // From sprite logs, OPENAI env-var authMethod id is `openai-api-key`.
    const createAuthMethodId =
      process.env.OPENAI_API_KEY ? "openai-api-key" : undefined


    console.log("Creating session", fetchURL, createEnv, agentCommand);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const createRes = await fetch(fetchURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...spriteAuthHeaders },
        body: JSON.stringify({ agentCommand, env: createEnv, authMethodId: createAuthMethodId }),
      })

      if (createRes.ok) {
        const text = await createRes.text()
        try {
          json = JSON.parse(text) as { sessionId?: string }
        } catch {
          res
            .status(502)
            .json({
              error: "upstream_non_json",
              upstreamBody: text.slice(0, 500),
            })
          return
        }
        break
      }

      const errText = await createRes.text()
      let errJson: any = undefined
      try {
        errJson = JSON.parse(errText)
      } catch {
        errJson = undefined
      }

      const upstreamStatus = createRes.status
      const retryable =
        [502, 503, 504].includes(upstreamStatus) ||
        (upstreamStatus === 500 && errJson?.error === "session_create_failed")

      if (!retryable || attempt === maxAttempts) {
        res
          .status(502)
          .json({ error: errJson ?? errText, upstreamStatus })
        return
      }

      await new Promise((r) => setTimeout(r, baseDelayMs * attempt))
    }

    if (!json?.sessionId) {
      res.status(502).json({ error: "upstream_missing_sessionId" })
      return
    }

    session = await prisma.agentSession.create({
      data: {
        remoteSessionId: json.sessionId,
        spriteId: sprite.id,
        agentCommand,
      },
    })
  } else {
    await prisma.agentSession.update({
      where: { remoteSessionId: session.remoteSessionId },
      data: {},
    })
  }

  console.log("Fetching session");

  const fetchURL = NODE_ENV === "production" ?
    `${sprite.url.replace(/\/$/, "")}/sessions/${session.remoteSessionId}/chat/stream` :
    `${process.env.SERVER_URL}/sessions/${session.remoteSessionId}/chat/stream`;

  const upstream = await fetch(
    fetchURL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...spriteAuthHeaders,
      },
      body: JSON.stringify({ prompt, agentCommand }),
    }
  )

  if (!upstream.ok || !upstream.body) {
    res
      .status(502)
      .json({ error: await upstream.text(), upstreamStatus: upstream.status })
    return
  }

  res.status(200)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders?.()

  const reader = upstream.body.getReader()
  req.on("close", () => {
    try {
      reader.cancel()
    } catch { }
  })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } finally {
    res.end()
  }
}

async function agentSwitchProviderProxy(req: express.Request, res: express.Response) {
  const sessionId = String(req.params.id);
  const body = req.body as CreateSessionBody | undefined;
  if (!body?.agentCommand) {
    res.status(400).json({ error: "agentCommand_required" });
    return;
  }

  const session = await prisma.agentSession.findUnique({
    where: { remoteSessionId: sessionId },
    include: { sprite: true },
  });
  if (!session?.sprite.url) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }

  const upstreamRes = await fetch(
    NODE_ENV === "production" ?
      `${session.sprite.url.replace(/\/$/, "")}/sessions/${session.remoteSessionId}/provider` :
      `${process.env.SERVER_URL}/sessions/${session.remoteSessionId}/provider`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!upstreamRes.ok) {
    res.status(502).json({ error: await upstreamRes.text() });
    return;
  }

  const upstreamJson = await upstreamRes.json().catch(() => ({}));

  await prisma.agentSession.update({
    where: { remoteSessionId: sessionId },
    data: { agentCommand: body.agentCommand },
  });

  res.status(200).json(upstreamJson);
}

app.get("/health", (req, res) => res.status(200).json({ message: "OK from backend" }));
app.post("/sprites/create", createSpriteHandler);
app.get("/sprites/list", listSpritesHandler);
app.post("/sprites/destroy", destroySpriteHandler);

app.post("/agent/sessions", createAgentSessionHandler);
app.post("/agent/sessions/:id/chat/stream", agentChatStreamProxy);
app.post("/agent/sessions/:id/provider", agentSwitchProviderProxy);
app.post("/agent/chat/stream", agentChatStreamProxy);

// As a fallback, we can run the sprite script manually
app.post('/sprites/run', async (req, res) => {
  const { spriteName } = req.body;

  if (!spriteName || typeof spriteName !== "string") {
    return res.status(400).json({ error: "spriteName is required" });
  }

  const sprite = spritesClient.sprite(spriteName);

  const script = [
    "set -eo pipefail",
    "rm -rf test-repo",
    "git clone https://github.com/SwasthK/vercel-acp-1.git",
    "bun install -g pm2",
    "bun install -g @zed-industries/codex-acp",
    "bun install -g @zed-industries/claude-agent-acp",

    'BUN_GLOBAL_BIN="$(bun pm bin -g)"',
    'export PATH="$BUN_GLOBAL_BIN:$PATH"',
    'PM2_BIN="$BUN_GLOBAL_BIN/pm2"',
    'test -x "$PM2_BIN" && "$PM2_BIN" -v',

    "cd vercel-acp-1/server",
    "bun install",
    `OPENAI_API_KEY="${process.env.OPENAI_API_KEY ?? ""}" PORT=8080 "$PM2_BIN" start index.ts --name vercel-acp-1 --interpreter bun --restart-delay 5000 --max-restarts 10`,
    '"$PM2_BIN" save',
    '"$PM2_BIN" status',
  ].join("\n");

  try {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent("start", { spriteName });

    const cmd = sprite.spawn("bash", ["-lc", script], {
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      },
    });

    const heartbeat = setInterval(() => {
      res.write(`event: ping\ndata: {}\n\n`);
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
    };

    req.on("close", () => {
      cleanup();
      try {
        cmd.kill("SIGTERM");
      } catch {
        // ignore
      }
    });

    cmd.stdout.on("data", (chunk: Buffer) => writeEvent("stdout", { chunk: chunk.toString("utf8") }));
    cmd.stderr.on("data", (chunk: Buffer) => writeEvent("stderr", { chunk: chunk.toString("utf8") }));

    cmd.on("error", (err: Error) => {
      writeEvent("error", { message: err.message });
    });

    cmd.on("exit", (code: number) => {
      writeEvent("exit", { exitCode: code });
      cleanup();
      res.end();
    });

    return;

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Listening on port ${port}...`);
});