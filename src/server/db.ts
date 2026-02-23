import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.JANE_DATABASE_URL;

if (!connectionString) {
  throw new Error('JANE_DATABASE_URL environment variable is required');
}

export const pool = new Pool({ connectionString });

// Set search_path to canvas schema for all connections
pool.on('connect', (client) => {
  client.query('SET search_path TO canvas, public');
});

/** Database client interface — compatible with both PGlite and pg Pool wrappers. */
export interface DbClient {
  query<T extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

// Compatibility wrapper matching PGlite's interface: db.query<T>(sql, params) and db.exec(sql)
export const db: DbClient = {
  async query<T extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    const result = await pool.query<T>(sql, params);
    return { rows: result.rows };
  },
  async exec(sql: string): Promise<void> {
    await pool.query(sql);
  },
};

export async function initializeDatabase() {
  await pool.query('CREATE SCHEMA IF NOT EXISTS canvas');
  await db.exec(`
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_canvas_events_canvas_id ON canvas_events(canvas_id);
    CREATE INDEX IF NOT EXISTS idx_canvas_events_created_at ON canvas_events(created_at);

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

  // Migration: add acknowledged column to canvas_events if it doesn't exist
  await db.exec(`
    ALTER TABLE canvas_events ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_canvas_events_acknowledged ON canvas_events(acknowledged);
  `);
}
