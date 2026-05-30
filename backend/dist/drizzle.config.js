import { defineConfig } from 'drizzle-kit';
export default defineConfig({
    dialect: 'postgresql',
    schema: './src/db/schema.ts',
    out: './drizzle',
    dbCredentials: {
        // Use DIRECT URL for migrations (not pooled — PgBouncer can conflict with migration SET statements)
        url: process.env.DATABASE_URL,
    },
    // CRITICAL: Prevents drizzle-kit from touching Better Auth's auto-managed tables.
    // Without this, drizzle-kit generate would emit DROP TABLE for user/session/account/verification.
    tablesFilter: [
        'service_emails',
        'contracts',
        'contract_threads',
        'inbound_emails',
        'contract_signers',
    ],
    verbose: true,
    strict: true,
});
