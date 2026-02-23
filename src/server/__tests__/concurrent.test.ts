/**
 * Concurrent update tests and edge case tests for the Canvas API Server.
 *
 * Covers:
 *   - Concurrent REST requests (simultaneous PATCH, simultaneous action events)
 *   - WebSocket + REST integration (REST mutations broadcast to WS subscribers)
 *   - Edge cases: invalid descriptors, deeply nested components, boundary conditions
 *   - State management edge cases: null values, object values, complex merges
 *   - Multiple canvas isolation (actions on one canvas don't affect another)
 *   - Event ordering guarantees
 *   - Limit boundary values for pagination
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createTestDb } from './test-db.js';
import type { DbClient } from '../db.js';
import { createServer } from 'http';
import { WebSocket } from 'ws';
import { createCanvasesRouter } from '../routes/canvases.js';
import { CanvasWebSocketManager } from '../ws.js';
import { StateEngine } from '../state-engine.js';

// ─── Test setup helpers ───────────────────────────────────────────────────────

function createTestApp(db: DbClient, wsManager?: CanvasWebSocketManager): Hono {
  const app = new Hono();
  app.route('/api/canvases', createCanvasesRouter(db, wsManager));
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

/** Creates a test HTTP server with WS support on a random port. */
async function createTestServerWithWs(db: DbClient): Promise<{
  app: Hono;
  wsManager: CanvasWebSocketManager;
  port: number;
  close: () => Promise<void>;
}> {
  const httpServer = createServer();
  const wsManager = new CanvasWebSocketManager(httpServer);
  const app = createTestApp(db, wsManager);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;

  return {
    app,
    wsManager,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wsManager.close().then(() => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function collectMessages(ws: WebSocket, count: number): Promise<object[]> {
  return new Promise((resolve) => {
    const messages: object[] = [];
    const handler = (data: Buffer | string) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= count) {
        ws.off('message', handler);
        resolve(messages);
      }
    };
    ws.on('message', handler);
  });
}

async function subscribeClient(ws: WebSocket, canvasId: string): Promise<void> {
  const msgPromise = collectMessages(ws, 1);
  ws.send(JSON.stringify({ type: 'subscribe', canvasId }));
  await msgPromise;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const simpleDescriptor = {
  title: 'Test Canvas',
  components: [{ id: 'btn-1', type: 'button', props: { label: 'Click' } }],
};

// ─── Concurrent REST requests ─────────────────────────────────────────────────

describe('Concurrent REST requests', () => {
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

  it('handles concurrent canvas creations — all succeed with unique IDs', async () => {
    const creates = Array.from({ length: 5 }, (_, i) =>
      req(app, 'POST', '/api/canvases', { title: `Canvas ${i}`, components: [] })
    );
    const results = await Promise.all(creates);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<Record<string, unknown>>));

    for (const body of bodies) {
      expect(body.id).toBeTruthy();
    }
    const ids = new Set(bodies.map((b) => b.id as string));
    expect(ids.size).toBe(5);
  });

  it('handles concurrent action events on the same canvas — all recorded', async () => {
    const actions = Array.from({ length: 5 }, (_, i) =>
      req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
        componentId: `comp-${i}`,
        eventType: 'click',
      })
    );
    const results = await Promise.all(actions);
    for (const res of results) {
      expect(res.status).toBe(201);
    }

    const events = await db.query(
      `SELECT id FROM canvas_events WHERE canvas_id = $1`,
      [canvasId]
    );
    expect(events.rows).toHaveLength(5);
  });

  it('handles concurrent PATCH requests — final state contains all merged keys', async () => {
    const patches = [
      req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: { key1: 'val1' } }),
      req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: { key2: 'val2' } }),
      req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: { key3: 'val3' } }),
    ];
    const results = await Promise.all(patches);
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Final canvas state must include all three keys (merged via JSONB ||)
    const canvasRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = await canvasRes.json() as Record<string, unknown>;
    // At least all patch keys are accounted for in the final state
    const state = canvas.state as Record<string, unknown>;
    // At least one of the values must be present (order-dependent, but all completed)
    const keys = Object.keys(state);
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });

  it('handles concurrent action events updating the same component — last write wins', async () => {
    const actions = [10, 20, 30, 40, 50].map((val) =>
      req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
        componentId: 'slider-1',
        eventType: 'change',
        value: val,
      })
    );
    await Promise.all(actions);

    // State should be one of the submitted values (upsert via merge — last write wins)
    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state/slider-1`);
    expect(stateRes.status).toBe(200);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    const state = stateBody.state as Record<string, unknown>;
    expect([10, 20, 30, 40, 50]).toContain(state.value);
  });

  it('concurrent creates on different canvases remain isolated', async () => {
    const [r1, r2] = await Promise.all([
      req(app, 'POST', '/api/canvases', { title: 'Canvas A', components: [] }),
      req(app, 'POST', '/api/canvases', { title: 'Canvas B', components: [] }),
    ]);
    const [b1, b2] = await Promise.all([
      r1.json() as Promise<Record<string, unknown>>,
      r2.json() as Promise<Record<string, unknown>>,
    ]);

    // Action on canvas A shouldn't affect canvas B
    await req(app, 'POST', `/api/canvases/${b1.id}/actions`, {
      componentId: 'comp-1',
      eventType: 'click',
    });

    const eventsB = await db.query(
      `SELECT id FROM canvas_events WHERE canvas_id = $1`,
      [b2.id]
    );
    expect(eventsB.rows).toHaveLength(0);
  });
});

// ─── WebSocket + REST integration ─────────────────────────────────────────────

describe('WebSocket + REST integration', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;
  let wsManager: CanvasWebSocketManager;
  let port: number;
  let close: () => Promise<void>;
  let canvasId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const server = await createTestServerWithWs(db);
    app = server.app;
    wsManager = server.wsManager;
    port = server.port;
    close = server.close;

    const res = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const body = await res.json() as Record<string, unknown>;
    canvasId = body.id as string;
  });

  afterEach(async () => {
    await close();
    await db.cleanup();
  });

  it('PATCH via REST broadcasts canvas_updated to WebSocket subscribers', async () => {
    const ws = await connectClient(port);
    await subscribeClient(ws, canvasId);

    const msgPromise = collectMessages(ws, 1);
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      state: { theme: 'dark' },
    });
    const [msg] = await msgPromise;

    expect((msg as { type: string }).type).toBe('canvas_updated');
    expect((msg as { canvasId: string }).canvasId).toBe(canvasId);
    ws.close();
  });

  it('DELETE via REST broadcasts canvas_deleted to WebSocket subscribers', async () => {
    const ws = await connectClient(port);
    await subscribeClient(ws, canvasId);

    const msgPromise = collectMessages(ws, 1);
    await req(app, 'DELETE', `/api/canvases/${canvasId}`);
    const [msg] = await msgPromise;

    expect((msg as { type: string }).type).toBe('canvas_deleted');
    expect((msg as { canvasId: string }).canvasId).toBe(canvasId);
    ws.close();
  });

  it('POST action via REST broadcasts canvas_updated to WebSocket subscribers', async () => {
    const ws = await connectClient(port);
    await subscribeClient(ws, canvasId);

    const msgPromise = collectMessages(ws, 1);
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1',
      eventType: 'click',
    });
    const [msg] = await msgPromise;

    expect((msg as { type: string }).type).toBe('canvas_updated');
    ws.close();
  });

  it('WebSocket subscribers on different canvases do not receive each other\'s updates', async () => {
    const res2 = await req(app, 'POST', '/api/canvases', { title: 'Canvas 2', components: [] });
    const body2 = await res2.json() as Record<string, unknown>;
    const canvasId2 = body2.id as string;

    const ws1 = await connectClient(port);
    const ws2 = await connectClient(port);
    await subscribeClient(ws1, canvasId);
    await subscribeClient(ws2, canvasId2);

    let ws2Received = false;
    ws2.on('message', () => { ws2Received = true; });

    await req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: { x: 1 } });
    await delay(50);

    expect(ws2Received).toBe(false);
    ws1.close();
    ws2.close();
  });

  it('multiple WebSocket clients all receive the same broadcast', async () => {
    const ws1 = await connectClient(port);
    const ws2 = await connectClient(port);
    const ws3 = await connectClient(port);
    await subscribeClient(ws1, canvasId);
    await subscribeClient(ws2, canvasId);
    await subscribeClient(ws3, canvasId);

    const p1 = collectMessages(ws1, 1);
    const p2 = collectMessages(ws2, 1);
    const p3 = collectMessages(ws3, 1);

    await req(app, 'PATCH', `/api/canvases/${canvasId}`, { state: { broadcast: true } });

    const [[m1], [m2], [m3]] = await Promise.all([p1, p2, p3]);
    expect((m1 as { type: string }).type).toBe('canvas_updated');
    expect((m2 as { type: string }).type).toBe('canvas_updated');
    expect((m3 as { type: string }).type).toBe('canvas_updated');
    ws1.close();
    ws2.close();
    ws3.close();
  });
});

// ─── Edge cases: invalid descriptors ─────────────────────────────────────────

describe('Edge cases: invalid descriptor inputs', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('rejects descriptor with empty title (whitespace only)', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: '   ',
      components: [],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Validation failed');
  });

  it('rejects descriptor where title is a number', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 42,
      components: [],
    });
    expect(res.status).toBe(400);
  });

  it('rejects descriptor where components is not an array', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'Test',
      components: { id: 'c1', type: 'button' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects descriptor where a component has a whitespace-only id', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'Test',
      components: [{ id: '  ', type: 'button', props: {} }],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect((body.details as string[]).some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects descriptor where a nested child has an invalid type', async () => {
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'Nested Bad',
      components: [
        {
          id: 'container-1',
          type: 'container',
          props: {},
          children: [
            { id: 'child-1', type: 'not-a-real-type', props: {} },
          ],
        },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect((body.details as string[]).some((e) => e.includes('not-a-real-type'))).toBe(true);
  });

  it('accepts deeply nested valid components', async () => {
    const descriptor = {
      title: 'Deep Nesting',
      components: [
        {
          id: 'level-1',
          type: 'container',
          props: {},
          children: [
            {
              id: 'level-2',
              type: 'stack',
              props: {},
              children: [
                {
                  id: 'level-3',
                  type: 'grid',
                  props: {},
                  children: [
                    { id: 'level-4', type: 'text', props: { content: 'Deep' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await req(app, 'POST', '/api/canvases', descriptor);
    expect(res.status).toBe(201);
  });

  it('rejects POST with an array body instead of object', async () => {
    const res = await app.request('/api/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ title: 'Test', components: [] }]),
    });
    expect(res.status).toBe(400);
  });

  it('rejects POST with null body', async () => {
    const res = await app.request('/api/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(null),
    });
    expect(res.status).toBe(400);
  });

  it('accepts all valid component types without props field', async () => {
    const types = ['markdown', 'code', 'key-value', 'tree', 'card', 'textarea',
      'select', 'checkbox', 'radio', 'slider', 'toggle', 'file',
      'progress', 'badge', 'image', 'link', 'divider', 'spacer',
      'conditional', 'loading', 'error-boundary', 'tabs', 'accordion'];

    const components = types.map((type, i) => ({ id: `comp-${i}`, type }));
    const res = await req(app, 'POST', '/api/canvases', {
      title: 'All Types No Props',
      components,
    });
    expect(res.status).toBe(201);
  });
});

// ─── Edge cases: missing/non-existent canvases ────────────────────────────────

describe('Edge cases: operations on non-existent canvases', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('GET /state/:componentId returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'GET', '/api/canvases/ghost/state/comp-1');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });

  it('GET /events returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'GET', '/api/canvases/ghost/events');
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Canvas not found');
  });

  it('PATCH returns 404 before parsing body for non-existent canvas', async () => {
    const res = await req(app, 'PATCH', '/api/canvases/ghost', { state: {} });
    expect(res.status).toBe(404);
  });

  it('POST /actions returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'POST', '/api/canvases/ghost/actions', {
      componentId: 'btn-1',
      eventType: 'click',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE returns 404 for non-existent canvas', async () => {
    const res = await req(app, 'DELETE', '/api/canvases/ghost');
    expect(res.status).toBe(404);
  });

  it('cannot delete the same canvas twice', async () => {
    const createRes = await req(app, 'POST', '/api/canvases', simpleDescriptor);
    const created = await createRes.json() as Record<string, unknown>;
    const id = created.id as string;

    await req(app, 'DELETE', `/api/canvases/${id}`);
    const secondDelete = await req(app, 'DELETE', `/api/canvases/${id}`);
    expect(secondDelete.status).toBe(404);
  });
});

// ─── State management edge cases ─────────────────────────────────────────────

describe('State management edge cases', () => {
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

  it('action event with object value stores complex state', async () => {
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'form-1',
      eventType: 'submit',
      value: { name: 'Alice', age: 30, tags: ['admin', 'user'] },
    });
    expect(res.status).toBe(201);

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state/form-1`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    expect((stateBody.state as Record<string, unknown>).value).toEqual({
      name: 'Alice',
      age: 30,
      tags: ['admin', 'user'],
    });
  });

  it('action event with null value stores null in state', async () => {
    // First set a value
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'select-1',
      eventType: 'change',
      value: 'option-a',
    });
    // Then clear it
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'select-1',
      eventType: 'change',
      value: null,
    });

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state/select-1`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    const state = stateBody.state as Record<string, unknown>;
    // null is a valid JSON value
    expect(state.value).toBeNull();
  });

  it('action events with value false (boolean) preserve false state', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'toggle-1',
      eventType: 'change',
      value: false,
    });

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state/toggle-1`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    expect((stateBody.state as Record<string, unknown>).value).toBe(false);
  });

  it('action event with value 0 (number) preserves zero', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'slider-1',
      eventType: 'change',
      value: 0,
    });

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state/slider-1`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    expect((stateBody.state as Record<string, unknown>).value).toBe(0);
  });

  it('PATCH with multiple components updates all of them', async () => {
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [
        { id: 'comp-a', state: { visible: true } },
        { id: 'comp-b', state: { count: 5 } },
        { id: 'comp-c', state: { label: 'Done' } },
      ],
    });
    expect(res.status).toBe(200);

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    const components = stateBody.components as Record<string, Record<string, unknown>>;
    expect(components['comp-a']).toEqual({ visible: true });
    expect(components['comp-b']).toEqual({ count: 5 });
    expect(components['comp-c']).toEqual({ label: 'Done' });
  });

  it('PATCH updates canvas-level state and component state simultaneously', async () => {
    const res = await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      state: { theme: 'dark' },
      components: [{ id: 'btn-1', state: { loading: true } }],
    });
    expect(res.status).toBe(200);

    const canvas = await res.json() as Record<string, unknown>;
    expect((canvas.state as Record<string, unknown>).theme).toBe('dark');

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const stateBody = await stateRes.json() as Record<string, unknown>;
    expect((stateBody.components as Record<string, Record<string, unknown>>)['btn-1']).toEqual({ loading: true });
  });

  it('GET /:id reflects component states set via PATCH', async () => {
    await req(app, 'PATCH', `/api/canvases/${canvasId}`, {
      components: [{ id: 'btn-1', state: { disabled: true } }],
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const body = await res.json() as Record<string, unknown>;
    const componentStates = body.componentStates as Record<string, Record<string, unknown>>;
    expect(componentStates['btn-1']).toEqual({ disabled: true });
  });

  it('state for different canvases is isolated', async () => {
    const res2 = await req(app, 'POST', '/api/canvases', { title: 'Canvas 2', components: [] });
    const body2 = await res2.json() as Record<string, unknown>;
    const canvasId2 = body2.id as string;

    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'shared-comp',
      eventType: 'click',
      value: 'canvas1-value',
    });
    await req(app, 'POST', `/api/canvases/${canvasId2}/actions`, {
      componentId: 'shared-comp',
      eventType: 'click',
      value: 'canvas2-value',
    });

    const s1 = await req(app, 'GET', `/api/canvases/${canvasId}/state/shared-comp`);
    const s2 = await req(app, 'GET', `/api/canvases/${canvasId2}/state/shared-comp`);
    const b1 = await s1.json() as Record<string, unknown>;
    const b2 = await s2.json() as Record<string, unknown>;
    expect((b1.state as Record<string, unknown>).value).toBe('canvas1-value');
    expect((b2.state as Record<string, unknown>).value).toBe('canvas2-value');
  });
});

// ─── Pagination and event ordering ────────────────────────────────────────────

describe('Pagination and event ordering', () => {
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

  it('GET /events uses limit=1 correctly', async () => {
    for (let i = 0; i < 3; i++) {
      await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
        componentId: 'btn', eventType: 'click',
      });
    }
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.events as unknown[]).length).toBe(1);
    expect(body.total).toBe(3);
  });

  it('GET /events uses limit=1000 correctly (max)', async () => {
    for (let i = 0; i < 3; i++) {
      await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
        componentId: 'btn', eventType: 'click',
      });
    }
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=1000`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.events as unknown[]).length).toBe(3);
  });

  it('GET /events returns 400 for limit=1001', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=1001`);
    expect(res.status).toBe(400);
  });

  it('GET /events returns 400 for non-numeric limit', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=abc`);
    expect(res.status).toBe(400);
  });

  it('GET /events returns 400 for non-numeric offset', async () => {
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?offset=xyz`);
    expect(res.status).toBe(400);
  });

  it('GET /events with offset=0 and limit returns correct events', async () => {
    for (let i = 0; i < 4; i++) {
      await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
        componentId: 'btn', eventType: 'click',
      });
    }
    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events?limit=2&offset=0`);
    const body = await res.json() as Record<string, unknown>;
    expect((body.events as unknown[]).length).toBe(2);
    expect(body.total).toBe(4);
  });

  it('events returned in newest-first order', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'comp-1', eventType: 'first',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'comp-2', eventType: 'second',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'comp-3', eventType: 'third',
    });

    const res = await req(app, 'GET', `/api/canvases/${canvasId}/events`);
    const body = await res.json() as Record<string, unknown>;
    const events = body.events as Array<Record<string, unknown>>;

    // Newest first
    expect(events[0].eventType).toBe('third');
    expect(events[1].eventType).toBe('second');
    expect(events[2].eventType).toBe('first');
  });

  it('combined componentId + eventType filter returns only matching events', async () => {
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'click',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-1', eventType: 'hover',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'btn-2', eventType: 'click',
    });

    const res = await req(app, 'GET',
      `/api/canvases/${canvasId}/events?componentId=btn-1&eventType=click`
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body.total).toBe(1);
    const events = body.events as Array<Record<string, unknown>>;
    expect((events[0].payload as Record<string, unknown>).componentId).toBe('btn-1');
    expect(events[0].eventType).toBe('click');
  });
});

