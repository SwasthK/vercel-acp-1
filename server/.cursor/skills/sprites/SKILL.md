---
name: Sprites
description: Stateful sandbox environments with checkpoint & restore
---

# @fly/sprites

Sprites is a JavaScript/TypeScript SDK for remote command execution on Fly.io's Sprites platform. It provides an API that mirrors Node.js `child_process`, enabling developers to spawn processes, execute commands, and stream output from remote sprite instances. The SDK supports both event-based (spawn) and promise-based (exec) APIs, along with advanced features like TTY mode, detachable sessions, port proxying, and checkpoint/restore capabilities.

The SDK offers comprehensive sprite lifecycle management including creation, deletion, and upgrades. Additional features include filesystem operations (read, write, mkdir, etc.), service management for long-running processes, network policy configuration, and port forwarding. All operations are authenticated via bearer tokens and communicate with the Sprites API over HTTP/WebSocket connections.

## SpritesClient - Main Client for Sprites API

The SpritesClient is the primary entry point for interacting with the Sprites API. It handles authentication, sprite management operations, and provides access to individual sprite instances. The client supports configuration options for custom base URLs, request timeouts, and control mode for multiplexed WebSocket operations.

```typescript
import { SpritesClient } from '@fly/sprites';

// Initialize client with authentication token
const client = new SpritesClient(process.env.SPRITES_TOKEN!, {
  baseURL: 'https://api.sprites.dev',  // optional, this is the default
  timeout: 30000,                       // optional, request timeout in ms
  controlMode: false,                   // optional, enable multiplexed operations
});

// Get a sprite handle (doesn't create on server)
const sprite = client.sprite('my-sprite');

// Create a new sprite with custom configuration
const newSprite = await client.createSprite('production-sprite', {
  ramMB: 512,
  cpus: 1,
  region: 'ord',
  storageGB: 10,
});
console.log(`Created sprite: ${newSprite.name}`);

// Get sprite information
const spriteInfo = await client.getSprite('my-sprite');
console.log(`Status: ${spriteInfo.status}, Region: ${spriteInfo.primaryRegion}`);

// List sprites with pagination
const spriteList = await client.listSprites({
  prefix: 'prod-',
  maxResults: 50,
});
console.log(`Found ${spriteList.sprites.length} sprites, hasMore: ${spriteList.hasMore}`);

// List all sprites (handles pagination automatically)
const allSprites = await client.listAllSprites('test-');
console.log(`Total sprites: ${allSprites.length}`);

// Delete a sprite
await client.deleteSprite('old-sprite');

// Upgrade a sprite to latest version
await client.upgradeSprite('my-sprite');

// Create access token from Fly.io macaroon
const token = await SpritesClient.createToken(
  flyMacaroonToken,
  'my-org-slug',
  'optional-invite-code'
);
```

## Command Execution - spawn (Event-based API)

The spawn method provides an event-based API for command execution that mirrors Node.js `child_process.spawn()`. It returns a SpriteCommand object with stdin, stdout, and stderr streams, allowing for real-time streaming of command output and interactive input. This is ideal for long-running processes or when you need fine-grained control over I/O streams.

```typescript
import { SpritesClient } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Basic streaming command execution
const cmd = sprite.spawn('ls', ['-la', '/app']);

// Stream stdout to console
cmd.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk);
});

// Stream stderr to console
cmd.stderr.on('data', (chunk: Buffer) => {
  process.stderr.write(chunk);
});

// Handle exit
cmd.on('exit', (code: number) => {
  console.log(`\nProcess exited with code: ${code}`);
});

// Handle errors
cmd.on('error', (err: Error) => {
  console.error('Command error:', err.message);
});

// Wait for completion and get exit code
const exitCode = await cmd.wait();

// Interactive process with stdin
const interactiveCmd = sprite.spawn('python', ['-i']);
interactiveCmd.stdin.write('print("Hello from Python!")\n');
interactiveCmd.stdin.write('exit()\n');
interactiveCmd.stdout.pipe(process.stdout);
await interactiveCmd.wait();

// Pipe streams directly
const pipeCmd = sprite.spawn('cat', ['/etc/passwd']);
pipeCmd.stdout.pipe(process.stdout);
pipeCmd.stderr.pipe(process.stderr);
await pipeCmd.wait();

// Kill a running command
const longRunning = sprite.spawn('sleep', ['3600']);
setTimeout(() => {
  longRunning.kill('SIGTERM');  // or 'SIGKILL', 'SIGHUP', etc.
}, 5000);
await longRunning.wait();
```

