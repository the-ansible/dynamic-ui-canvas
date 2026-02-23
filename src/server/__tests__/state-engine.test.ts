/**
 * Unit tests for StateEngine.
 *
 * Uses isolated PostgreSQL schemas so tests are isolated and fast.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-db.js';
import type { DbClient } from '../db.js';
import { StateEngine } from '../state-engine.js';

// ─── Test setup ──────────────────────────────────────────────────────────────

async function seedCanvas(
  db: DbClient,
  id: string,
  title = 'Test Canvas',
  descriptor: object = { title, components: [] }
): Promise<void> {
  await db.query(
    `INSERT INTO canvases (id, title, descriptor) VALUES ($1, $2, $3)`,
    [id, title, JSON.stringify(descriptor)]
  );
}

// ─── applyAction ─────────────────────────────────────────────────────────────

describe('StateEngine.applyAction', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('persists an event to canvas_events', async () => {
    const eventId = await engine.applyAction('c1', 'comp-a', 'click');

    const result = await db.query<{
      id: string;
      canvas_id: string;
      event_type: string;
      payload: { componentId: string };
    }>(
      `SELECT id, canvas_id, event_type, payload FROM canvas_events WHERE id = $1`,
      [eventId]
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.id).toBe(eventId);
    expect(row.canvas_id).toBe('c1');
    expect(row.event_type).toBe('click');
    expect(row.payload.componentId).toBe('comp-a');
  });

  it('returns a valid UUID event ID', async () => {
    const eventId = await engine.applyAction('c1', 'comp-a', 'click');
    expect(eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('persists value into canvas_state when value is provided', async () => {
    await engine.applyAction('c1', 'input-1', 'change', 'hello');

    const state = await engine.getComponentState('c1', 'input-1');
    expect(state).not.toBeNull();
    expect(state!.state).toEqual({ value: 'hello' });
  });

  it('does NOT create canvas_state row when value is omitted', async () => {
    await engine.applyAction('c1', 'btn-1', 'click');

    const state = await engine.getComponentState('c1', 'btn-1');
    expect(state).toBeNull();
  });

  it('includes metadata in event payload', async () => {
    await engine.applyAction('c1', 'comp-a', 'submit', 'data', { source: 'keyboard' });

    const result = await db.query<{ payload: { metadata: { source: string } } }>(
      `SELECT payload FROM canvas_events WHERE canvas_id = 'c1' AND event_type = 'submit'`
    );
    expect(result.rows[0].payload.metadata).toEqual({ source: 'keyboard' });
  });

  it('merges subsequent values (shallow merge)', async () => {
    await engine.applyAction('c1', 'input-1', 'change', 'first');
    await engine.applyAction('c1', 'input-1', 'change', 'second');

    const state = await engine.getComponentState('c1', 'input-1');
    expect(state!.state).toEqual({ value: 'second' });
  });

  it('handles non-string values (number)', async () => {
    await engine.applyAction('c1', 'slider-1', 'change', 42);

    const state = await engine.getComponentState('c1', 'slider-1');
    expect(state!.state).toEqual({ value: 42 });
  });

  it('handles non-string values (boolean)', async () => {
    await engine.applyAction('c1', 'toggle-1', 'change', true);

    const state = await engine.getComponentState('c1', 'toggle-1');
    expect(state!.state).toEqual({ value: true });
  });

  it('handles array values (multi-select)', async () => {
    await engine.applyAction('c1', 'select-1', 'change', ['a', 'b']);

    const state = await engine.getComponentState('c1', 'select-1');
    expect(state!.state).toEqual({ value: ['a', 'b'] });
  });
});

// ─── setComponentState ───────────────────────────────────────────────────────

describe('StateEngine.setComponentState', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('creates component state from scratch', async () => {
    await engine.setComponentState('c1', 'form-1', { value: 'hello', error: null });

    const state = await engine.getComponentState('c1', 'form-1');
    expect(state).not.toBeNull();
    expect(state!.componentId).toBe('form-1');
    expect(state!.state).toEqual({ value: 'hello', error: null });
  });

  it('merges new keys into existing state', async () => {
    await engine.setComponentState('c1', 'comp-1', { value: 'a' });
    await engine.setComponentState('c1', 'comp-1', { error: 'required' });

    const state = await engine.getComponentState('c1', 'comp-1');
    expect(state!.state).toEqual({ value: 'a', error: 'required' });
  });

  it('overwrites existing key on re-set', async () => {
    await engine.setComponentState('c1', 'comp-1', { value: 'old' });
    await engine.setComponentState('c1', 'comp-1', { value: 'new' });

    const state = await engine.getComponentState('c1', 'comp-1');
    expect(state!.state).toEqual({ value: 'new' });
  });

  it('records updatedAt timestamp', async () => {
    await engine.setComponentState('c1', 'comp-1', { value: 'x' });

    const state = await engine.getComponentState('c1', 'comp-1');
    expect(state!.updatedAt).toBeTruthy();
    // Should be parseable as a date
    expect(new Date(state!.updatedAt).getTime()).not.toBeNaN();
  });
});

// ─── replaceComponentState ───────────────────────────────────────────────────

describe('StateEngine.replaceComponentState', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('sets state on a fresh component', async () => {
    await engine.replaceComponentState('c1', 'comp-1', { value: 'hello', checked: true });

    const state = await engine.getComponentState('c1', 'comp-1');
    expect(state!.state).toEqual({ value: 'hello', checked: true });
  });

  it('fully replaces (does NOT merge) existing state', async () => {
    await engine.setComponentState('c1', 'comp-1', { value: 'a', error: 'required' });
    await engine.replaceComponentState('c1', 'comp-1', { value: 'b' });

    const state = await engine.getComponentState('c1', 'comp-1');
    // error key should be gone — full replace, not merge
    expect(state!.state).toEqual({ value: 'b' });
    expect(state!.state).not.toHaveProperty('error');
  });
});

// ─── getComponentState ───────────────────────────────────────────────────────

describe('StateEngine.getComponentState', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns null when component has no state', async () => {
    const result = await engine.getComponentState('c1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns the component state with correct shape', async () => {
    await engine.setComponentState('c1', 'input-1', { value: 'test' });

    const result = await engine.getComponentState('c1', 'input-1');
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      componentId: 'input-1',
      state: { value: 'test' },
    });
    expect(typeof result!.updatedAt).toBe('string');
  });

  it('is scoped to canvas — different canvas, different state', async () => {
    await seedCanvas(db, 'c2');
    await engine.setComponentState('c1', 'comp-1', { value: 'canvas1' });
    await engine.setComponentState('c2', 'comp-1', { value: 'canvas2' });

    const s1 = await engine.getComponentState('c1', 'comp-1');
    const s2 = await engine.getComponentState('c2', 'comp-1');
    expect(s1!.state).toEqual({ value: 'canvas1' });
    expect(s2!.state).toEqual({ value: 'canvas2' });
  });
});

// ─── getCanvasSnapshot ───────────────────────────────────────────────────────

describe('StateEngine.getCanvasSnapshot', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns empty components and formValidity on fresh canvas', async () => {
    const snapshot = await engine.getCanvasSnapshot('c1');

    expect(snapshot.canvasId).toBe('c1');
    expect(snapshot.components).toEqual({});
    expect(snapshot.formValidity).toEqual({});
    expect(typeof snapshot.snapshotAt).toBe('string');
  });

  it('includes all component states in snapshot', async () => {
    await engine.setComponentState('c1', 'input-1', { value: 'hello' });
    await engine.setComponentState('c1', 'toggle-1', { value: true });

    const snapshot = await engine.getCanvasSnapshot('c1');
    expect(snapshot.components['input-1']).toEqual({ value: 'hello' });
    expect(snapshot.components['toggle-1']).toEqual({ value: true });
  });

  it('computes formValidity from descriptor — form with no required fields is valid', async () => {
    const descriptor = {
      title: 'Test',
      components: [
        {
          id: 'form-1',
          type: 'form',
          children: [
            { id: 'input-1', type: 'input', props: { required: false } },
          ],
        },
      ],
    };

    const snapshot = await engine.getCanvasSnapshot('c1', descriptor);
    expect(snapshot.formValidity['form-1']).toBe(true);
  });

  it('computes formValidity — required field unfilled → invalid', async () => {
    const descriptor = {
      title: 'Test',
      components: [
        {
          id: 'form-1',
          type: 'form',
          children: [
            { id: 'name', type: 'input', props: { required: true } },
          ],
        },
      ],
    };

    // No state set for 'name' yet
    const snapshot = await engine.getCanvasSnapshot('c1', descriptor);
    expect(snapshot.formValidity['form-1']).toBe(false);
  });

  it('computes formValidity — required field filled → valid', async () => {
    const descriptor = {
      title: 'Test',
      components: [
        {
          id: 'form-1',
          type: 'form',
          children: [
            { id: 'name', type: 'input', props: { required: true } },
          ],
        },
      ],
    };

    await engine.setComponentState('c1', 'name', { value: 'Alice' });

    const snapshot = await engine.getCanvasSnapshot('c1', descriptor);
    expect(snapshot.formValidity['form-1']).toBe(true);
  });

  it('computes formValidity — empty string value is invalid for required field', async () => {
    const descriptor = {
      title: 'Test',
      components: [
        {
          id: 'form-1',
          type: 'form',
          children: [
            { id: 'name', type: 'input', props: { required: true } },
          ],
        },
      ],
    };

    await engine.setComponentState('c1', 'name', { value: '' });

    const snapshot = await engine.getCanvasSnapshot('c1', descriptor);
    expect(snapshot.formValidity['form-1']).toBe(false);
  });

  it('computes formValidity — empty array is invalid for required select', async () => {
    const descriptor = {
      title: 'Test',
      components: [
        {
          id: 'form-1',
          type: 'form',
          children: [
            { id: 'tags', type: 'select', props: { required: true } },
          ],
        },
      ],
    };

    await engine.setComponentState('c1', 'tags', { value: [] });

    const snapshot = await engine.getCanvasSnapshot('c1', descriptor);
    expect(snapshot.formValidity['form-1']).toBe(false);
  });

  it('handles multiple forms in one descriptor', async () => {
    const descriptor = {
      title: 'Test',
      components: [
        {
          id: 'form-1',
          type: 'form',
          children: [
            { id: 'f1-name', type: 'input', props: { required: true } },
          ],
        },
        {
          id: 'form-2',
          type: 'form',
          children: [
            { id: 'f2-email', type: 'input', props: { required: true } },
          ],
        },
      ],
    };

    await engine.setComponentState('c1', 'f1-name', { value: 'Alice' });
    // f2-email remains empty

    const snapshot = await engine.getCanvasSnapshot('c1', descriptor);
    expect(snapshot.formValidity['form-1']).toBe(true);
    expect(snapshot.formValidity['form-2']).toBe(false);
  });

  it('snapshotAt is a valid ISO timestamp', async () => {
    const snapshot = await engine.getCanvasSnapshot('c1');
    expect(new Date(snapshot.snapshotAt).toISOString()).toBe(snapshot.snapshotAt);
  });
});

// ─── getEventHistory ─────────────────────────────────────────────────────────

describe('StateEngine.getEventHistory', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
    await seedCanvas(db, 'c2');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns empty history for fresh canvas', async () => {
    const result = await engine.getEventHistory('c1');

    expect(result.events).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns events in descending order (newest first)', async () => {
    await engine.applyAction('c1', 'btn', 'click');
    await engine.applyAction('c1', 'input', 'change', 'hello');
    await engine.applyAction('c1', 'btn', 'click');

    const result = await engine.getEventHistory('c1');

    expect(result.events).toHaveLength(3);
    expect(result.total).toBe(3);
    // Newest first (last applied = first in list)
    expect(result.events[0].eventType).toBe('click');
  });

  it('includes correct event shape', async () => {
    await engine.applyAction('c1', 'input-1', 'change', 'test', { key: 'val' });

    const result = await engine.getEventHistory('c1');
    const ev = result.events[0];

    expect(ev).toMatchObject({
      canvasId: 'c1',
      eventType: 'change',
      payload: {
        componentId: 'input-1',
        value: 'test',
        metadata: { key: 'val' },
      },
    });
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.createdAt).toBe('string');
  });

  it('scopes events to the requested canvas', async () => {
    await engine.applyAction('c1', 'comp-a', 'click');
    await engine.applyAction('c2', 'comp-b', 'click');

    const r1 = await engine.getEventHistory('c1');
    const r2 = await engine.getEventHistory('c2');

    expect(r1.events).toHaveLength(1);
    expect(r2.events).toHaveLength(1);
    expect(r1.events[0].canvasId).toBe('c1');
    expect(r2.events[0].canvasId).toBe('c2');
  });

  it('filters by componentId', async () => {
    await engine.applyAction('c1', 'comp-a', 'click');
    await engine.applyAction('c1', 'comp-b', 'click');
    await engine.applyAction('c1', 'comp-a', 'click');

    const result = await engine.getEventHistory('c1', { componentId: 'comp-a' });

    expect(result.events).toHaveLength(2);
    expect(result.total).toBe(2);
    for (const ev of result.events) {
      expect(ev.payload.componentId).toBe('comp-a');
    }
  });

  it('filters by eventType', async () => {
    await engine.applyAction('c1', 'btn', 'click');
    await engine.applyAction('c1', 'input', 'change', 'x');
    await engine.applyAction('c1', 'btn', 'click');

    const result = await engine.getEventHistory('c1', { eventType: 'click' });

    expect(result.events).toHaveLength(2);
    expect(result.total).toBe(2);
    for (const ev of result.events) {
      expect(ev.eventType).toBe('click');
    }
  });

  it('filters by both componentId and eventType', async () => {
    await engine.applyAction('c1', 'btn-1', 'click');
    await engine.applyAction('c1', 'btn-2', 'click');
    await engine.applyAction('c1', 'btn-1', 'hover');

    const result = await engine.getEventHistory('c1', { componentId: 'btn-1', eventType: 'click' });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload.componentId).toBe('btn-1');
    expect(result.events[0].eventType).toBe('click');
  });

  it('supports limit and offset for pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.applyAction('c1', 'btn', 'click');
    }

    const page1 = await engine.getEventHistory('c1', { limit: 2, offset: 0 });
    const page2 = await engine.getEventHistory('c1', { limit: 2, offset: 2 });
    const page3 = await engine.getEventHistory('c1', { limit: 2, offset: 4 });

    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(2);
    expect(page3.events).toHaveLength(1);

    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page3.total).toBe(5);

    // No duplicate event IDs across pages
    const ids = [
      ...page1.events.map((e) => e.id),
      ...page2.events.map((e) => e.id),
      ...page3.events.map((e) => e.id),
    ];
    expect(new Set(ids).size).toBe(5);
  });

  it('defaults limit to 100 (not fetching more than total)', async () => {
    for (let i = 0; i < 3; i++) {
      await engine.applyAction('c1', 'btn', 'click');
    }

    const result = await engine.getEventHistory('c1');
    expect(result.events).toHaveLength(3);
  });
});

// ─── getPendingEvents ───────────────────────────────────────────────────────

describe('StateEngine.getPendingEvents', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns all events as pending when none are acknowledged', async () => {
    await engine.applyAction('c1', 'btn-1', 'click');
    await engine.applyAction('c1', 'input-1', 'change', 'hello');

    const result = await engine.getPendingEvents('c1');
    expect(result.events).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('returns events in ascending order (oldest first)', async () => {
    await engine.applyAction('c1', 'btn-1', 'click');
    await engine.applyAction('c1', 'btn-2', 'click');

    const result = await engine.getPendingEvents('c1');
    expect(result.events[0].payload.componentId).toBe('btn-1');
    expect(result.events[1].payload.componentId).toBe('btn-2');
  });

  it('excludes acknowledged events', async () => {
    const id1 = await engine.applyAction('c1', 'btn-1', 'click');
    await engine.applyAction('c1', 'btn-2', 'click');

    await engine.acknowledgeEvent(id1);

    const result = await engine.getPendingEvents('c1');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload.componentId).toBe('btn-2');
  });

  it('filters by componentId', async () => {
    await engine.applyAction('c1', 'btn-1', 'click');
    await engine.applyAction('c1', 'btn-2', 'click');

    const result = await engine.getPendingEvents('c1', { componentId: 'btn-1' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload.componentId).toBe('btn-1');
  });

  it('filters by eventType', async () => {
    await engine.applyAction('c1', 'btn-1', 'click');
    await engine.applyAction('c1', 'input-1', 'change', 'x');

    const result = await engine.getPendingEvents('c1', { eventType: 'click' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe('click');
  });

  it('returns empty when all events are acknowledged', async () => {
    const id1 = await engine.applyAction('c1', 'btn-1', 'click');
    const id2 = await engine.applyAction('c1', 'btn-2', 'click');

    await engine.acknowledgeEvents([id1, id2]);

    const result = await engine.getPendingEvents('c1');
    expect(result.events).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('supports limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.applyAction('c1', `btn-${i}`, 'click');
    }

    const page1 = await engine.getPendingEvents('c1', { limit: 2, offset: 0 });
    const page2 = await engine.getPendingEvents('c1', { limit: 2, offset: 2 });

    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(2);
    expect(page1.total).toBe(5);
  });
});

// ─── acknowledgeEvent ───────────────────────────────────────────────────────

describe('StateEngine.acknowledgeEvent', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('acknowledges an event and returns true', async () => {
    const eventId = await engine.applyAction('c1', 'btn-1', 'click');
    const result = await engine.acknowledgeEvent(eventId);
    expect(result).toBe(true);
  });

  it('returns false for non-existent event', async () => {
    const result = await engine.acknowledgeEvent('nonexistent-id');
    expect(result).toBe(false);
  });

  it('returns false when event is already acknowledged', async () => {
    const eventId = await engine.applyAction('c1', 'btn-1', 'click');
    await engine.acknowledgeEvent(eventId);
    const result = await engine.acknowledgeEvent(eventId);
    expect(result).toBe(false);
  });

  it('acknowledged event no longer appears in pending', async () => {
    const eventId = await engine.applyAction('c1', 'btn-1', 'click');
    await engine.acknowledgeEvent(eventId);

    const pending = await engine.getPendingEvents('c1');
    expect(pending.events).toHaveLength(0);
  });
});

// ─── acknowledgeEvents (batch) ──────────────────────────────────────────────

describe('StateEngine.acknowledgeEvents', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await seedCanvas(db, 'c1');
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('acknowledges multiple events and returns count', async () => {
    const id1 = await engine.applyAction('c1', 'btn-1', 'click');
    const id2 = await engine.applyAction('c1', 'btn-2', 'click');
    const id3 = await engine.applyAction('c1', 'btn-3', 'click');

    const count = await engine.acknowledgeEvents([id1, id2, id3]);
    expect(count).toBe(3);
  });

  it('returns 0 for empty array', async () => {
    const count = await engine.acknowledgeEvents([]);
    expect(count).toBe(0);
  });

  it('only counts events that were actually acknowledged', async () => {
    const id1 = await engine.applyAction('c1', 'btn-1', 'click');
    await engine.acknowledgeEvent(id1); // pre-acknowledge one

    const id2 = await engine.applyAction('c1', 'btn-2', 'click');

    const count = await engine.acknowledgeEvents([id1, id2, 'nonexistent']);
    expect(count).toBe(1); // only id2 was newly acknowledged
  });
});
