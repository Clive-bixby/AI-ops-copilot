import { spawnSync } from "node:child_process";

/**
 * Run the Postgres client tools (`pg_dump`, `pg_restore`, `psql`) for the
 * backup scripts.
 *
 * Two engines, one set of arguments. A machine with the client tools installed
 * runs them directly; a machine without them (a Windows laptop with Docker
 * Desktop, a CI runner that only has Docker) runs the same command inside the
 * `pgvector/pgvector:pg16` image, which carries all three tools at the version
 * this project deploys. The image tag is pinned to the major version of the
 * server, because `pg_dump` refuses to read a dump from a newer server and
 * `pg_restore` does not reliably read one from an older one.
 */

export const DOCKER_IMAGE = "pgvector/pgvector:pg16";

/** Absolute directory mounted at `/backup` when the Docker engine is used. */
export const CONTAINER_MOUNT = "/backup";

export function hasBinary(name) {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

export function chooseEngine() {
  if (hasBinary("pg_dump") && hasBinary("pg_restore") && hasBinary("psql")) {
    return "local";
  }

  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  });

  if (docker.status === 0) {
    return "docker";
  }

  throw new Error(
    "Neither the Postgres client tools (pg_dump, pg_restore, psql) nor a running Docker daemon is available."
  );
}

/**
 * The URL as the chosen engine must see it. A loopback host is the database on
 * this machine; a container is not on this machine, so it reaches the host
 * through `host.docker.internal`, which the `--add-host` flag below defines.
 */
export function rewriteUrlForEngine(url, engine) {
  if (engine !== "docker") {
    return url;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
    parsed.hostname = "host.docker.internal";
  }

  return parsed.toString();
}

/**
 * Run one client command. `mountDir` is required when the command reads or
 * writes a file, so the container can see it.
 */
export function runTool(tool, args, options = {}) {
  const { engine = chooseEngine(), mountDir, capture = false } = options;

  const command =
    engine === "docker"
      ? [
          "docker",
          [
            "run",
            "--rm",
            "--add-host=host.docker.internal:host-gateway",
            ...(mountDir ? ["-v", `${mountDir}:${CONTAINER_MOUNT}`] : []),
            DOCKER_IMAGE,
            tool,
            ...args,
          ],
        ]
      : [tool, args];

  const result = spawnSync(command[0], command[1], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(
      `${tool} exited with status ${result.status}${detail ? `: ${detail}` : ""}`
    );
  }

  return result.stdout ?? "";
}

/** One scalar from a query, or null when it returns no rows. */
export function queryScalar(url, sql, options = {}) {
  const output = runTool(
    "psql",
    ["--no-psqlrc", "--tuples-only", "--no-align", `--dbname=${url}`, "--command", sql],
    { ...options, capture: true }
  );

  return output.trim().split("\n")[0]?.trim() ?? "";
}

/** Table row counts, for comparing a restore against its source. */
export const COMPARED_TABLES = [
  "schema_migrations",
  "organizations",
  "users",
  "documents",
  "source_chunks",
  "investigations",
  "ingestion_jobs",
];
