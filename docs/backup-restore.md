# Backup and restore

A logical backup you have never restored is a file, not a backup. This document
describes the procedure and the two scripts that perform and verify it, and it
was itself executed against a disposable database (see §6).

The deployment notes rely on Neon's 6-hour restore window. That covers a provider
mistake; it does not cover a bad migration, a mistaken `DELETE`, or a
self-hosted database at all. This is the part you control.

---

## 1. What a dump contains

`pg_dump --format=custom` captures:

- the schema (tables, indexes, constraints, the `schema_migrations` ledger),
- the rows, including `source_chunks.embedding` — pgvector values are ordinary
  columns to the dumper,
- sequences and their current values.

It does **not** capture:

- roles, passwords or grants (`--no-owner --no-privileges` makes this explicit),
- the `vector` extension binary. The target must be able to
  `CREATE EXTENSION vector`; Neon, Supabase and `pgvector/pgvector:pg16` all can,
- anything outside the database: uploaded originals on the `uploads` volume,
  provider API keys, `.env` files.

The uploads volume is a scratch area: a document's text is stored in the database
once parsed, and the original is deleted after indexing or after the final failed
attempt. Restoring the database restores what the product shows; it does not
restore a file that was only needed during ingestion.

## 2. Taking a backup

```bash
DATABASE_URL='postgres://…' node scripts/db-backup.mjs
# or
node scripts/db-backup.mjs --url 'postgres://…' --out backups/2026-11-26.dump
```

Quiesce writes first if you can: stop the API and worker, or accept that the dump
is a consistent snapshot of one transaction's start and later changes are not in
it. `pg_dump` alone is consistent; a running deployment simply means the dump is
true as of its start.

The script:

1. uses `pg_dump` from `PATH`, or runs the same command in
   `pgvector/pgvector:pg16` through Docker when the client tools are absent (a
   Windows laptop, a CI runner with only Docker),
2. writes `--format=custom --no-owner --no-privileges`,
3. **verifies the artefact**: it must be non-empty and `pg_restore --list` must
   report at least ten objects. An exit status is not evidence that a dump is
   usable.

Keep dumps out of the repository: `backups/` is not tracked.

## 3. Restoring

Restore into an **empty** database. `db-restore-verify.mjs` refuses to run when
`schema_migrations` already exists, because a partial merge is worse than a
refusal.

```bash
# 1. Create an empty database on the target server
createdb -h … -U … opspilot_restore

# 2. Restore and verify, comparing against the source when you still have it
node scripts/db-restore-verify.mjs \
  --dump backups/2026-11-26.dump \
  --url 'postgres://…/opspilot_restore' \
  --compare 'postgres://…/opspilot'
```

The script restores, then checks:

| Check | Why it is there |
|---|---|
| `schema_migrations` is non-empty | a dump that restores tables but not the ledger will make the next `db:migrate` re-run every migration |
| the `vector` extension is installed | without it every retrieval query fails, and the failure appears at request time, not restore time |
| `SELECT embedding <=> embedding` returns `0` | proves pgvector actually works on the restored data, not just that the column exists |
| row counts match `--compare` | catches a partial restore, a skipped table, or a dump taken from the wrong database |

Then migrate, which should be a no-op, and check the API:

```bash
DATABASE_URL='postgres://…/opspilot_restore' npm --prefix apps/api run db:migrate
DATABASE_URL='postgres://…/opspilot_restore' npm --prefix apps/api run start
curl -fsS http://127.0.0.1:3000/ready
```

After a restore, uploads that were queued but not yet indexed have no original on
disk. Those jobs fail once, with `Uploaded file could not be found`, and the
document can be uploaded again; nothing else needs repair.

## 4. Point-in-time needs

A logical dump is a point-in-time copy taken when it ran. Continuous recovery
(a restore to 14:32 yesterday) is a provider feature: Neon's restore window,
Supabase's PITR add-on, or `archive_command` + WAL on a self-hosted server. Take a
dump before every migration regardless — it is the copy that works when the
provider's feature is the thing that failed.

## 5. Schedule and retention

At minimum: before every migration, and nightly. Keep seven daily dumps and one
per month, off the database host. A dump on the same disk as the database is not
a backup. Rotation is deliberately not automated here: where the copy goes is a
decision about your provider and your data, and a script that guesses is worse
than a documented step you perform.

## 6. The drill, as executed

Run on 2026-11-26 against two disposable `pgvector/pgvector:pg16` containers on
this machine, using the Docker engine (no Postgres client tools on the host):

```bash
docker run -d --name opspilot-m4-db -e POSTGRES_USER=ops -e POSTGRES_PASSWORD=ops \
  -e POSTGRES_DB=opspilot -p 55435:5432 pgvector/pgvector:pg16
DATABASE_URL='postgres://ops:ops@127.0.0.1:55435/opspilot' npm --prefix apps/api run db:migrate
# … register a tenant, ingest a document (the seeded corpus) …
node scripts/db-backup.mjs --url 'postgres://ops:ops@127.0.0.1:55435/opspilot'
docker exec opspilot-m4-db createdb -U ops opspilot_restore
node scripts/db-restore-verify.mjs \
  --dump backups/….dump \
  --url 'postgres://ops:ops@127.0.0.1:55435/opspilot_restore' \
  --compare 'postgres://ops:ops@127.0.0.1:55435/opspilot'
```

Recorded output (the scripts chose the Docker engine themselves, because the host
has no Postgres client tools):

```
$ node scripts/db-backup.mjs --url postgres://ops:***@127.0.0.1:55435/opspilot --out backups/m4-drill.dump
{"message":"db.backup.started","engine":"docker","target":"…\\backups\\m4-drill.dump","database":"opspilot"}
{"message":"db.backup.verified","target":"…\\backups\\m4-drill.dump","bytes":84964,"objects":177}

$ node scripts/db-restore-verify.mjs --dump backups/m4-drill.dump \
    --url postgres://ops:***@127.0.0.1:55435/opspilot_restore \
    --compare postgres://ops:***@127.0.0.1:55435/opspilot
{"message":"db.restore.verified","engine":"docker","schemaMigrations":10,
 "vectorExtension":"0.8.7","distanceQuery":"ok",
 "counts":{"schema_migrations":10,"organizations":1,"users":1,"documents":1,
           "source_chunks":1,"investigations":1,"ingestion_jobs":0},
 "comparedWith":"opspilot","countsMatch":true}
```

The source database held one organization, one user, one document, one indexed
chunk (a 768-dimension vector, so the distance query had something real to
compare) and one investigation created through the running API. The refusal path
was exercised too: pointing the verifier at the populated source database exits
1 with `the target database already has 19 tables in schema public`.

The containers were removed afterwards. This drill is the only evidence that the
procedure works, and re-running it after a schema change is cheaper than
discovering the first problem during an incident.
