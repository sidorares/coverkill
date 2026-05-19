import { spawn, type ChildProcess } from 'node:child_process';
import type { WebServerConfig } from '../config/types.js';

export type WebServerHandle = {
  process: ChildProcess;
  stop: () => Promise<void>;
};

export async function startWebServer(config: WebServerConfig): Promise<WebServerHandle | null> {
  const reuse = config.reuseExistingServer ?? false;
  const timeout = config.timeout ?? 60_000;

  if (reuse && (await isServerUp(config.url))) {
    return null;
  }

  if (!reuse && (await isServerUp(config.url))) {
    throw new Error(
      `Server already running at ${config.url}. Set webServer.reuseExistingServer: true or stop the server.`,
    );
  }

  const child = spawn(config.command, {
    shell: true,
    cwd: config.cwd ?? process.cwd(),
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[webServer] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[webServer] ${chunk.toString()}`);
  });

  const ready = await waitForUrl(config.url, timeout);
  if (!ready) {
    await stopProcess(child);
    throw new Error(`webServer did not become ready at ${config.url} within ${timeout}ms`);
  }

  return {
    process: child,
    stop: () => stopProcess(child),
  };
}

export async function stopWebServer(handle: WebServerHandle | null): Promise<void> {
  if (handle) {
    await handle.stop();
  }
}

async function isServerUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitForUrl(url: string, timeout: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isServerUp(url)) return true;
    await sleep(250);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000);
  });
}
