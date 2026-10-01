#!/usr/bin/env node
/**
 * `pnpm dev`: run the PlayLens API (port 8000) and web app (port 3000) together,
 * with prefixed output. Ctrl+C stops both. Use `pnpm dev:api` / `pnpm dev:web`
 * to run either alone.
 */
import { spawn } from "node:child_process";

const procs = [
  { name: "api", color: "\x1b[36m", cmd: "pnpm", args: ["dev:api"] },
  { name: "web", color: "\x1b[35m", cmd: "pnpm", args: ["dev:web"] },
];

let stopping = false;
const children = procs.map(({ name, color, cmd, args }) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line) out.write(prefix + line + "\n");
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) {
      process.stderr.write(`${prefix}exited with code ${code}; stopping the other process.\n`);
      stop(code ?? 1);
    }
  });
  return child;
});

function stop(code = 0) {
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
