/**
 * Test database helper — creates isolated schemas in PostgreSQL for each test.
 *
 * Schema naming convention: canvas_test_<uuid>
 * This makes cleanup easy: DROP all schemas matching 'canvas_test_%'
 */
import pg from 'pg';
import crypto from 'crypto';
import type { DbClient } from '../db.js';

const { Pool } = pg;

/** Prefix for all test schemas — used for pattern-based cleanup. */
const TEST_SCHEMA_PREFIX = 'canvas_test_';

/**
 * Creates an isolated test database client with its own schema.
 * Call `cleanup()` on the returned object to drop the schema when done.
 */
export async function createTestDb(): Promise<DbClient & { cleanup: () => Promise<void> }> {
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) {
    throw new Error('JANE_DATABASE_URL environment variable is required for tests');
  }

  const uuid = crypto.randomUUID().replace(/-/g, '');
  const schemaName = `${TEST_SCHEMA_PREFIX}${uuid}`;
  const pool = new Pool({ connectionString, max: 2 });

  // Create isolated schema
  await pool.query(`CREATE SCHEMA ${schemaName}`);
  await pool.query(`SET search_path TO ${schemaName}, public`);

  // Set search_path for all future connections from this pool
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${schemaName}, public`);
  });

  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canvases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      descriptor JSONB NOT NULL,
      state JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_canvases_created_at ON canvases(created_at);

    CREATE TABLE IF NOT EXISTS canvas_events (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_canvas_events_canvas_id ON canvas_events(canvas_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_events_created_at ON canvas_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_events_acknowledged ON canvas_events(acknowledged);

    CREATE TABLE IF NOT EXISTS canvas_state (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      component_id TEXT NOT NULL,
      state JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (canvas_id, component_id)
    );

    CREATE INDEX IF NOT EXISTS idx_canvas_state_canvas_id ON canvas_state(canvas_id);
  `);

  const db: DbClient & { cleanup: () => Promise<void> } = {
    async query<T extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
      const result = await pool.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async cleanup(): Promise<void> {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    },
  };

  return db;
}

/**
 * Drops all test schemas matching the convention prefix.
 * Call this to clean up leaked schemas from failed test runs.
 */
export async function cleanupAllTestSchemas(): Promise<number> {
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) return 0;

  const pool = new Pool({ connectionString, max: 1 });
  const result = await pool.query(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1`,
    [`${TEST_SCHEMA_PREFIX}%`]
  );

  for (const row of result.rows) {
    await pool.query(`DROP SCHEMA IF EXISTS ${row.schema_name} CASCADE`);
  }

  await pool.end();
  return result.rows.length;
}