## Command Execution - exec/execFile (Promise-based API)

The exec and execFile methods provide promise-based command execution that captures output and returns it when the command completes. The exec method parses a command string, while execFile takes the command and arguments separately. Both throw ExecError if the command exits with a non-zero code, providing access to stdout, stderr, and exit code.

```typescript
import { SpritesClient, ExecError } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Simple command execution with exec (parses command string)
const { stdout, stderr, exitCode } = await sprite.exec('echo "Hello World"');
console.log(stdout);  // 'Hello World\n'

// Execute with arguments using execFile
const result = await sprite.execFile('python', ['-c', 'print(2 + 2)']);
console.log(result.stdout);  // '4\n'

// Execute with environment variables and working directory
const envResult = await sprite.exec('echo $MY_VAR', {
  cwd: '/app',
  env: {
    MY_VAR: 'custom-value',
    PATH: '/usr/bin:/bin',
  },
});
console.log(envResult.stdout);  // 'custom-value\n'

// Handle command failures with ExecError
try {
  await sprite.exec('exit 1');
} catch (error) {
  if (error instanceof ExecError) {
    console.log('Exit code:', error.exitCode);
    console.log('Stdout:', error.stdout);
    console.log('Stderr:', error.stderr);
  }
}

// Set maximum buffer size for large outputs
const largeOutput = await sprite.exec('cat /large/file.txt', {
  maxBuffer: 50 * 1024 * 1024,  // 50MB (default is 10MB)
});

// Get output as Buffer instead of string
const binaryResult = await sprite.execFile('cat', ['/bin/ls'], {
  encoding: 'buffer' as any,
});
console.log(binaryResult.stdout);  // <Buffer ...>
```

## TTY Mode - Interactive Terminal Sessions

TTY mode enables interactive terminal sessions with pseudo-terminal support. This is essential for running interactive programs like shells, text editors, or any command that requires terminal input/output. TTY mode supports terminal resizing and can be combined with detachable sessions for persistent terminal access.

```typescript
import { SpritesClient } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Start an interactive bash session with TTY
const bash = sprite.spawn('bash', [], {
  tty: true,
  rows: 24,
  cols: 80,
});

// Connect local terminal to remote shell
process.stdin.setRawMode(true);
process.stdin.pipe(bash.stdin);
bash.stdout.pipe(process.stdout);

// Handle terminal resize events
process.stdout.on('resize', () => {
  const { columns, rows } = process.stdout;
  bash.resize(columns, rows);
});

// Handle exit
bash.on('exit', (code) => {
  process.stdin.setRawMode(false);
  console.log(`Shell exited with code ${code}`);
  process.exit(code);
});

// Run an interactive Python REPL
const python = sprite.spawn('python', [], {
  tty: true,
  rows: 30,
  cols: 120,
});
process.stdin.pipe(python.stdin);
python.stdout.pipe(process.stdout);
await python.wait();

// Run vim or other full-screen editors
const vim = sprite.spawn('vim', ['file.txt'], {
  tty: true,
  rows: process.stdout.rows || 24,
  cols: process.stdout.columns || 80,
});
process.stdin.setRawMode(true);
process.stdin.pipe(vim.stdin);
vim.stdout.pipe(process.stdout);
await vim.wait();
```

## Detachable Sessions - Persistent Background Sessions

Detachable sessions allow creating persistent tmux-based sessions that continue running even after disconnection. You can create sessions, list active sessions, and reattach to them later. This is useful for long-running processes that need to survive connection drops or for sharing sessions between multiple clients.

