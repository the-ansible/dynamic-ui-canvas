/**
 * Integration tests for component-level REST API endpoints.
 *
 * Tests POST /:id/components, PATCH /:id/components/:componentId,
 * and DELETE /:id/components/:componentId.
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

// Helper to create a canvas and return its ID
async function createCanvas(app: Hono, descriptor: object): Promise<string> {
  const res = await req(app, 'POST', '/api/canvases', descriptor);
  const body = (await res.json()) as Record<string, unknown>;
  return body.id as string;
}

// ─── Sample descriptors ─────────────────────────────────────────────────────

const formDescriptor = {
  title: 'Form Canvas',
  components: [
    {
      id: 'form-1',
      type: 'form',
      props: { submitLabel: 'Submit' },
      children: [
        {
          id: 'input-name',
          type: 'input',
          props: { label: 'Name', required: true },
        },
        {
          id: 'input-email',
          type: 'input',
          props: { label: 'Email', inputType: 'email' },
        },
      ],
    },
    {
      id: 'btn-submit',
      type: 'button',
      props: { label: 'Submit' },
    },
  ],
};

// ─── POST /api/canvases/:id/components (add_component) ─────────────────────

describe('POST /api/canvases/:id/components', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('adds a component to the top-level components array', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const newComponent = {
      id: 'text-footer',
      type: 'text',
      props: { content: 'Footer text' },
    };
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: newComponent,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.added).toMatchObject(newComponent);

    // Verify the component is in the descriptor
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const components = descriptor.components as Array<Record<string, unknown>>;
    expect(components).toHaveLength(3);
    expect(components[2]).toMatchObject(newComponent);
  });

  it('adds a component nested under a parent', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const newInput = {
      id: 'input-phone',
      type: 'input',
      props: { label: 'Phone', inputType: 'tel' },
    };
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: newInput,
      parentId: 'form-1',
    });

    expect(res.status).toBe(201);

    // Verify it's nested under form-1
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const components = descriptor.components as Array<Record<string, unknown>>;
    const form = components[0];
    const children = form.children as Array<Record<string, unknown>>;
    expect(children).toHaveLength(3);
    expect(children[2]).toMatchObject(newInput);
  });

  it('inserts a component at a specific position', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const newComponent = {
      id: 'heading-top',
      type: 'heading',
      props: { level: 1, text: 'Form Title' },
    };
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: newComponent,
      position: 0,
    });

    expect(res.status).toBe(201);

    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const components = descriptor.components as Array<Record<string, unknown>>;
    expect(components[0]).toMatchObject(newComponent);
  });

  it('inserts at a specific position under a parent', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const newInput = {
      id: 'input-middle',
      type: 'input',
      props: { label: 'Middle Field' },
    };
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: newInput,
      parentId: 'form-1',
      position: 1,
    });

    expect(res.status).toBe(201);

    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const form = (descriptor.components as Array<Record<string, unknown>>)[0];
    const children = form.children as Array<Record<string, unknown>>;
    expect(children[1]).toMatchObject(newInput);
    expect(children).toHaveLength(3);
  });

  it('returns 409 for duplicate component ID', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const duplicate = {
      id: 'btn-submit',
      type: 'text',
      props: { content: 'dup' },
    };
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: duplicate,
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain('already exists');
  });

  it('returns 404 for nonexistent canvas', async () => {
    const res = await req(app, 'POST', '/api/canvases/nonexistent/components', {
      component: { id: 'x', type: 'text', props: {} },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for nonexistent parent', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: { id: 'new-1', type: 'text', props: {} },
      parentId: 'nonexistent-parent',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for missing component field', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {});
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid component (missing type)', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: { id: 'no-type' },
    });
    expect(res.status).toBe(400);
  });

  it('detects duplicate IDs in nested children', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    // input-name exists nested inside form-1
    const res = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: { id: 'input-name', type: 'text', props: {} },
    });
    expect(res.status).toBe(409);
  });
});

// ─── PATCH /api/canvases/:id/components/:componentId (update_component) ─────

describe('PATCH /api/canvases/:id/components/:componentId', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('merges props into an existing component', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/input-name`,
      { props: { placeholder: 'Enter your name', required: false } }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const updated = body.updated as Record<string, unknown>;
    const props = updated.props as Record<string, unknown>;
    // Original prop preserved, new ones merged
    expect(props.label).toBe('Name');
    expect(props.placeholder).toBe('Enter your name');
    expect(props.required).toBe(false);
  });

  it('merges style into an existing component', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/btn-submit`,
      { style: { backgroundColor: 'red', padding: '8px' } }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const updated = body.updated as Record<string, unknown>;
    const style = updated.style as Record<string, unknown>;
    expect(style.backgroundColor).toBe('red');
    expect(style.padding).toBe('8px');
  });

  it('replaces children array', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const newChildren = [
      { id: 'new-child-1', type: 'text', props: { content: 'Only child' } },
    ];
    const res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/form-1`,
      { children: newChildren }
    );

    expect(res.status).toBe(200);

    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const form = (descriptor.components as Array<Record<string, unknown>>)[0];
    expect(form.children).toHaveLength(1);
    expect((form.children as Array<Record<string, unknown>>)[0].id).toBe('new-child-1');
  });

  it('replaces events array', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const newEvents = [{ type: 'click', action: 'navigate' }];
    const res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/btn-submit`,
      { events: newEvents }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const updated = body.updated as Record<string, unknown>;
    expect(updated.events).toEqual(newEvents);
  });

  it('updates a deeply nested component', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    // input-name is nested under form-1
    const res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/input-name`,
      { props: { label: 'Full Name' } }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const updated = body.updated as Record<string, unknown>;
    expect((updated.props as Record<string, unknown>).label).toBe('Full Name');
  });

  it('returns 404 for nonexistent component', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/nonexistent`,
      { props: { label: 'test' } }
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for nonexistent canvas', async () => {
    const res = await req(
      app,
      'PATCH',
      '/api/canvases/nonexistent/components/btn-1',
      { props: { label: 'test' } }
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when no update fields provided', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/btn-submit`,
      {}
    );
    expect(res.status).toBe(400);
  });

  it('persists changes to the database', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/btn-submit`,
      { props: { label: 'Updated Button' } }
    );

    // Fetch fresh from DB
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const components = descriptor.components as Array<Record<string, unknown>>;
    const btn = components[1];
    expect((btn.props as Record<string, unknown>).label).toBe('Updated Button');
  });
});

// ─── DELETE /api/canvases/:id/components/:componentId (remove_component) ────

describe('DELETE /api/canvases/:id/components/:componentId', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('removes a top-level component', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(
      app,
      'DELETE',
      `/api/canvases/${canvasId}/components/btn-submit`
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.removed as Record<string, unknown>).id).toBe('btn-submit');

    // Verify it's gone
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const components = descriptor.components as Array<Record<string, unknown>>;
    expect(components).toHaveLength(1);
    expect(components[0].id).toBe('form-1');
  });

  it('removes a nested component', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(
      app,
      'DELETE',
      `/api/canvases/${canvasId}/components/input-email`
    );

    expect(res.status).toBe(200);

    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const form = (descriptor.components as Array<Record<string, unknown>>)[0];
    const children = form.children as Array<Record<string, unknown>>;
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe('input-name');
  });

  it('cleans up component state on removal', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    // Set some component state first via action
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-name',
      eventType: 'change',
      value: 'John',
    });

    // Verify state exists
    const stateRes = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/state/input-name`
    );
    expect(stateRes.status).toBe(200);

    // Remove the component
    await req(app, 'DELETE', `/api/canvases/${canvasId}/components/input-name`);

    // Verify state is cleaned up
    const stateRes2 = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/state/input-name`
    );
    expect(stateRes2.status).toBe(404);
  });

  it('returns 404 for nonexistent component', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    const res = await req(
      app,
      'DELETE',
      `/api/canvases/${canvasId}/components/nonexistent`
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for nonexistent canvas', async () => {
    const res = await req(
      app,
      'DELETE',
      '/api/canvases/nonexistent/components/btn-1'
    );
    expect(res.status).toBe(404);
  });

  it('preserves other components when removing one', async () => {
    const canvasId = await createCanvas(app, formDescriptor);

    await req(app, 'DELETE', `/api/canvases/${canvasId}/components/btn-submit`);

    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const components = descriptor.components as Array<Record<string, unknown>>;
    expect(components).toHaveLength(1);
    const form = components[0];
    expect(form.id).toBe('form-1');
    expect((form.children as unknown[]).length).toBe(2);
  });
});

// ─── Combined workflow tests ────────────────────────────────────────────────

describe('Component-level workflow', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('add → update → get_state → remove lifecycle', async () => {
    const canvasId = await createCanvas(app, {
      title: 'Lifecycle Test',
      components: [
        { id: 'heading-1', type: 'heading', props: { level: 1, text: 'Hello' } },
      ],
    });

    // Add a new input
    const addRes = await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: {
        id: 'input-1',
        type: 'input',
        props: { label: 'Name', required: true },
      },
    });
    expect(addRes.status).toBe(201);

    // Update its props
    const updateRes = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/input-1`,
      { props: { placeholder: 'Enter name' } }
    );
    expect(updateRes.status).toBe(200);

    // Simulate user input via action
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'input-1',
      eventType: 'change',
      value: 'Alice',
    });

    // Read the component state
    const stateRes = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/state/input-1`
    );
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as Record<string, unknown>;
    expect((state.state as Record<string, unknown>).value).toBe('Alice');

    // Remove the component
    const removeRes = await req(
      app,
      'DELETE',
      `/api/canvases/${canvasId}/components/input-1`
    );
    expect(removeRes.status).toBe(200);

    // Verify it's gone from descriptor
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    expect(descriptor.components).toHaveLength(1);
  });

  it('can add multiple components and reorder via position', async () => {
    const canvasId = await createCanvas(app, {
      title: 'Position Test',
      components: [
        { id: 'a', type: 'text', props: { content: 'A' } },
        { id: 'c', type: 'text', props: { content: 'C' } },
      ],
    });

    // Insert B between A and C at position 1
    await req(app, 'POST', `/api/canvases/${canvasId}/components`, {
      component: { id: 'b', type: 'text', props: { content: 'B' } },
      position: 1,
    });

    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const canvas = (await getRes.json()) as Record<string, unknown>;
    const descriptor = canvas.descriptor as Record<string, unknown>;
    const ids = (descriptor.components as Array<Record<string, unknown>>).map(
      (c) => c.id
    );
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
