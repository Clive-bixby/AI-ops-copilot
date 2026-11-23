import { spawn } from "node:child_process";

/**
 * Run the API and the ingestion worker in one container.
 *
 * The two are separate processes for a reason -- a slow embedding run must not
 * starve the API's event loop -- and they stay separate here. What changes is
 * the packaging: free container hosts give you one service, and splitting them
 * across services breaks the upload hand-off, because the API writes the file
 * the worker then parses. One container, one filesystem, two processes.
 *
 * Each child keeps its own graceful shutdown (`src/index.ts` and
 * `workers/ingestion.worker.ts` already drain on SIGTERM); this supervisor's job
 * is to deliver the signal to both and to outlive neither.
 */

const SERVICES = [
  { name: "api", entry: "src/index.ts" },
  { name: "worker", entry: "src/workers/ingestion.worker.ts" },
];

/** Longer than either child's own in-flight grace period. */
const KILL_GRACE_MS = 15_000;

const children = SERVICES.map(({ name, entry }) => {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    stdio: "inherit",
    env: process.env,
  });

  return { name, child };
});

let stopping = false;

function waitFor(child) {
  return child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function stop(reason, code) {
  if (stopping) {
    return;
  }
  stopping = true;

  console.log(
    JSON.stringify({ level: "info", message: "supervisor.stopping", reason })
  );

  for (const { child } of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  const force = setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "supervisor.forced_kill",
            graceMs: KILL_GRACE_MS,
          })
        );
        child.kill("SIGKILL");
      }
    }
  }, KILL_GRACE_MS);

  force.unref();

  await Promise.all(children.map(({ child }) => waitFor(child)));
  clearTimeout(force);

  console.log(JSON.stringify({ level: "info", message: "supervisor.stopped", code }));
  process.exit(code);
}

for (const { name, child } of children) {
  child.on("exit", (code, signal) => {
    console.log(
      JSON.stringify({
        level: code === 0 && !stopping ? "warn" : "info",
        message: "supervisor.child_exited",
        name,
        code,
        signal,
      })
    );

    if (!stopping) {
      // One process dying must take the container down. A running API next to a
      // dead worker still answers /health while every upload silently stops
      // indexing, which is worse than a restart.
      void stop(`${name}_exited`, code === 0 ? 1 : code ?? 1);
    }
  });

  child.on("error", (error) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "supervisor.spawn_failed",
        name,
        error: error.message,
      })
    );
    void stop(`${name}_spawn_failed`, 1);
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => void stop(signal, 0));
}
