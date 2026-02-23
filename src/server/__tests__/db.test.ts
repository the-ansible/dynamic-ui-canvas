import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-db.js';

describe('canvases table', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('inserts and retrieves a canvas', async () => {
    await db.exec(`
      INSERT INTO canvases (id, title, descriptor)
      VALUES ('c1', 'My Canvas', '{"type":"canvas","components":[]}')
    `);

    const result = await db.query<{ id: string; title: string; descriptor: object; state: object }>(
      `SELECT id, title, descriptor, state FROM canvases WHERE id = 'c1'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe('c1');
    expect(result.rows[0].title).toBe('My Canvas');
    expect(result.rows[0].descriptor).toEqual({ type: 'canvas', components: [] });
    expect(result.rows[0].state).toEqual({});
  });

  it('updates a canvas', async () => {
    await db.exec(`
      INSERT INTO canvases (id, title, descriptor)
      VALUES ('c2', 'Original', '{}')
    `);

    await db.exec(`
      UPDATE canvases SET title = 'Updated', updated_at = CURRENT_TIMESTAMP WHERE id = 'c2'
    `);

    const result = await db.query<{ title: string }>(
      `SELECT title FROM canvases WHERE id = 'c2'`
    );

    expect(result.rows[0].title).toBe('Updated');
  });

  it('deletes a canvas', async () => {
    await db.exec(`
      INSERT INTO canvases (id, title, descriptor)
      VALUES ('c3', 'To Delete', '{}')
    `);

    await db.exec(`DELETE FROM canvases WHERE id = 'c3'`);

    const result = await db.query(`SELECT id FROM canvases WHERE id = 'c3'`);
    expect(result.rows).toHaveLength(0);
  });

  it('enforces NOT NULL on title', async () => {
    await expect(
      db.exec(`INSERT INTO canvases (id, title, descriptor) VALUES ('c4', NULL, '{}')`)
    ).rejects.toThrow();
  });

  it('enforces NOT NULL on descriptor', async () => {
    await expect(
      db.exec(`INSERT INTO canvases (id, title, descriptor) VALUES ('c5', 'Title', NULL)`)
    ).rejects.toThrow();
  });

  it('enforces PRIMARY KEY uniqueness', async () => {
    await db.exec(`INSERT INTO canvases (id, title, descriptor) VALUES ('c6', 'First', '{}')`);
    await expect(
      db.exec(`INSERT INTO canvases (id, title, descriptor) VALUES ('c6', 'Second', '{}')`)
    ).rejects.toThrow();
  });

  it('stores state as JSONB', async () => {
    await db.exec(`
      INSERT INTO canvases (id, title, descriptor, state)
      VALUES ('c7', 'Stateful', '{}', '{"activeTab":"overview","scrollY":120}')
    `);

    const result = await db.query<{ state: object }>(
      `SELECT state FROM canvases WHERE id = 'c7'`
    );

    expect(result.rows[0].state).toEqual({ activeTab: 'overview', scrollY: 120 });
  });
});

describe('canvas_events table', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    // Seed a canvas for FK references
    await db.exec(`
      INSERT INTO canvases (id, title, descriptor) VALUES ('canvas-1', 'Test Canvas', '{}')
    `);
  });

  it('inserts and retrieves an event', async () => {
    await db.exec(`
      INSERT INTO canvas_events (id, canvas_id, event_type, payload)
      VALUES ('evt1', 'canvas-1', 'component_clicked', '{"componentId":"btn-1","value":null}')
    `);

    const result = await db.query<{ id: string; canvas_id: string; event_type: string; payload: object }>(
      `SELECT id, canvas_id, event_type, payload FROM canvas_events WHERE id = 'evt1'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].canvas_id).toBe('canvas-1');
    expect(result.rows[0].event_type).toBe('component_clicked');
    expect(result.rows[0].payload).toEqual({ componentId: 'btn-1', value: null });
  });

  it('enforces foreign key — canvas_id must exist', async () => {
    await expect(
      db.exec(`
        INSERT INTO canvas_events (id, canvas_id, event_type)
        VALUES ('evt2', 'nonexistent', 'click')
      `)
    ).rejects.toThrow();
  });

  it('cascades delete when canvas is deleted', async () => {
    await db.exec(`
      INSERT INTO canvas_events (id, canvas_id, event_type)
      VALUES ('evt3', 'canvas-1', 'rendered')
    `);

    // Verify event exists
    const before = await db.query(`SELECT id FROM canvas_events WHERE id = 'evt3'`);
    expect(before.rows).toHaveLength(1);

    // Delete the canvas
    await db.exec(`DELETE FROM canvases WHERE id = 'canvas-1'`);

    // Event should be gone
    const after = await db.query(`SELECT id FROM canvas_events WHERE id = 'evt3'`);
    expect(after.rows).toHaveLength(0);
  });

  it('allows multiple events per canvas', async () => {
    await db.exec(`
      INSERT INTO canvas_events (id, canvas_id, event_type) VALUES ('e1', 'canvas-1', 'init');
      INSERT INTO canvas_events (id, canvas_id, event_type) VALUES ('e2', 'canvas-1', 'click');
      INSERT INTO canvas_events (id, canvas_id, event_type) VALUES ('e3', 'canvas-1', 'update');
    `);

    const result = await db.query(`SELECT id FROM canvas_events WHERE canvas_id = 'canvas-1'`);
    expect(result.rows).toHaveLength(3);
  });

  it('stores payload as JSONB', async () => {
    await db.exec(`
      INSERT INTO canvas_events (id, canvas_id, event_type, payload)
      VALUES ('evt4', 'canvas-1', 'form_submit', '{"fields":{"name":"Alice","age":30}}')
    `);

    const result = await db.query<{ payload: object }>(
      `SELECT payload FROM canvas_events WHERE id = 'evt4'`
    );

    expect(result.rows[0].payload).toEqual({ fields: { name: 'Alice', age: 30 } });
  });

  it('defaults payload to empty object', async () => {
    await db.exec(`
      INSERT INTO canvas_events (id, canvas_id, event_type) VALUES ('evt5', 'canvas-1', 'ping')
    `);

    const result = await db.query<{ payload: object }>(
      `SELECT payload FROM canvas_events WHERE id = 'evt5'`
    );

    expect(result.rows[0].payload).toEqual({});
  });
});