```typescript
import { SpritesClient } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Create a detachable session
const session = sprite.createSession('bash', [], {
  rows: 24,
  cols: 80,
});

// The session is automatically in TTY mode with detachable: true
session.stdin.write('echo "This session persists!"\n');
session.stdout.on('data', (data) => console.log(data.toString()));

// Detach by simply stopping the streams (session continues on server)
session.stdin.end();

// List all active sessions
const sessions = await sprite.listSessions();
console.log('Active sessions:');
for (const s of sessions) {
  console.log(`  ID: ${s.id}`);
  console.log(`  Command: ${s.command}`);
  console.log(`  Created: ${s.created}`);
  console.log(`  Active: ${s.isActive}`);
  console.log(`  TTY: ${s.tty}`);
  console.log('---');
}

// Attach to an existing session
if (sessions.length > 0) {
  const attached = sprite.attachSession(sessions[0].id, {
    rows: 24,
    cols: 80,
  });

  process.stdin.setRawMode(true);
  process.stdin.pipe(attached.stdin);
  attached.stdout.pipe(process.stdout);

  attached.on('exit', (code) => {
    process.stdin.setRawMode(false);
    console.log(`Session ended with code ${code}`);
  });

  await attached.wait();
}

// Create a session running a specific long-running command
const buildSession = sprite.createSession('npm', ['run', 'build:watch']);
buildSession.stdout.on('data', (data) => console.log(data.toString()));
// Later, reattach to check build progress
```

## Port Notifications - Detecting Opened Ports

The SDK provides port notification events when processes open network ports on the sprite. This is useful for automatically detecting when services become available, enabling features like automatic port forwarding or load balancer configuration.

```typescript
import { SpritesClient, PortNotification } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Start a web server and listen for port events
const server = sprite.spawn('python', ['-m', 'http.server', '8000']);

server.on('message', (msg: PortNotification) => {
  if (msg.type === 'port_opened') {
    console.log(`Port ${msg.port} opened by PID ${msg.pid} on ${msg.address}`);
    // Now safe to start making requests to the server
    // Could also set up port forwarding here
  } else if (msg.type === 'port_closed') {
    console.log(`Port ${msg.port} closed by PID ${msg.pid}`);
  }
});

server.stdout.on('data', (data) => console.log(data.toString()));
server.stderr.on('data', (data) => console.error(data.toString()));

// Wait for the server to start (port notification will fire)
await new Promise(resolve => setTimeout(resolve, 2000));

// Clean shutdown
server.kill('SIGTERM');
await server.wait();
```

## Port Proxying - Local to Remote Port Forwarding

The proxy API enables forwarding local ports to remote ports on a sprite. This allows accessing services running on the sprite from your local machine, similar to SSH port forwarding. Multiple port mappings can be set up simultaneously.

```typescript
import { SpritesClient, ProxySession, ProxyManager } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Start a web server on the sprite
const server = sprite.spawn('python', ['-m', 'http.server', '8000']);
await new Promise(resolve => setTimeout(resolve, 2000));  // Wait for startup

// Create a proxy for a single port (local:3000 -> remote:8000)
const proxy = await sprite.proxyPort(3000, 8000);
console.log(`Proxy listening on ${proxy.localAddr()}`);
console.log('Access the server at http://localhost:3000');

// Now you can access the remote server locally
// fetch('http://localhost:3000').then(res => res.text()).then(console.log);

// Handle proxy errors
proxy.on('error', (err) => console.error('Proxy error:', err));

// Create multiple port proxies at once
const proxies = await sprite.proxyPorts([
  { localPort: 3000, remotePort: 8000 },
  { localPort: 5432, remotePort: 5432, remoteHost: 'postgres' },
  { localPort: 6379, remotePort: 6379, remoteHost: 'redis' },
]);

console.log('All proxies started:');
for (const p of proxies) {
  console.log(`  ${p.localPort} -> ${p.remoteHost}:${p.remotePort}`);
}

// Use ProxyManager for managing multiple sessions
const manager = new ProxyManager();
manager.addSession(proxy);
proxies.forEach(p => manager.addSession(p));

// Close all proxies when done
// manager.closeAll();
// Or wait for all to close
// await manager.waitAll();

// Close individual proxy
proxy.close();
await proxy.wait();
```

## Checkpoints - Save and Restore Sprite State

Checkpoints allow saving the complete state of a sprite (filesystem, processes, memory) and restoring it later. This enables features like instant rollback, cloning sprite configurations, and creating save points before risky operations. Both checkpoint creation and restoration are streaming operations with progress updates.

