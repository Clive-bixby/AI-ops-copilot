import { Pool, types } from "pg"
import dotenv from "dotenv"

dotenv.config()

// The schema uses TIMESTAMP WITHOUT TIME ZONE and stores UTC values. Parse
// those values as UTC so API responses do not shift by the server timezone.
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`))

/**
 * SSL used to be forced on for every connection, which made the API unable to
 * reach a plain local Postgres (the compose database included): the server
 * answers "The server does not support SSL connections" and the connection
 * fails before any query runs.
 *
 * Rules, in order:
 *   DATABASE_SSL=false   -> never use SSL
 *   DATABASE_SSL=true    -> always use SSL
 *   sslmode=disable      -> never use SSL
 *   sslmode=<anything>   -> use SSL
 *   loopback host        -> no SSL (local development)
 *   anything else        -> SSL, with certificate verification off
 *
 * Verification stays off for remote hosts because that was the previous
 * behaviour; turning it on is tracked as follow-up work.
 */
function resolveSsl(connectionString: string | undefined) {
  const explicit = process.env.DATABASE_SSL?.trim().toLowerCase()

  if (explicit === "false" || explicit === "0") return undefined
  if (explicit === "true" || explicit === "1") return { rejectUnauthorized: false }

  if (!connectionString) return undefined

  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    return undefined
  }

  const sslmode = url.searchParams.get("sslmode")
  if (sslmode === "disable") return undefined
  if (sslmode) return { rejectUnauthorized: false }

  const host = url.hostname
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return undefined
  }

  return { rejectUnauthorized: false }
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(process.env.DATABASE_URL),
})
