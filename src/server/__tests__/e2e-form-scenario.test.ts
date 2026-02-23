/**
 * E2E Scenario 1: Form canvas for collecting user preferences.
 *
 * Flow:
 *   1. Jane creates a form canvas (name, favorite color, notification toggle)
 *   2. User fills out the form fields (simulated via action events)
 *   3. User submits the form
 *   4. Jane polls for the submission event and reads the submitted values
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

// ─── Form descriptor: user preferences ───────────────────────────────────────

const userPreferencesDescriptor = {
  title: 'User Preferences',
  components: [
    {
      id: 'prefs-container',
      type: 'container',
      props: { direction: 'column', gap: '16px' },
      children: [
        {
          id: 'prefs-heading',
          type: 'heading',
          props: { content: 'Your Preferences', level: 2 },
        },
        {
          id: 'prefs-form',
          type: 'form',
          props: { validateOnBlur: true },
          children: [
            {
              id: 'field-name',
              type: 'input',
              props: {
                name: 'name',
                label: 'Name',
                placeholder: 'Enter your name',
                required: true,
                inputType: 'text',
              },
            },
            {
              id: 'field-color',
              type: 'select',
              props: {
                name: 'favoriteColor',
                label: 'Favorite Color',
                required: true,
                options: [
                  { value: 'red', label: 'Red' },
                  { value: 'blue', label: 'Blue' },
                  { value: 'green', label: 'Green' },
                  { value: 'purple', label: 'Purple' },
                ],
              },
            },
            {
              id: 'field-notifications',
              type: 'toggle',
              props: {
                name: 'notifications',
                label: 'Enable notifications',
              },
            },
            {
              id: 'submit-btn',
              type: 'button',
              props: { label: 'Save Preferences', variant: 'primary' },
              events: [
                {
                  type: 'click',
                  action: { type: 'callback', callbackId: 'submitPreferences' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ─── E2E Test ────────────────────────────────────────────────────────────────

describe('E2E Scenario 1: User preferences form', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('full flow: create form → fill fields → submit → Jane reads values', async () => {
    // ── Step 1: Jane creates the form canvas ──────────────────────────────

    const createRes = await req(app, 'POST', '/api/canvases', userPreferencesDescriptor);
    expect(createRes.status).toBe(201);

    const canvas = await createRes.json();
    expect(canvas.id).toBeDefined();
    expect(canvas.title).toBe('User Preferences');

    const canvasId = canvas.id;

    // ── Step 2: User fills out the form fields ────────────────────────────

    // User types their name
    const nameRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-name',
      eventType: 'change',
      value: 'Alice Johnson',
    });
    expect(nameRes.status).toBe(201);

    // User selects favorite color
    const colorRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-color',
      eventType: 'change',
      value: 'purple',
    });
    expect(colorRes.status).toBe(201);

    // User toggles notifications on
    const toggleRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-notifications',
      eventType: 'change',
      value: true,
    });
    expect(toggleRes.status).toBe(201);

    // ── Step 3: User submits the form ─────────────────────────────────────

    const submitRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'submit-btn',
      eventType: 'click',
      metadata: { callbackId: 'submitPreferences' },
    });
    expect(submitRes.status).toBe(201);

    const submitEvent = await submitRes.json();
    expect(submitEvent.id).toBeDefined();
    expect(submitEvent.event_type).toBe('click');

    // ── Step 4: Jane polls for the submission event ───────────────────────

    const pendingRes = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    expect(pendingRes.status).toBe(200);

    const pending = await pendingRes.json();
    expect(pending.events.length).toBe(1);
    expect(pending.events[0].eventType).toBe('click');
    expect(pending.events[0].payload.componentId).toBe('submit-btn');
    expect(pending.events[0].payload.metadata.callbackId).toBe('submitPreferences');

    // ── Step 5: Jane reads the submitted form values ──────────────────────

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    expect(stateRes.status).toBe(200);

    const snapshot = await stateRes.json();

    // Verify all three field values are correctly stored
    expect(snapshot.components['field-name']).toBeDefined();
    expect(snapshot.components['field-name'].value).toBe('Alice Johnson');

    expect(snapshot.components['field-color']).toBeDefined();
    expect(snapshot.components['field-color'].value).toBe('purple');

    expect(snapshot.components['field-notifications']).toBeDefined();
    expect(snapshot.components['field-notifications'].value).toBe(true);

    // Verify form validity (both required fields are filled)
    expect(snapshot.formValidity['prefs-form']).toBe(true);

    // ── Step 6: Jane acknowledges the event ───────────────────────────────

    const ackRes = await req(
      app,
      'POST',
      `/api/canvases/${canvasId}/events/${pending.events[0].id}/acknowledge`
    );
    expect(ackRes.status).toBe(200);
    const ackBody = await ackRes.json();
    expect(ackBody.acknowledged).toBe(true);

    // Verify no more pending events
    const pendingAfterRes = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    expect(pendingAfterRes.status).toBe(200);
    const pendingAfter = await pendingAfterRes.json();
    expect(pendingAfter.events.length).toBe(0);
  });

  it('Jane can read individual component state', async () => {
    // Create canvas
    const createRes = await req(app, 'POST', '/api/canvases', userPreferencesDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // User fills in name
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-name',
      eventType: 'change',
      value: 'Bob Smith',
    });

    // Jane reads just the name component state
    const nameStateRes = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/state/field-name`
    );
    expect(nameStateRes.status).toBe(200);

    const nameState = await nameStateRes.json();
    expect(nameState.state.value).toBe('Bob Smith');
  });

  it('form validity is false when required fields are empty', async () => {
    // Create canvas
    const createRes = await req(app, 'POST', '/api/canvases', userPreferencesDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // Only fill the name field (color is also required but left empty)
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-name',
      eventType: 'change',
      value: 'Alice',
    });

    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const snapshot = await stateRes.json();

    // Form should be invalid because field-color (required) is not filled
    expect(snapshot.formValidity['prefs-form']).toBe(false);
  });

  it('event history records all user interactions in order', async () => {
    // Create canvas
    const createRes = await req(app, 'POST', '/api/canvases', userPreferencesDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // Simulate user filling out and submitting
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-name',
      eventType: 'change',
      value: 'Charlie',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-color',
      eventType: 'change',
      value: 'green',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'submit-btn',
      eventType: 'click',
      metadata: { callbackId: 'submitPreferences' },
    });

    // Jane reads the full event history
    const eventsRes = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events`
    );
    expect(eventsRes.status).toBe(200);

    const history = await eventsRes.json();
    expect(history.events.length).toBe(3);

    // Events are returned newest-first (DESC order)
    expect(history.events[0].payload.componentId).toBe('submit-btn');
    expect(history.events[0].eventType).toBe('click');
    expect(history.events[1].payload.componentId).toBe('field-color');
    expect(history.events[1].eventType).toBe('change');
    expect(history.events[2].payload.componentId).toBe('field-name');
    expect(history.events[2].eventType).toBe('change');
  });
});