```typescript
import { SpritesClient, CheckpointStream, RestoreStream } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Create a checkpoint with optional comment
const checkpointStream = await sprite.createCheckpoint('pre-deployment');

// Process checkpoint progress using async iterator
for await (const msg of checkpointStream) {
  if (msg.type === 'info') {
    console.log('Info:', msg.data);
  } else if (msg.type === 'stdout') {
    process.stdout.write(msg.data || '');
  } else if (msg.type === 'stderr') {
    process.stderr.write(msg.data || '');
  } else if (msg.type === 'error') {
    console.error('Error:', msg.error);
  }
}

// Alternative: use processAll callback
const stream2 = await sprite.createCheckpoint('backup-checkpoint');
await stream2.processAll((msg) => {
  console.log(`[${msg.type}]`, msg.data || msg.error || '');
});

// List all checkpoints
const checkpoints = await sprite.listCheckpoints();
console.log('Available checkpoints:');
for (const cp of checkpoints) {
  console.log(`  ${cp.id}: ${cp.comment || '(no comment)'} - ${cp.createTime}`);
}

// Get specific checkpoint details
const checkpoint = await sprite.getCheckpoint('v3');
console.log(`Checkpoint ${checkpoint.id} created at ${checkpoint.createTime}`);

// Restore from a checkpoint
const restoreStream = await sprite.restoreCheckpoint('v3');
for await (const msg of restoreStream) {
  console.log(`[${msg.type}]`, msg.data || msg.error || '');
}

// Restore with manual stream control
const restore = await sprite.restoreCheckpoint('pre-deployment');
let message;
while ((message = await restore.next()) !== null) {
  console.log(message);
}
restore.close();  // Explicitly close when done
```

## Services - Long-Running Process Management

The Services API provides systemd-like process management for long-running services on sprites. Services can be created, started, stopped, and monitored with log streaming. Services support dependencies (needs), automatic restarts, and HTTP port exposure for proxy routing.

```typescript
import { SpritesClient, ServiceLogStream } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Create and start a service with log streaming
const createStream = await sprite.createService('web-server', {
  cmd: 'python',
  args: ['-m', 'http.server', '8000'],
  httpPort: 8000,
  needs: [],  // Dependencies on other services
}, '5s');  // Monitor for 5 seconds

// Stream service logs during creation
for await (const event of createStream) {
  switch (event.type) {
    case 'started':
      console.log('Service started');
      break;
    case 'stdout':
      console.log('[stdout]', event.data);
      break;
    case 'stderr':
      console.log('[stderr]', event.data);
      break;
    case 'exit':
      console.log('Service exited with code:', event.exitCode);
      break;
    case 'complete':
      console.log('Log files:', event.logFiles);
      break;
  }
}

// List all services
const services = await sprite.listServices();
for (const svc of services) {
  console.log(`Service: ${svc.name}`);
  console.log(`  Command: ${svc.cmd} ${svc.args.join(' ')}`);
  console.log(`  Status: ${svc.state?.status}`);
  console.log(`  PID: ${svc.state?.pid}`);
}

// Get specific service
const service = await sprite.getService('web-server');
console.log(`${service.name} is ${service.state?.status}`);

// Stop a service with timeout and log streaming
const stopStream = await sprite.stopService('web-server', '10s');
for await (const event of stopStream) {
  console.log(`[${event.type}]`, event.data || event.exitCode || '');
}

// Start a service
const startStream = await sprite.startService('web-server', '3s');
await startStream.processAll((event) => console.log(event));

// Send signal to a service
await sprite.signalService('web-server', 'HUP');  // Reload config
await sprite.signalService('web-server', 'TERM'); // Graceful shutdown

// Delete a service
await sprite.deleteService('web-server');
```

## Network Policy - Configure Network Access Rules

The Network Policy API allows configuring which domains a sprite can access. Policies use allow/deny rules with domain matching and can include preset rule sets. This is useful for security sandboxing and controlling outbound network access.

