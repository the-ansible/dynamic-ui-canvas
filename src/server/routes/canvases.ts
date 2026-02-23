/**
 * Canvas REST API route handlers.
 *
 * Endpoints:
 *   POST   /api/canvases                        - Create canvas from descriptor
 *   GET    /api/canvases                        - List active canvases
 *   GET    /api/canvases/:id                    - Get full canvas with state
 *   PATCH  /api/canvases/:id                    - Update descriptor or specific components
 *   DELETE /api/canvases/:id                    - Delete canvas and all related data
 *   POST   /api/canvases/:id/actions            - Receive user action event from frontend
 *   GET    /api/canvases/:id/state              - Get current state of all interactive components
 *   GET    /api/canvases/:id/state/:componentId - Get state for a single component
 *   GET    /api/canvases/:id/events             - Get event history (audit log)
 *   GET    /api/canvases/:id/events/pending     - Get unacknowledged events
 *   POST   /api/canvases/:id/events/:eventId/acknowledge - Acknowledge single event
 *   POST   /api/canvases/:id/events/acknowledge - Acknowledge multiple events
 */

import { Hono } from 'hono';
import type { DbClient } from '../db.js';
import { validateDescriptor, validatePatchBody, validateActionEvent, validateComponentNode, validateComponentUpdate } from '../validation.js';
import type { CanvasWebSocketManager } from '../ws.js';
import { StateEngine } from '../state-engine.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CanvasRow {
  id: string;
  title: string;
  descriptor: object;
  state: object;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Router factory ──────────────────────────────────────────────────────────

/**
 * Creates a Hono router for canvas endpoints using the provided database client.
 * Accepts a db parameter to support both production (file-based) and test (in-memory) databases.
 * Optionally accepts a CanvasWebSocketManager to broadcast real-time updates on mutations.
 */
