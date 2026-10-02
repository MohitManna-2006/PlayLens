#!/usr/bin/env node
/**
 * `pnpm dev` (and the last step of `make dev`): run the PlayLens API (port 8000)
 * and web app together with prefixed output. Use `pnpm dev:api` / `pnpm dev:web`
 * to run either alone.
 *
 * PLAYLENS_WEB_PORT pins the web port (make dev picks the first free port from
 * 3000); without it Next.js chooses, starting at 3000.
 *
 * Ctrl+C (or SIGTERM) stops both servers and waits for them to exit, sending
 * SIGKILL only to one that is still running after 8 s. If either server exits on
 * its own, the other is stopped too and its exit code is returned.
 */
import { spawn } from "node:child_process";

const webEnv = process.env.PLAYLENS_WEB_PORT ? { ...process.env, PORT: process.env.PLAYLENS_WEB_PORT } : process.env;
const procs = [
  { name: "api", color: "\x1b[36m", cmd: "pnpm", args: ["dev:api"], env: process.env },
  { name: "web", color: "\x1b[35m", cmd: "pnpm", args: ["dev:web"], env: webEnv },
];
const GRACE_MS = 8000;

let stopping = false;
let exitCode = 0;
const children = procs.map(({ name, color, cmd, args, env }) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line) out.write(prefix + line + "\n");
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.on("exit", (code) => {
    if (!stopping) {
      process.stderr.write(`${prefix}exited with code ${code}; stopping the other process.\n`);
      exitCode = code ?? 1;
      stop();
    }
  });
  return child;
});

async function stop() {
  if (stopping) {
    // A second Ctrl+C: do not wait any longer.
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    return;
  }
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }, GRACE_MS);
  await Promise.all(children.map((c) => c.exited));
  clearTimeout(timer);
  process.stderr.write("[dev] API and web stopped.\n");
  process.exit(exitCode);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