```typescript
import { SpritesClient, NetworkPolicy, PolicyRule } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Get current network policy
const currentPolicy = await sprite.getNetworkPolicy();
console.log('Current policy rules:', currentPolicy.rules);

// Set a restrictive network policy
await sprite.updateNetworkPolicy({
  rules: [
    // Include default allowed domains
    { include: 'defaults' },
    // Allow specific domains
    { domain: 'api.github.com', action: 'allow' },
    { domain: '*.npmjs.org', action: 'allow' },
    { domain: 'registry.npmjs.org', action: 'allow' },
    // Deny everything else by default (implicit)
  ],
});

// Allow all network access
await sprite.updateNetworkPolicy({
  rules: [
    { domain: '*', action: 'allow' },
  ],
});

// Deny specific domains while allowing others
await sprite.updateNetworkPolicy({
  rules: [
    { include: 'defaults' },
    { domain: '*.malicious-site.com', action: 'deny' },
    { domain: '*', action: 'allow' },
  ],
});

// Verify policy was applied
const updatedPolicy = await sprite.getNetworkPolicy();
console.log('Updated rules:', JSON.stringify(updatedPolicy.rules, null, 2));
```

## Filesystem - Remote File Operations

The SpriteFilesystem API provides Node.js fs/promises-compatible file operations for reading, writing, and managing files on a sprite. Operations include readFile, writeFile, readdir, mkdir, rm, stat, rename, copyFile, chmod, and convenience methods for JSON files.

```typescript
import { SpritesClient, SpriteFilesystem } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Get filesystem interface with optional working directory
const fs = sprite.filesystem('/app');

// Read a file as string
const content = await fs.readFile('config.json', 'utf8');
console.log('Config:', content);

// Read file as Buffer
const binary = await fs.readFile('image.png');
console.log('Image size:', binary.length);

// Write a file (creates parent directories automatically)
await fs.writeFile('data/output.txt', 'Hello, World!');
await fs.writeFile('script.sh', '#!/bin/bash\necho "Hello"', { mode: 0o755 });

// Read directory contents
const files = await fs.readdir('.');
console.log('Files:', files);

// Read directory with file type information
const entries = await fs.readdir('.', { withFileTypes: true });
for (const entry of entries) {
  const type = entry.isDirectory() ? 'DIR' : entry.isSymbolicLink() ? 'LINK' : 'FILE';
  console.log(`${type}: ${entry.name}`);
}

// Get file statistics
const stat = await fs.stat('package.json');
console.log(`Size: ${stat.size}, Modified: ${stat.mtime}`);
console.log(`Is directory: ${stat.isDirectory()}, Is file: ${stat.isFile()}`);

// Create directories (recursive)
await fs.mkdir('deep/nested/path', { recursive: true });

// Remove files and directories
await fs.rm('temp.txt');
await fs.rm('cache', { recursive: true, force: true });

// Rename/move files
await fs.rename('old-name.txt', 'new-name.txt');

// Copy files
await fs.copyFile('source.txt', 'destination.txt');
await fs.copyFile('src-dir', 'dest-dir', { recursive: true });

// Change file permissions
await fs.chmod('script.sh', 0o755);
await fs.chmod('secrets', 0o700, { recursive: true });

// Check if file exists
if (await fs.exists('config.json')) {
  console.log('Config file found');
}

// Append to file
await fs.appendFile('log.txt', 'New log entry\n');

// JSON convenience methods
const config = await fs.readJSON<{ port: number }>('config.json');
console.log('Port:', config.port);

await fs.writeJSON('settings.json', { debug: true, version: '1.0' }, { spaces: 2 });
```

## URL Settings - Configure Public Access

URL settings allow configuring authentication for sprite public URLs. Sprites can be made publicly accessible without authentication or require sprite-level authentication for access.

```typescript
import { SpritesClient } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Make sprite URL publicly accessible (no auth required)
await sprite.updateURLSettings({ auth: 'public' });

// Require authentication for sprite URL access
await sprite.updateURLSettings({ auth: 'sprite' });

// Can also update via client
await client.updateURLSettings('my-sprite', { auth: 'public' });
```

## Error Handling - API and Execution Errors

The SDK provides structured error types for handling different failure scenarios. ExecError is thrown when commands exit with non-zero codes, APIError provides detailed information about API failures including rate limiting, and FilesystemError handles filesystem operation failures with standard error codes.

