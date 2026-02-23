/**
 * StateEngine — The central state management layer for Dynamic UI Canvas.
 *
 * Responsibilities:
 *   - Track per-component state (form values, selected rows, toggle states, etc.)
 *   - Apply state transitions from user action events or Jane's direct updates
 *   - Provide state snapshots (per-component or full canvas)
 *   - Maintain an auditable event history
 *   - Compute derived state (e.g. form validity)
 *
 * All state is persisted to PostgreSQL so it survives page refreshes.
 */

import type { DbClient } from './db.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/** State stored for a single interactive component. */
export interface ComponentState {
  componentId: string;
  state: Record<string, unknown>;
  updatedAt: string;
}

/** Full snapshot of a canvas — all component states plus derived metadata. */
export interface CanvasSnapshot {
  canvasId: string;
  snapshotAt: string;
  components: Record<string, Record<string, unknown>>;
  /** Derived: which form components are valid (all required fields filled). */
  formValidity: Record<string, boolean>;
}

/** A single persisted event from the audit log. */
export interface CanvasEvent {
  id: string;
  canvasId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Options for querying the event history. */
export interface EventHistoryOptions {
  componentId?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface StateRow {
  component_id: string;
  state: Record<string, unknown>;
  updated_at: string | Date;
}

interface EventRow {
  id: string;
  canvas_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  acknowledged: boolean;
  created_at: string | Date;
}

// ─── UUID helper ──────────────────────────────────────────────────────────────

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Derived state computation ────────────────────────────────────────────────

/**
 * Extracts all component IDs with their types from a canvas descriptor.
 * Traverses children and nested structures recursively.
 */
function extractComponents(
  nodes: unknown[],
  acc: Map<string, string>
): void {
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const n = node as Record<string, unknown>;
    if (typeof n.id === 'string' && typeof n.type === 'string') {
      acc.set(n.id, n.type);
    }
    if (Array.isArray(n.children)) {
      extractComponents(n.children as unknown[], acc);
    }
    // Traverse tabs panels
    if (Array.isArray((n.props as Record<string, unknown> | undefined)?.tabs)) {
      for (const tab of (n.props as Record<string, unknown>).tabs as unknown[]) {
        if (typeof tab === 'object' && tab !== null && Array.isArray((tab as Record<string, unknown>).children)) {
          extractComponents((tab as Record<string, unknown>).children as unknown[], acc);
        }
      }
    }
    // Traverse accordion panels
    if (Array.isArray((n.props as Record<string, unknown> | undefined)?.panels)) {
      for (const panel of (n.props as Record<string, unknown>).panels as unknown[]) {
        if (typeof panel === 'object' && panel !== null && Array.isArray((panel as Record<string, unknown>).children)) {
          extractComponents((panel as Record<string, unknown>).children as unknown[], acc);
        }
      }
    }
  }
}

const FORM_INPUT_TYPES = new Set([
  'input', 'textarea', 'select', 'checkbox', 'radio', 'slider', 'toggle', 'file',
]);

/**
 * Compute form validity for each 'form' component in the descriptor.
 *
 * A form is considered valid when all of its direct child inputs that are
 * marked required (props.required === true) have a non-empty current value
 * in the component state.
 *
 * For forms without any required inputs, validity defaults to true.
 */
function computeFormValidity(
  descriptorComponents: unknown[],
  componentStates: Record<string, Record<string, unknown>>
): Record<string, boolean> {
  const formValidity: Record<string, boolean> = {};

  function processNodes(nodes: unknown[]): void {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const n = node as Record<string, unknown>;
      if (typeof n.id !== 'string' || typeof n.type !== 'string') continue;

      if (n.type === 'form') {
        formValidity[n.id] = evaluateFormValidity(n, componentStates);
      }

      // Recurse into children
      if (Array.isArray(n.children)) processNodes(n.children as unknown[]);

      const props = n.props as Record<string, unknown> | undefined;
      if (Array.isArray(props?.tabs)) {
        for (const tab of props!.tabs as unknown[]) {
          if (typeof tab === 'object' && tab !== null && Array.isArray((tab as Record<string, unknown>).children)) {
            processNodes((tab as Record<string, unknown>).children as unknown[]);
          }
        }
      }
      if (Array.isArray(props?.panels)) {
        for (const panel of props!.panels as unknown[]) {
          if (typeof panel === 'object' && panel !== null && Array.isArray((panel as Record<string, unknown>).children)) {
            processNodes((panel as Record<string, unknown>).children as unknown[]);
          }
        }
      }
    }
  }

