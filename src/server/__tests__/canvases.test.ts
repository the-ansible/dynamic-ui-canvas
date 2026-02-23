/**
 * Integration tests for canvas REST API endpoints.
 *
 * Uses Hono's built-in test support (app.request) with isolated PostgreSQL schemas.
 * No real HTTP server is started — requests go directly through the Hono fetch handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createTestDb } from './test-db.js';
import type { DbClient } from '../db.js';
import { createCanvasesRouter } from '../routes/canvases.js';

// ─── Test setup ──────────────────────────────────────────────────────────────

function createTestApp(db: DbClient): Hono {
  const app = new Hono();
  app.route('/api/canvases', createCanvasesRouter(db));
  return app;
}

async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// ─── Sample descriptors ───────────────────────────────────────────────────────

const simpleDescriptor = {
  title: 'Test Canvas',
  components: [
    {
      id: 'btn-1',
      type: 'button',
      props: { label: 'Click me' },
    },
  ],
};

const dashboardDescriptor = {
  title: 'Dashboard',
  components: [
    {
      id: 'header-1',
      type: 'heading',
      props: { level: 1, text: 'My Dashboard' },
    },
    {
      id: 'chart-1',
      type: 'chart',
      props: { chartType: 'bar', data: { labels: ['A', 'B'], values: [10, 20] } },
    },
  ],
};

// ─── POST /api/canvases ───────────────────────────────────────────────────────

describe('POST /api/canvases', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('creates a canvas and returns 201 with the canvas object', async () => {
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBeTruthy();
    expect(body.title).toBe('Test Canvas');
    expect(body.descriptor).toMatchObject(simpleDescriptor);
    expect(body.state).toEqual({});
    expect(body.created_at).toBeTruthy();
    expect(body.updated_at).toBeTruthy();
  });

  it('stores canvas in database', async () => {
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const created = await res.json() as Record<string, unknown>;

    const row = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM canvases WHERE id = $1`,
      [created.id]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].title).toBe('Test Canvas');
  });

  it('accepts descriptor with empty components array', async () => {
    const res = await req(app, 'POST', '/api/canvases', { title: 'Empty Canvas', components: [] });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.title).toBe('Empty Canvas');
  });

  it('accepts descriptor with nested children', async () => {
    const nested = {
      title: 'Nested',
      components: [
        {
          id: 'container-1',
          type: 'container',
          props: {},
          children: [
            { id: 'text-1', type: 'text', props: { content: 'Hello' } },
          ],
        },
      ],
    };
    const res = await req(app, 'POST', '/api/canvases', nested);
    expect(res.status).toBe(201);
  });

  it('returns 400 if title is missing', async () => {
    const res = await req(app, 'POST', '/api/canvases', { components: [] });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Validation failed');
    expect(body.details).toEqual(expect.arrayContaining([
      expect.stringContaining('title'),
    ]));
  });

  it('returns 400 if components is missing', async () => {
    const res = await req(app, 'POST', '/api/canvases', { title: 'No Components' });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Validation failed');
  });

  it('returns 400 if component has unknown type', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'Bad Type',
      components: [{ id: 'x', type: 'super-widget', props: {} }],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Validation failed');
    expect((body.details as string[]).some((e) => e.includes('super-widget'))).toBe(true);
  });

  it('returns 400 if component is missing id', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'Missing ID',
      components: [{ type: 'button', props: {} }],
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 if body is not JSON', async () => {
    const res = await app.request('/api/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Invalid JSON body');
  });

  it('assigns unique IDs to each canvas', async () => {
    const r1 = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const r2 = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const b1 = await r1.json() as Record<string, unknown>;
    const b2 = await r2.json() as Record<string, unknown>;
    expect(b1.id).not.toBe(b2.id);
  });
});

// ─── GET /api/canvases ───────────────────────────────────────────────────────

describe('GET /api/canvases', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns empty array when no canvases exist', async () => {
    const res = await req(app, 'GET', '/api/canvases');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it('lists all canvases ordered by created_at desc', async () => {
    await req(app, 'POST', '/api/canvases', { title: 'First', components: [] });
    await req(app, 'POST', '/api/canvases', { title: 'Second', components: [] });
    await req(app, 'POST', '/api/canvases', { title: 'Third', components: [] });

    const res = await req(app, 'GET', '/api/canvases');
    const list = await res.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    // Should return id, title, created_at, updated_at — not full descriptor
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('title');
    expect(list[0]).toHaveProperty('created_at');
    expect(list[0]).toHaveProperty('updated_at');
    expect(list[0]).not.toHaveProperty('descriptor');
    expect(list[0]).not.toHaveProperty('state');
  });
});

// ─── GET /api/canvases/:id ───────────────────────────────────────────────────

describe('GET /api/canvases/:id', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', dashboardDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns full canvas with descriptor, empty componentStates and formValidity', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe(canvasId);
    expect(body.title).toBe('Dashboard');
    expect(body.descriptor).toMatchObject(dashboardDescriptor);
    expect(body.componentStates).toEqual({});
    expect(body.formValidity).toEqual({});
  });

  it('includes componentStates when state has been set', async () => {
    // Set state via action event
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'chart-1',
      eventType: 'zoom_change',
      value: 2.0,
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.componentStates).toMatchObject({
      'chart-1': { value: 2.0 },
    });
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'GET', '/api/canvases/does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });
});

// ─── PATCH /api/canvases/:id ─────────────────────────────────────────────────

describe('PATCH /api/canvases/:id', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('replaces descriptor when descriptor field is provided', async () => {
    const newDescriptor = {
      title: 'Updated Canvas',
      components: [
        { id: 'text-1', type: 'text', props: { content: 'New content' } },
      ],
    };
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, { descriptor: newDescriptor });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.descriptor).toMatchObject(newDescriptor);
  });

  it('merges canvas-level state when state field is provided', async () => {
    // Set initial state
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: { theme: 'dark' } });
    // Merge additional state
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: { zoom: 1.5 } });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.state).toMatchObject({ theme: 'dark', zoom: 1.5 });
  });

  it('upserts component state when components array is provided', async () => {
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [
        { id: 'btn-1', state: { disabled: true } },
      ],
    });
    expect(res.status).toBe(200);

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    expect(stateBody.components).toMatchObject({
      'btn-1': { disabled: true },
    });
  });

  it('merges component state on repeated patches', async () => {
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [{ id: 'btn-1', state: { count: 1 } }],
    });
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [{ id: 'btn-1', state: { label: 'Done' } }],
    });

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const body = await stateRes.json() as Record<string, unknown>;
    expect(body.components).toMatchObject({
      'btn-1': { count: 1, label: 'Done' },
    });
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'PATCH', '/api/canvases/does-not-exist', { state: {} });
    expect(res.status).toBe(404);
  });

  it('returns 400 if patch body is empty', async () => {
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, {});
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Validation failed');
  });

  it('returns 400 if descriptor fails validation', async () => {
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      descriptor: { title: '', components: [] }, // empty title fails validation
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 if body is not JSON', async () => {
    const res = await app.request(`/api/canvases/${canvasId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'oops',
    });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /api/canvases/:id ────────────────────────────────────────────────

describe('DELETE /api/canvases/:id', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('deletes a canvas and returns { deleted: true, id }', async () => {
    const res = await req(app, 'DELETE', `/api/canvases/${canvasId}`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.deleted).toBe(true);
    expect(body.id).toBe(canvasId);
  });

  it('canvas is no longer retrievable after deletion', async () => {
    await req(app, 'DELETE', `/api/canvases/${canvasId}`);
    const res = await req(app, 'GET', `/api/canvases/${canvasId}`);
    expect(res.status).toBe(404);
  });

  it('cascade deletes events and state', async () => {
    // Create some events and state
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
      eventType: 'click',
    });
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [{ id: 'btn-1', state: { clicked: true } }],
    });

    // Delete canvas
    await req(app, 'DELETE', `/api/canvases/${canvasId}`);

    // Verify cascade
    const events = await db.query(`SELECT id FROM canvas_events WHERE canvas_id = $1`, [canvasId]);
    const states = await db.query(`SELECT id FROM canvas_state WHERE canvas_id = $1`, [canvasId]);
    expect(events.rows).toHaveLength(0);
    expect(states.rows).toHaveLength(0);
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'DELETE', '/api/canvases/ghost');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });

  it('canvas no longer appears in list after deletion', async () => {
    await req(app, 'DELETE', `/api/canvases/${canvasId}`);
    const res = await req(app, 'GET', '/api/canvases');
    const list = await res.json() as unknown[];
    expect(list).toHaveLength(0);
  });
});

// ─── POST /api/canvases/:id/actions ─────────────────────────────────────────

describe('POST /api/canvases/:id/actions', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('records a button click event and returns 201 with event object', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
      eventType: 'button_click',
    });
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBeTruthy();
    expect(body.canvas_id).toBe(canvasId);
    expect(body.event_type).toBe('button_click');
    expect(body.payload).toMatchObject({ componentId: 'btn-1' });
    expect(body.created_at).toBeTruthy();
  });

  it('records action value in payload and updates component state', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'slider-1',
      eventType: 'value_change',
      value: 75,
    });
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect((body.payload as Record<string, unknown>).value).toBe(75);

    // Component state should now reflect the value
    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    expect(stateBody.components).toMatchObject({
      'slider-1': { value: 75 },
    });
  });

  it('stores metadata in payload when provided', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'form-1',
      eventType: 'form_submit',
      value: { name: 'Alice', age: 30 },
      metadata: { source: 'keyboard' },
    });
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    expect(payload.metadata).toEqual({ source: 'keyboard' });
  });

  it('does not update component state when no value is provided', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
      eventType: 'button_click',
    });

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    expect(stateBody.components).toEqual({});
  });

  it('accumulates multiple events for the same canvas', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, { componentId: 'btn-1', eventType: 'click' });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, { componentId: 'btn-1', eventType: 'click' });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, { componentId: 'btn-1', eventType: 'click' });

    const events = await db.query(`SELECT id FROM canvas_events WHERE canvas_id = $1`, [canvasId]);
    expect(events.rows).toHaveLength(3);
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'POST', '/api/canvases/ghost/actions', {
      componentId: 'btn-1',
      eventType: 'click',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 if componentId is missing', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      eventType: 'click',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Validation failed');
  });

  it('returns 400 if eventType is missing', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 if body is not JSON', async () => {
    const res = await app.request(`/api/canvases/${canvasId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad body',
    });
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/canvases/:id/state ─────────────────────────────────────────────

describe('GET /api/canvases/:id/state', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns snapshot with empty components when no state has been set', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.canvasId).toBe(canvasId);
    expect(body.components).toEqual({});
    expect(body.formValidity).toEqual({});
    expect(typeof body.snapshotAt).toBe('string');
  });

  it('returns components keyed by component_id', async () => {
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [
        { id: 'comp-a', state: { active: true } },
        { id: 'comp-b', state: { value: 'hello' } },
      ],
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.components).toEqual({
      'comp-a': { active: true },
      'comp-b': { value: 'hello' },
    });
  });

  it('reflects state updates from action events', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1',
      eventType: 'input_change',
      value: 'typed text',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.components).toMatchObject({
      'input-1': { value: 'typed text' },
    });
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'GET', '/api/canvases/no-such-canvas/state');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });
});

// ─── Validation module unit tests ────────────────────────────────────────────

describe('validation', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('POST accepts all valid component types', async () => {
    const types = ['container', 'grid', 'stack', 'text', 'heading', 'markdown',
      'table', 'list', 'chart', 'input', 'button', 'form', 'progress', 'badge'];

    const components = types.map((type, i) => ({ id: `comp-${i}`, type, props: {} }));
    const res = await req(app, 'POST', '/api/canvases', { title: 'All Types', components });
    expect(res.status).toBe(201);
  });

  it('POST rejects component with invalid props (not an object)', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'Bad props',
      components: [{ id: 'c', type: 'button', props: 'not-an-object' }],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.details).toEqual(expect.arrayContaining([expect.stringContaining('props')]));
  });

  it('POST rejects component with invalid children (not an array)', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'Bad children',
      components: [{ id: 'c', type: 'container', children: 'oops' }],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.details).toEqual(expect.arrayContaining([expect.stringContaining('children')]));
  });

  it('PATCH rejects state that is not an object', async () => {
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: [1, 2, 3] });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.details).toEqual(expect.arrayContaining([expect.stringContaining('state')]));
  });

  it('PATCH rejects component patch without id', async () => {
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [{ state: { x: 1 } }],
    });
    expect(res.status).toBe(400);
  });

  it('action event rejects metadata that is not an object', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
      eventType: 'click',
      metadata: 'not-an-object',
    });
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/canvases/:id/state/:componentId ─────────────────────────────────

describe('GET /api/canvases/:id/state/:componentId', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns 404 when component has no state', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/state/nonexistent-comp`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Component state not found');
  });

  it('returns 404 when canvas does not exist', async () => {
    const res = await req(app, 'GET', '/api/canvases/no-canvas/state/comp-1');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });

  it('returns component state after an action sets it', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1',
      eventType: 'change',
      value: 'hello world',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/state/input-1`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.componentId).toBe('input-1');
    expect(body.state).toEqual({ value: 'hello world' });
    expect(typeof body.updatedAt).toBe('string');
  });

  it('returns component state set via PATCH', async () => {
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [{ id: 'toggle-1', state: { value: true, label: 'on' } }],
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/state/toggle-1`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.componentId).toBe('toggle-1');
    expect(body.state).toEqual({ value: true, label: 'on' });
  });

  it('reflects latest state after multiple updates', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'slider-1',
      eventType: 'change',
      value: 10,
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'slider-1',
      eventType: 'change',
      value: 75,
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/state/slider-1`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.state).toEqual({ value: 75 });
  });
});

// ─── GET /api/canvases/:id/events ────────────────────────────────────────────

describe('GET /api/canvases/:id/events', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'GET', '/api/canvases/no-canvas/events');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });

  it('returns empty events list for fresh canvas', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns events after actions are posted', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
      eventType: 'click',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1',
      eventType: 'change',
      value: 'hello',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(2);
    const events = body.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    // Newest first
    expect(events[0].eventType).toBe('change');
    expect(events[1].eventType).toBe('click');
  });

  it('event shape includes required fields', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
      eventType: 'click',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events`);
    const body = await res.json() as Record<string, unknown>;
    const events = body.events as Array<Record<string, unknown>>;
    const ev = events[0];

    expect(typeof ev.id).toBe('string');
    expect(ev.canvasId).toBe(canvasId);
    expect(ev.eventType).toBe('click');
    expect((ev.payload as Record<string, unknown>).componentId).toBe('btn-1');
    expect(typeof ev.createdAt).toBe('string');
  });

  it('filters by componentId query param', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1', eventType: 'change', value: 'x',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?componentId=btn-1`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(1);
    const events = body.events as Array<Record<string, unknown>>;
    expect((events[0].payload as Record<string, unknown>).componentId).toBe('btn-1');
  });

  it('filters by eventType query param', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1', eventType: 'change', value: 'x',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-2', eventType: 'click',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?eventType=click`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(2);
    const events = body.events as Array<Record<string, unknown>>;
    for (const ev of events) {
      expect(ev.eventType).toBe('click');
    }
  });

  it('supports limit and offset pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
        componentId: 'btn', eventType: 'click',
      });
    }

    const page1 = await (await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=2&offset=0`)).json() as Record<string, unknown>;
    const page2 = await (await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=2&offset=2`)).json() as Record<string, unknown>;
    const page3 = await (await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=2&offset=4`)).json() as Record<string, unknown>;

    expect((page1.events as unknown[]).length).toBe(2);
    expect((page2.events as unknown[]).length).toBe(2);
    expect((page3.events as unknown[]).length).toBe(1);
    expect(page1.total).toBe(5);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=0`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid offset', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?offset=-1`);
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/canvases/:id/events/pending ───────────────────────────────────

describe('GET /api/canvases/:id/events/pending', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'GET', '/api/canvases/no-canvas/events/pending');
    expect(res.status).toBe(404);
  });

  it('returns empty list for fresh canvas', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events/pending`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns all unacknowledged events', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1', eventType: 'change', value: 'test',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events/pending`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(2);
    expect((body.events as unknown[]).length).toBe(2);
  });

  it('excludes acknowledged events', async () => {
    // Create two events
    const r1 = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    const evt1 = await r1.json() as Record<string, unknown>;

    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-2', eventType: 'click',
    });

    // Acknowledge the first
    await req(app, 'POST', `/api/canvases/${canvasId}/events/${evt1.id}/acknowledge`);

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events/pending`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(1);
    const events = body.events as Array<Record<string, unknown>>;
    expect((events[0].payload as Record<string, unknown>).componentId).toBe('btn-2');
  });

  it('filters by componentId', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-2', eventType: 'click',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events/pending?componentId=btn-1`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(1);
  });

  it('filters by eventType', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1', eventType: 'change', value: 'x',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events/pending?eventType=change`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(1);
  });
});

// ─── POST /api/canvases/:id/events/:eventId/acknowledge ─────────────────────

describe('POST /api/canvases/:id/events/:eventId/acknowledge', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'POST', '/api/canvases/no-canvas/events/evt-1/acknowledge');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });

  it('returns 404 for non-existent event', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/events/nonexistent/acknowledge`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Event not found or already acknowledged');
  });

  it('acknowledges an event successfully', async () => {
    const actionRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    const evt = await actionRes.json() as Record<string, unknown>;

    const res = await req(app, 'POST', `/api/canvases/${canvasId}/events/${evt.id}/acknowledge`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(true);
    expect(body.eventId).toBe(evt.id);
  });

  it('returns 404 when acknowledging already-acknowledged event', async () => {
    const actionRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    const evt = await actionRes.json() as Record<string, unknown>;

    await req(app, 'POST', `/api/canvases/${canvasId}/events/${evt.id}/acknowledge`);
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/events/${evt.id}/acknowledge`);
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/canvases/:id/events/acknowledge (batch) ──────────────────────

describe('POST /api/canvases/:id/events/acknowledge (batch)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'POST', '/api/canvases/no-canvas/events/acknowledge', { eventIds: [] });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid body', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/events/acknowledge`, { foo: 'bar' });
    expect(res.status).toBe(400);
  });

  it('acknowledges multiple events', async () => {
    const r1 = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    const r2 = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-2', eventType: 'click',
    });
    const evt1 = await r1.json() as Record<string, unknown>;
    const evt2 = await r2.json() as Record<string, unknown>;

    const res = await req(app, 'POST', `/api/canvases/${canvasId}/events/acknowledge`, {
      eventIds: [evt1.id, evt2.id],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(2);

    // Verify no pending events remain
    const pendingRes = await req(app, 'GET', `/api/canvases/${canvasId}/events/pending`);
    const pending = await pendingRes.json() as Record<string, unknown>;
    expect(pending.total).toBe(0);
  });

  it('handles empty eventIds array', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/events/acknowledge`, {
      eventIds: [],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.acknowledged).toBe(0);
  });
});