```typescript
import {
  SpritesClient,
  ExecError,
  APIError,
  FilesystemError,
  ERR_CODE_CREATION_RATE_LIMITED,
  ERR_CODE_CONCURRENT_LIMIT_EXCEEDED
} from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('my-sprite');

// Handle command execution errors
try {
  await sprite.exec('exit 42');
} catch (error) {
  if (error instanceof ExecError) {
    console.log('Command failed');
    console.log('Exit code:', error.exitCode);
    console.log('Stdout:', error.stdout);
    console.log('Stderr:', error.stderr);
    console.log('Full result:', error.result);
  }
}

// Handle API errors (rate limiting, authentication, etc.)
try {
  await client.createSprite('new-sprite');
} catch (error) {
  if (error instanceof APIError) {
    console.log('API Error:', error.message);
    console.log('Status code:', error.statusCode);
    console.log('Error code:', error.errorCode);

    // Check for rate limiting
    if (error.isRateLimitError()) {
      const retryAfter = error.getRetryAfterSeconds();
      console.log(`Rate limited. Retry after ${retryAfter} seconds`);
      console.log('Rate limit:', error.rateLimitLimit);
      console.log('Remaining:', error.rateLimitRemaining);
    }

    // Check for specific rate limit types
    if (error.isCreationRateLimited()) {
      console.log(`Creation rate limited: ${error.limit} per ${error.windowSeconds}s`);
      if (error.upgradeAvailable) {
        console.log(`Upgrade available at: ${error.upgradeUrl}`);
      }
    }

    if (error.isConcurrentLimitExceeded()) {
      console.log(`Concurrent limit: ${error.currentCount}/${error.limit}`);
    }
  }
}

// Handle filesystem errors
const fs = sprite.filesystem('/app');
try {
  await fs.readFile('nonexistent.txt', 'utf8');
} catch (error) {
  if ((error as any).code === 'ENOENT') {
    console.log('File not found:', (error as any).path);
  } else if ((error as any).code === 'EACCES') {
    console.log('Permission denied');
  } else if ((error as any).code === 'EISDIR') {
    console.log('Expected file but found directory');
  }
}
```

## Summary

The Sprites SDK provides a comprehensive toolkit for remote command execution and sprite management on Fly.io's platform. Core use cases include running arbitrary commands on remote machines with streaming I/O, managing long-running services with automatic restarts and log streaming, creating checkpoint/restore points for sprite state, and performing file operations remotely. The SDK is particularly well-suited for building development environments, CI/CD pipelines, and sandboxed execution environments where you need programmatic control over remote compute instances.

Integration patterns typically involve creating a SpritesClient with an authentication token, obtaining a Sprite handle for a specific instance, then using the various APIs (exec, spawn, filesystem, services, etc.) to interact with it. The event-based spawn API works well for interactive applications and long-running processes, while the promise-based exec API is ideal for simple command execution. For production deployments, the Services API provides process supervision, and the checkpoint system enables reliable state management. Error handling should account for rate limiting (APIError), command failures (ExecError), and filesystem issues using standard Node.js-style error codes.

### Running the ACP session server inside a Sprite

To run the ACP session server defined in `server/index.ts` inside a Sprite, use a long-running service with an exposed HTTP port:

```ts
import { SpritesClient } from '@fly/sprites';

const client = new SpritesClient(process.env.SPRITES_TOKEN!);
const sprite = client.sprite('acp-session-server');

// Create or update a service that runs the Node/Bun server
const createStream = await sprite.createService('acp-server', {
  cmd: 'node',
  args: ['/app/server/index.js'], // or 'bun', ['server/index.ts'] if using Bun directly
  httpPort: 8080,
  needs: [],
}, '5s');

for await (const event of createStream) {
  if (event.type === 'stdout' || event.type === 'stderr') {
    console.log(`[${event.type}]`, event.data);
  }
}

// Make the sprite URL publicly accessible so external clients can call the HTTP/SSE endpoints
await sprite.updateURLSettings({ auth: 'public' });
```

Once the service is running and URL settings are public, the sprite’s public URL (reported by the Sprites dashboard or API) will expose:

- `GET /health` – basic health check
- `POST /sessions` – create ACP sessions
- `GET /sessions/:id` – inspect sessions
- `POST /sessions/:id/chat/stream` – SSE streaming endpoint for custom UIs

Your custom UI can then connect directly to that URL and consume streamed events from the ACP-backed coding agent.
