import { Pool, types } from "pg"
import dotenv from "dotenv"

dotenv.config()

// The schema uses TIMESTAMP WITHOUT TIME ZONE and stores UTC values. Parse
// those values as UTC so API responses do not shift by the server timezone.
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`))

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // This allows the connection to managed providers like Supabase
  }
})