export function createCanvasesRouter(db: DbClient, wsManager?: CanvasWebSocketManager): Hono {
  const router = new Hono();
  const stateEngine = new StateEngine(db);

  /**
   * POST /
   * Create a new canvas from a descriptor.
   */
  router.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const validation = validateDescriptor(body);
    if (!validation.valid) {
      return c.json({ error: 'Validation failed', details: validation.errors }, 400);
    }

    const descriptor = body as Record<string, unknown>;
    const id = generateId();
    const title = descriptor.title as string;

    await db.query(
      `INSERT INTO canvases (id, title, descriptor, state, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, title, JSON.stringify(descriptor)]
    );

    const result = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [id]
    );

    return c.json(result.rows[0], 201);
  });

  /**
   * GET /
   * List all canvases (summary — no full descriptor or component state).
   */
  router.get('/', async (c) => {
    const result = await db.query<Pick<CanvasRow, 'id' | 'title' | 'created_at' | 'updated_at'>>(
      `SELECT id, title, created_at, updated_at FROM canvases ORDER BY created_at DESC`
    );
    return c.json(result.rows);
  });

  /**
   * GET /:id
   * Get a full canvas including descriptor, canvas-level state, and per-component states.
   */
  router.get('/:id', async (c) => {
    const id = c.req.param('id');

    const canvasResult = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [id]
    );

    if (canvasResult.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    const canvas = canvasResult.rows[0];
    const snapshot = await stateEngine.getCanvasSnapshot(
      id,
      canvas.descriptor as Record<string, unknown>
    );

    return c.json({
      ...canvas,
      componentStates: snapshot.components,
      formValidity: snapshot.formValidity,
    });
  });

  /**
   * PATCH /:id
   * Update a canvas. Supports replacing the descriptor, merging canvas-level state,
   * and patching individual component states.
   */
  router.patch('/:id', async (c) => {
    const id = c.req.param('id');

    const existing = await db.query<CanvasRow>(
      `SELECT id FROM canvases WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const validation = validatePatchBody(body);
    if (!validation.valid) {
      return c.json({ error: 'Validation failed', details: validation.errors }, 400);
    }

    const patch = body as Record<string, unknown>;

    // Replace full descriptor if provided
    if ('descriptor' in patch) {
      await db.query(
        `UPDATE canvases SET descriptor = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(patch.descriptor), id]
      );
    }

    // Merge canvas-level state if provided
    if ('state' in patch) {
      await db.query(
        `UPDATE canvases SET state = state || $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(patch.state), id]
      );
    }

    // Bump updated_at if only components were provided
    if (!('descriptor' in patch) && !('state' in patch) && 'components' in patch) {
      await db.query(
        `UPDATE canvases SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );
    }

    // Upsert per-component state via StateEngine
    if ('components' in patch && Array.isArray(patch.components)) {
      for (const cp of patch.components as Array<Record<string, unknown>>) {
        if ('state' in cp) {
          await stateEngine.setComponentState(
            id,
            cp.id as string,
            cp.state as Record<string, unknown>
          );
        }
      }
    }

    const updated = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [id]
    );

    wsManager?.broadcastCanvasUpdate(id, updated.rows[0]);

    return c.json(updated.rows[0]);
  });

  /**
   * DELETE /:id
   * Delete a canvas and all related events and component state (via CASCADE).
   */
  router.delete('/:id', async (c) => {
    const id = c.req.param('id');

    const existing = await db.query<{ id: string }>(
      `SELECT id FROM canvases WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    await db.query(`DELETE FROM canvases WHERE id = $1`, [id]);

    wsManager?.broadcastCanvasDeleted(id);

    return c.json({ deleted: true, id });
  });

  /**
   * POST /:id/actions
   * Receive a user action event from the frontend.
   * Delegates to StateEngine for persistence and state update.
   */
  router.post('/:id/actions', async (c) => {
    const canvasId = c.req.param('id');

    const canvasCheck = await db.query<{ id: string }>(
      `SELECT id FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasCheck.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const validation = validateActionEvent(body);
    if (!validation.valid) {
      return c.json({ error: 'Validation failed', details: validation.errors }, 400);
    }

    const action = body as Record<string, unknown>;

    const eventId = await stateEngine.applyAction(
      canvasId,
      action.componentId as string,
      action.eventType as string,
      'value' in action ? action.value : undefined,
      'metadata' in action ? (action.metadata as Record<string, unknown>) : undefined
    );

    // Fetch the persisted event to return it
    const eventResult = await db.query<{
      id: string;
      canvas_id: string;
      event_type: string;
      payload: object;
      created_at: string;
    }>(
      `SELECT id, canvas_id, event_type, payload, created_at FROM canvas_events WHERE id = $1`,
      [eventId]
    );

    const event = eventResult.rows[0];

    // Broadcast the action event to all clients subscribed to this canvas
    wsManager?.broadcastCanvasUpdate(canvasId, {
      event,
      componentId: action.componentId,
      ...(('value' in action) ? { value: action.value } : {}),
    });

    return c.json(event, 201);
  });

  /**
   * GET /:id/state
   * Get a full snapshot of all component states for a canvas.
   * Includes formValidity derived state.
   */
  router.get('/:id/state', async (c) => {
    const id = c.req.param('id');

    const canvasCheck = await db.query<CanvasRow>(
      `SELECT id, descriptor FROM canvases WHERE id = $1`,
      [id]
    );
    if (canvasCheck.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    const snapshot = await stateEngine.getCanvasSnapshot(
      id,
      canvasCheck.rows[0].descriptor as Record<string, unknown>
    );

    return c.json(snapshot);
  });

  /**
   * GET /:id/state/:componentId
   * Get current state for a single component.
   */
  router.get('/:id/state/:componentId', async (c) => {
    const canvasId = c.req.param('id');
    const componentId = c.req.param('componentId');

    const canvasCheck = await db.query<{ id: string }>(
      `SELECT id FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasCheck.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    const componentState = await stateEngine.getComponentState(canvasId, componentId);

    if (componentState === null) {
      return c.json({ error: 'Component state not found' }, 404);
    }

    return c.json(componentState);
  });

  /**
   * GET /:id/events
   * Get the event history for a canvas (audit log).
   *
   * Query params:
   *   componentId - filter by component
   *   eventType   - filter by event type
   *   limit       - max events to return (default 100)
   *   offset      - pagination offset (default 0)
   */
  router.get('/:id/events', async (c) => {
    const canvasId = c.req.param('id');

    const canvasCheck = await db.query<{ id: string }>(
      `SELECT id FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasCheck.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    const componentId = c.req.query('componentId');
    const eventType = c.req.query('eventType');
    const limitStr = c.req.query('limit');
    const offsetStr = c.req.query('offset');

    const limit = limitStr !== undefined ? parseInt(limitStr, 10) : 100;
    const offset = offsetStr !== undefined ? parseInt(offsetStr, 10) : 0;

    if (isNaN(limit) || limit < 1 || limit > 1000) {
      return c.json({ error: 'limit must be a number between 1 and 1000' }, 400);
    }
    if (isNaN(offset) || offset < 0) {
      return c.json({ error: 'offset must be a non-negative number' }, 400);
    }

    const result = await stateEngine.getEventHistory(canvasId, {
      componentId,
      eventType,
      limit,
      offset,
    });

    return c.json(result);
  });

  /**
   * GET /:id/events/pending
   * Get unacknowledged events for a canvas — events Jane hasn't processed yet.
   *
   * Query params:
   *   componentId - filter by component
   *   eventType   - filter by event type
   *   limit       - max events to return (default 100)
   *   offset      - pagination offset (default 0)
   */
  router.get('/:id/events/pending', async (c) => {
    const canvasId = c.req.param('id');

    const canvasCheck = await db.query<{ id: string }>(
      `SELECT id FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasCheck.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    const componentId = c.req.query('componentId');
    const eventType = c.req.query('eventType');
    const limitStr = c.req.query('limit');
    const offsetStr = c.req.query('offset');

    const limit = limitStr !== undefined ? parseInt(limitStr, 10) : 100;
    const offset = offsetStr !== undefined ? parseInt(offsetStr, 10) : 0;

    if (isNaN(limit) || limit < 1 || limit > 1000) {
      return c.json({ error: 'limit must be a number between 1 and 1000' }, 400);
    }
    if (isNaN(offset) || offset < 0) {
      return c.json({ error: 'offset must be a non-negative number' }, 400);
    }

    const result = await stateEngine.getPendingEvents(canvasId, {
      componentId,
      eventType,
      limit,
      offset,
    });

    return c.json(result);
  });

  /**
   * POST /:id/events/:eventId/acknowledge
   * Mark an event as acknowledged (processed by Jane).
   */
  router.post('/:id/events/:eventId/acknowledge', async (c) => {
    const canvasId = c.req.param('id');
    const eventId = c.req.param('eventId');

    const canvasCheck = await db.query<{ id: string }>(
      `SELECT id FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasCheck.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    const acknowledged = await stateEngine.acknowledgeEvent(eventId);

    if (!acknowledged) {
      return c.json({ error: 'Event not found or already acknowledged' }, 404);
    }

    return c.json({ acknowledged: true, eventId });
  });

  /**
   * POST /:id/events/acknowledge
   * Acknowledge multiple events at once.
   * Body: { eventIds: string[] }
   */
  router.post('/:id/events/acknowledge', async (c) => {
    const canvasId = c.req.param('id');

    const canvasCheck = await db.query<{ id: string }>(
      `SELECT id FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasCheck.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body !== 'object' || body === null || !Array.isArray((body as Record<string, unknown>).eventIds)) {
      return c.json({ error: 'Body must contain eventIds array' }, 400);
    }

    const { eventIds } = body as { eventIds: string[] };

    if (eventIds.length === 0) {
      return c.json({ acknowledged: 0, eventIds: [] });
    }

    const count = await stateEngine.acknowledgeEvents(eventIds);

    return c.json({ acknowledged: count, eventIds });
  });

  // ─── Component-level helpers ─────────────────────────────────────────────

  type ComponentNode = Record<string, unknown>;

  /**
   * Find a component by ID in a nested component tree.
   * Returns the component and its parent array + index for mutations.
   */
  function findComponent(
    components: ComponentNode[],
    targetId: string
  ): { component: ComponentNode; parent: ComponentNode[]; index: number } | null {
    for (let i = 0; i < components.length; i++) {
      if (components[i].id === targetId) {
        return { component: components[i], parent: components, index: i };
      }
      if (Array.isArray(components[i].children)) {
        const result = findComponent(components[i].children as ComponentNode[], targetId);
        if (result) return result;
      }
    }
    return null;
  }

  /**
   * Check if a component ID already exists anywhere in the tree.
   */
  function componentIdExists(components: ComponentNode[], id: string): boolean {
    return findComponent(components, id) !== null;
  }

  // ─── Component-level endpoints ──────────────────────────────────────────

  /**
   * POST /:id/components
   * Add a new component to an existing canvas.
   * Body: { component, parentId?, position? }
   *   - component: the component node to add
   *   - parentId: optional — ID of the parent component to nest under (default: top-level)
   *   - position: optional — index to insert at (default: append at end)
   */
  router.post('/:id/components', async (c) => {
    const canvasId = c.req.param('id');

    const canvasResult = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasResult.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }

    const { component, parentId, position } = body as {
      component: unknown;
      parentId?: string;
      position?: number;
    };

    if (component === undefined) {
      return c.json({ error: 'Validation failed', details: ['Missing required field: component'] }, 400);
    }

    const validation = validateComponentNode(component);
    if (!validation.valid) {
      return c.json({ error: 'Validation failed', details: validation.errors }, 400);
    }

    const descriptor = canvasResult.rows[0].descriptor as Record<string, unknown>;
    const components = descriptor.components as ComponentNode[];
    const comp = component as ComponentNode;

    // Check for duplicate ID
    if (componentIdExists(components, comp.id as string)) {
      return c.json({ error: `Component with id "${comp.id}" already exists` }, 409);
    }

    // Determine target array
    let targetArray: ComponentNode[];
    if (parentId) {
      const parent = findComponent(components, parentId);
      if (!parent) {
        return c.json({ error: `Parent component "${parentId}" not found` }, 404);
      }
      if (!Array.isArray(parent.component.children)) {
        parent.component.children = [];
      }
      targetArray = parent.component.children as ComponentNode[];
    } else {
      targetArray = components;
    }

    // Insert at position or append
    if (position !== undefined && typeof position === 'number') {
      const idx = Math.max(0, Math.min(position, targetArray.length));
      targetArray.splice(idx, 0, comp);
    } else {
      targetArray.push(comp);
    }

    // Persist updated descriptor
    await db.query(
      `UPDATE canvases SET descriptor = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(descriptor), canvasId]
    );

    const updated = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [canvasId]
    );

    wsManager?.broadcastCanvasUpdate(canvasId, updated.rows[0]);

    return c.json({ added: comp, canvas: updated.rows[0] }, 201);
  });

  /**
   * PATCH /:id/components/:componentId
   * Update a specific component within a canvas descriptor.
   * Body: { props?, style?, children?, events? }
   *   - props: merged into existing props
   *   - style: merged into existing style
   *   - children: replaces children array
   *   - events: replaces events array
   */
  router.patch('/:id/components/:componentId', async (c) => {
    const canvasId = c.req.param('id');
    const componentId = c.req.param('componentId');

    const canvasResult = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasResult.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const validation = validateComponentUpdate(body);
    if (!validation.valid) {
      return c.json({ error: 'Validation failed', details: validation.errors }, 400);
    }

    const descriptor = canvasResult.rows[0].descriptor as Record<string, unknown>;
    const components = descriptor.components as ComponentNode[];

    const found = findComponent(components, componentId);
    if (!found) {
      return c.json({ error: `Component "${componentId}" not found` }, 404);
    }

    const patch = body as Record<string, unknown>;

    // Merge props
    if ('props' in patch) {
      found.component.props = {
        ...((found.component.props as Record<string, unknown>) || {}),
        ...(patch.props as Record<string, unknown>),
      };
    }

    // Merge style
    if ('style' in patch) {
      found.component.style = {
        ...((found.component.style as Record<string, unknown>) || {}),
        ...(patch.style as Record<string, unknown>),
      };
    }

    // Replace children
    if ('children' in patch) {
      found.component.children = patch.children;
    }

    // Replace events
    if ('events' in patch) {
      found.component.events = patch.events;
    }

    // Persist updated descriptor
    await db.query(
      `UPDATE canvases SET descriptor = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(descriptor), canvasId]
    );

    const updated = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [canvasId]
    );

    wsManager?.broadcastCanvasUpdate(canvasId, updated.rows[0]);

    return c.json({ updated: found.component, canvas: updated.rows[0] });
  });

  /**
   * DELETE /:id/components/:componentId
   * Remove a component from the canvas descriptor.
   * Also cleans up associated component state.
   */
  router.delete('/:id/components/:componentId', async (c) => {
    const canvasId = c.req.param('id');
    const componentId = c.req.param('componentId');

    const canvasResult = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [canvasId]
    );
    if (canvasResult.rows.length === 0) {
      return c.json({ error: 'Canvas not found' }, 404);
    }

    const descriptor = canvasResult.rows[0].descriptor as Record<string, unknown>;
    const components = descriptor.components as ComponentNode[];

    const found = findComponent(components, componentId);
    if (!found) {
      return c.json({ error: `Component "${componentId}" not found` }, 404);
    }

    // Remove the component from its parent array
    const removed = found.parent.splice(found.index, 1)[0];

    // Persist updated descriptor
    await db.query(
      `UPDATE canvases SET descriptor = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [JSON.stringify(descriptor), canvasId]
    );

    // Clean up component state
    await db.query(
      `DELETE FROM canvas_state WHERE canvas_id = $1 AND component_id = $2`,
      [canvasId, componentId]
    );

    const updated = await db.query<CanvasRow>(
      `SELECT id, title, descriptor, state, created_at, updated_at FROM canvases WHERE id = $1`,
      [canvasId]
    );

    wsManager?.broadcastCanvasUpdate(canvasId, updated.rows[0]);

    return c.json({ removed, canvas: updated.rows[0] });
  });

  return router;
}
