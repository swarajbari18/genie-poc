import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'

// Use the POOLED URL for application queries
const queryClient = postgres(process.env.DATABASE_URL_POOLED!, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  ssl: 'require',
})

export const db = drizzle(queryClient, { schema })