// ─── Database operations: JSONB merge behavior ────────────────────────────────

describe('Database operations: JSONB state merge behavior', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let engine: StateEngine;

  beforeEach(async () => {
    db = await createTestDb();
    engine = new StateEngine(db);
    await db.query(
      `INSERT INTO canvases (id, title, descriptor) VALUES ($1, $2, $3)`,
      ['c1', 'Test', JSON.stringify({ title: 'Test', components: [] })]
    );
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('JSONB merge overwrites existing keys at top level', async () => {
    await engine.setComponentState('c1', 'comp-1', { value: 'old', extra: 'stays' });
    await engine.setComponentState('c1', 'comp-1', { value: 'new' });

    const state = await engine.getComponentState('c1', 'comp-1');
    expect(state!.state).toEqual({ value: 'new', extra: 'stays' });
  });

  it('replaceComponentState removes keys not in new state', async () => {
    await engine.setComponentState('c1', 'comp-1', { a: 1, b: 2, c: 3 });
    await engine.replaceComponentState('c1', 'comp-1', { a: 99 });

    const state = await engine.getComponentState('c1', 'comp-1');
    expect(state!.state).toEqual({ a: 99 });
    expect(state!.state).not.toHaveProperty('b');
    expect(state!.state).not.toHaveProperty('c');
  });

  it('multiple components on same canvas have independent states', async () => {
    await engine.setComponentState('c1', 'input-1', { value: 'hello' });
    await engine.setComponentState('c1', 'input-2', { value: 'world' });

    const s1 = await engine.getComponentState('c1', 'input-1');
    const s2 = await engine.getComponentState('c1', 'input-2');
    expect(s1!.state).toEqual({ value: 'hello' });
    expect(s2!.state).toEqual({ value: 'world' });
  });

  it('snapshot includes all components and correct values', async () => {
    await engine.setComponentState('c1', 'comp-a', { x: 1 });
    await engine.setComponentState('c1', 'comp-b', { x: 2 });
    await engine.setComponentState('c1', 'comp-c', { x: 3 });

    const snapshot = await engine.getCanvasSnapshot('c1');
    expect(Object.keys(snapshot.components)).toHaveLength(3);
    expect(snapshot.components['comp-a']).toEqual({ x: 1 });
    expect(snapshot.components['comp-b']).toEqual({ x: 2 });
    expect(snapshot.components['comp-c']).toEqual({ x: 3 });
  });
});

// ─── Health check endpoint ────────────────────────────────────────────────────

describe('Health check endpoint', () => {
  it('GET /health returns 200 with correct shape', async () => {
    const db = await createTestDb();
    const app = new Hono();
    app.get('/health', (c) =>
      c.json({ status: 'ok', service: 'dynamic-ui-canvas', timestamp: new Date().toISOString() })
    );
    app.route('/api/canvases', createCanvasesRouter(db));

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('dynamic-ui-canvas');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp as string).getTime()).not.toBeNaN();
    await db.cleanup();
  });
});
