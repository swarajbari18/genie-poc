// One-off Component 7 schema migration applier.
//
// Drizzle-kit's interactive push isn't usable in a non-TTY shell. The
// generated diff (confirmed via `drizzle-kit push` warning output) is
// exactly these three statements — no DROPs, only `contracts` + the
// enum, leaving Better Auth's tables untouched.
//
// Run with: `node scripts/apply-c7-migration.mjs`
// Uses DATABASE_URL (direct) — matches drizzle.config.ts.

import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const sql = postgres(url, { max: 1, ssl: 'require' })

async function main() {
  // 1) Add the new enum value to contract_status.
  // ALTER TYPE ... ADD VALUE in PG < 12 cannot run in a transaction;
  // in 12+ it can in some cases. We run it alone to be safe.
  await sql.unsafe(`
    ALTER TYPE "public"."contract_status" ADD VALUE IF NOT EXISTS 'received';
  `)
  console.log("✓ contract_status: 'received' value present")

  // 2) Create the contract_origin enum.
  await sql.unsafe(`
    DO $$ BEGIN
      CREATE TYPE "public"."contract_origin" AS ENUM ('created','received');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `)
  console.log('✓ contract_origin enum present')

  // 3) Add the origin column with default. New rows default to 'created';
  //    existing rows backfill to 'created' (correct — every existing
  //    contract pre-C7 was uploaded by its owner, never received).
  await sql.unsafe(`
    ALTER TABLE "contracts"
      ADD COLUMN IF NOT EXISTS "origin" "contract_origin" NOT NULL DEFAULT 'created';
  `)
  console.log("✓ contracts.origin column present, default 'created'")

  // 4) Sanity check.
  const rows = await sql.unsafe(`
    SELECT unnest(enum_range(NULL::contract_status))::text AS status_values;
  `)
  console.log('contract_status values:', rows.map((r) => r.status_values))

  const cols = await sql.unsafe(`
    SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='contracts' AND column_name='origin';
  `)
  console.log('contracts.origin definition:', cols)
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error('Migration failed:', err.message)
    await sql.end()
    process.exit(1)
  })