describe('canvas_state table', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.exec(`
      INSERT INTO canvases (id, title, descriptor) VALUES ('canvas-1', 'Test Canvas', '{}')
    `);
  });

  it('inserts and retrieves component state', async () => {
    await db.exec(`
      INSERT INTO canvas_state (id, canvas_id, component_id, state)
      VALUES ('cs1', 'canvas-1', 'tab-widget', '{"activeTab":1}')
    `);

    const result = await db.query<{ id: string; canvas_id: string; component_id: string; state: object }>(
      `SELECT id, canvas_id, component_id, state FROM canvas_state WHERE id = 'cs1'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].canvas_id).toBe('canvas-1');
    expect(result.rows[0].component_id).toBe('tab-widget');
    expect(result.rows[0].state).toEqual({ activeTab: 1 });
  });

  it('enforces foreign key — canvas_id must exist', async () => {
    await expect(
      db.exec(`
        INSERT INTO canvas_state (id, canvas_id, component_id, state)
        VALUES ('cs2', 'ghost-canvas', 'btn', '{}')
      `)
    ).rejects.toThrow();
  });

  it('cascades delete when canvas is deleted', async () => {
    await db.exec(`
      INSERT INTO canvas_state (id, canvas_id, component_id, state)
      VALUES ('cs3', 'canvas-1', 'my-chart', '{"zoom":1.5}')
    `);

    const before = await db.query(`SELECT id FROM canvas_state WHERE id = 'cs3'`);
    expect(before.rows).toHaveLength(1);

    await db.exec(`DELETE FROM canvases WHERE id = 'canvas-1'`);

    const after = await db.query(`SELECT id FROM canvas_state WHERE id = 'cs3'`);
    expect(after.rows).toHaveLength(0);
  });

  it('enforces UNIQUE constraint on (canvas_id, component_id)', async () => {
    await db.exec(`
      INSERT INTO canvas_state (id, canvas_id, component_id, state)
      VALUES ('cs4', 'canvas-1', 'slider-1', '{"value":50}')
    `);

    await expect(
      db.exec(`
        INSERT INTO canvas_state (id, canvas_id, component_id, state)
        VALUES ('cs5', 'canvas-1', 'slider-1', '{"value":75}')
      `)
    ).rejects.toThrow();
  });

  it('allows same component_id across different canvases', async () => {
    await db.exec(`
      INSERT INTO canvases (id, title, descriptor) VALUES ('canvas-2', 'Second Canvas', '{}')
    `);

    await db.exec(`
      INSERT INTO canvas_state (id, canvas_id, component_id, state)
      VALUES ('cs6', 'canvas-1', 'shared-comp', '{"x":1}')
    `);

    // Same component_id but different canvas_id — should succeed
    await db.exec(`
      INSERT INTO canvas_state (id, canvas_id, component_id, state)
      VALUES ('cs7', 'canvas-2', 'shared-comp', '{"x":2}')
    `);

    const result = await db.query(
      `SELECT id FROM canvas_state WHERE component_id = 'shared-comp'`
    );
    expect(result.rows).toHaveLength(2);
  });

  it('updates component state', async () => {
    await db.exec(`
      INSERT INTO canvas_state (id, canvas_id, component_id, state)
      VALUES ('cs8', 'canvas-1', 'counter', '{"count":0}')
    `);

    await db.exec(`
      UPDATE canvas_state SET state = '{"count":5}' WHERE id = 'cs8'
    `);

    const result = await db.query<{ state: object }>(
      `SELECT state FROM canvas_state WHERE id = 'cs8'`
    );

    expect(result.rows[0].state).toEqual({ count: 5 });
  });

  it('defaults state to empty object', async () => {
    await db.exec(`
      INSERT INTO canvas_state (id, canvas_id, component_id) VALUES ('cs9', 'canvas-1', 'empty-comp')
    `);

    const result = await db.query<{ state: object }>(
      `SELECT state FROM canvas_state WHERE id = 'cs9'`
    );

    expect(result.rows[0].state).toEqual({});
  });
});

describe('cascade deletes across all tables', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('deleting a canvas removes all related events and state', async () => {
    await db.exec(`INSERT INTO canvases (id, title, descriptor) VALUES ('canvas-x', 'X', '{}')`);
    await db.exec(`INSERT INTO canvas_events (id, canvas_id, event_type) VALUES ('ex1', 'canvas-x', 'init')`);
    await db.exec(`INSERT INTO canvas_events (id, canvas_id, event_type) VALUES ('ex2', 'canvas-x', 'click')`);
    await db.exec(`INSERT INTO canvas_state (id, canvas_id, component_id) VALUES ('sx1', 'canvas-x', 'comp-a')`);
    await db.exec(`INSERT INTO canvas_state (id, canvas_id, component_id) VALUES ('sx2', 'canvas-x', 'comp-b')`);

    await db.exec(`DELETE FROM canvases WHERE id = 'canvas-x'`);

    const events = await db.query(`SELECT id FROM canvas_events WHERE canvas_id = 'canvas-x'`);
    const states = await db.query(`SELECT id FROM canvas_state WHERE canvas_id = 'canvas-x'`);

    expect(events.rows).toHaveLength(0);
    expect(states.rows).toHaveLength(0);
  });
});