  processNodes(descriptorComponents);
  return formValidity;
}

/**
 * Evaluate whether a single form node is valid.
 * Checks all direct child input components with props.required === true.
 */
function evaluateFormValidity(
  formNode: Record<string, unknown>,
  componentStates: Record<string, Record<string, unknown>>
): boolean {
  const children = Array.isArray(formNode.children)
    ? (formNode.children as unknown[])
    : [];

  let hasRequiredFields = false;

  for (const child of children) {
    if (typeof child !== 'object' || child === null) continue;
    const c = child as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.type !== 'string') continue;
    if (!FORM_INPUT_TYPES.has(c.type)) continue;

    const props = c.props as Record<string, unknown> | undefined;
    if (props?.required !== true) continue;

    hasRequiredFields = true;
    const compState = componentStates[c.id];
    const value = compState?.value;

    // A value is considered empty if it is undefined, null, empty string, or empty array
    const isEmpty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);

    if (isEmpty) return false;
  }

  return hasRequiredFields ? true : true; // no required fields → always valid
}

// ─── StateEngine class ────────────────────────────────────────────────────────

export class StateEngine {
  constructor(private readonly db: DbClient) {}

  /**
   * Apply a user action event:
   *  1. Persist event to canvas_events for audit
   *  2. If value is provided, merge it into canvas_state for the component
   *
   * Returns the generated event ID.
   */
  async applyAction(
    canvasId: string,
    componentId: string,
    eventType: string,
    value?: unknown,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const eventId = generateId();

    const payload: Record<string, unknown> = { componentId };
    if (value !== undefined) payload.value = value;
    if (metadata !== undefined) payload.metadata = metadata;

    await this.db.query(
      `INSERT INTO canvas_events (id, canvas_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [eventId, canvasId, eventType, JSON.stringify(payload)]
    );

    if (value !== undefined) {
      await this.upsertComponentState(canvasId, componentId, { value });
    }

    return eventId;
  }

  /**
   * Directly set/merge state for a component (Jane's update path).
   * Merges shallowly into existing state (top-level keys overwritten).
   */
  async setComponentState(
    canvasId: string,
    componentId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    await this.upsertComponentState(canvasId, componentId, state);
  }

  /**
   * Replace the entire state of a component (not a merge — full overwrite).
   */
  async replaceComponentState(
    canvasId: string,
    componentId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    const stateId = generateId();
    await this.db.query(
      `INSERT INTO canvas_state (id, canvas_id, component_id, state, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (canvas_id, component_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = CURRENT_TIMESTAMP`,
      [stateId, canvasId, componentId, JSON.stringify(state)]
    );
  }

  /**
   * Get the current state of a single component.
   * Returns null if no state has been recorded yet.
   */
  async getComponentState(
    canvasId: string,
    componentId: string
  ): Promise<ComponentState | null> {
    const result = await this.db.query<StateRow>(
      `SELECT component_id, state, updated_at
       FROM canvas_state
       WHERE canvas_id = $1 AND component_id = $2`,
      [canvasId, componentId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      componentId: row.component_id,
      state: row.state,
      // PostgreSQL may return TIMESTAMP columns as Date objects; normalize to ISO string
      updatedAt: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    };
  }

  /**
   * Get a full snapshot of all component states for a canvas.
   * Includes derived formValidity if a descriptor is provided.
   *
   * @param canvasId   - The canvas to snapshot
   * @param descriptor - Optional canvas descriptor; if provided, formValidity is computed
   */
  async getCanvasSnapshot(
    canvasId: string,
    descriptor?: Record<string, unknown>
  ): Promise<CanvasSnapshot> {
    const result = await this.db.query<StateRow>(
      `SELECT component_id, state, updated_at
       FROM canvas_state
       WHERE canvas_id = $1
       ORDER BY component_id`,
      [canvasId]
    );

    const components: Record<string, Record<string, unknown>> = {};
    for (const row of result.rows) {
      components[row.component_id] = row.state;
    }

    let formValidity: Record<string, boolean> = {};
    if (descriptor && Array.isArray(descriptor.components)) {
      formValidity = computeFormValidity(
        descriptor.components as unknown[],
        components
      );
    }

    return {
      canvasId,
      snapshotAt: new Date().toISOString(),
      components,
      formValidity,
    };
  }

  /**
   * Get the event history for a canvas, with optional filters.
   *
   * @param canvasId - The canvas to query events for
   * @param options  - Filters: componentId, eventType, limit (default 100), offset (default 0)
   */
  async getEventHistory(
    canvasId: string,
    options: EventHistoryOptions = {}
  ): Promise<{ events: CanvasEvent[]; total: number }> {
    const { componentId, eventType, limit = 100, offset = 0 } = options;

    // Build WHERE clause dynamically
    const conditions: string[] = ['canvas_id = $1'];
    const params: unknown[] = [canvasId];
    let paramIdx = 2;

    if (componentId !== undefined) {
      conditions.push(`payload->>'componentId' = $${paramIdx}`);
      params.push(componentId);
      paramIdx++;
    }

    if (eventType !== undefined) {
      conditions.push(`event_type = $${paramIdx}`);
      params.push(eventType);
      paramIdx++;
    }

    const where = conditions.join(' AND ');

    // Count total matching events
    const countResult = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM canvas_events WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Fetch page
    const eventsResult = await this.db.query<EventRow>(
      `SELECT id, canvas_id, event_type, payload, created_at
       FROM canvas_events
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    const events: CanvasEvent[] = eventsResult.rows.map((row) => ({
      id: row.id,
      canvasId: row.canvas_id,
      eventType: row.event_type,
      payload: row.payload,
      // PostgreSQL may return TIMESTAMP columns as Date objects; normalize to ISO string
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    }));

    return { events, total };
  }

  /**
   * Get pending (unacknowledged) events for a canvas.
   * These are events that Jane has not yet processed.
   */
  async getPendingEvents(
    canvasId: string,
    options: EventHistoryOptions = {}
  ): Promise<{ events: CanvasEvent[]; total: number }> {
    const { componentId, eventType, limit = 100, offset = 0 } = options;

    const conditions: string[] = ['canvas_id = $1', 'acknowledged = FALSE'];
    const params: unknown[] = [canvasId];
    let paramIdx = 2;

    if (componentId !== undefined) {
      conditions.push(`payload->>'componentId' = $${paramIdx}`);
      params.push(componentId);
      paramIdx++;
    }

    if (eventType !== undefined) {
      conditions.push(`event_type = $${paramIdx}`);
      params.push(eventType);
      paramIdx++;
    }

    const where = conditions.join(' AND ');

    const countResult = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM canvas_events WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const eventsResult = await this.db.query<EventRow>(
      `SELECT id, canvas_id, event_type, payload, created_at
       FROM canvas_events
       WHERE ${where}
       ORDER BY created_at ASC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    const events: CanvasEvent[] = eventsResult.rows.map((row) => ({
      id: row.id,
      canvasId: row.canvas_id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    }));

    return { events, total };
  }

  /**
   * Acknowledge an event by ID. Returns true if the event was found and acknowledged.
   */
  async acknowledgeEvent(eventId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE canvas_events SET acknowledged = TRUE WHERE id = $1 AND acknowledged = FALSE RETURNING id`,
      [eventId]
    );
    return result.rows.length > 0;
  }

  /**
   * Acknowledge multiple events at once. Returns the count of events acknowledged.
   */
  async acknowledgeEvents(eventIds: string[]): Promise<number> {
    if (eventIds.length === 0) return 0;

    const placeholders = eventIds.map((_, i) => `$${i + 1}`).join(', ');
    const result = await this.db.query<{ id: string }>(
      `UPDATE canvas_events SET acknowledged = TRUE WHERE id IN (${placeholders}) AND acknowledged = FALSE RETURNING id`,
      eventIds
    );
    return result.rows.length;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async upsertComponentState(
    canvasId: string,
    componentId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    const stateId = generateId();
    await this.db.query(
      `INSERT INTO canvas_state (id, canvas_id, component_id, state, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (canvas_id, component_id)
       DO UPDATE SET state = canvas_state.state || EXCLUDED.state, updated_at = CURRENT_TIMESTAMP`,
      [stateId, canvasId, componentId, JSON.stringify(state)]
    );
  }
}
