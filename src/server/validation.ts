/**
 * JSON schema validation for canvas descriptors.
 *
 * Validates the structure of canvas descriptors and action event payloads
 * before they are accepted by the API.
 */

// Valid component types (mirrors schema-types.ts ComponentType union)
const VALID_COMPONENT_TYPES = new Set([
  'container', 'grid', 'stack', 'tabs', 'accordion',
  'text', 'heading', 'markdown', 'code',
  'table', 'list', 'key-value', 'tree', 'card',
  'chart',
  'input', 'textarea', 'select', 'checkbox', 'radio',
  'slider', 'toggle', 'file', 'button', 'form',
  'progress', 'badge', 'image', 'link', 'divider', 'spacer',
  'alert', 'callout', 'embed',
  'conditional', 'loading', 'error-boundary',
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

/**
 * Validates a component node recursively.
 * Returns a list of error messages (empty if valid).
 */
function validateComponent(component: unknown, path: string): string[] {
  const errors: string[] = [];

  if (typeof component !== 'object' || component === null || Array.isArray(component)) {
    errors.push(`${path}: must be an object`);
    return errors;
  }

  const comp = component as Record<string, unknown>;

  // Required: id
  if (!('id' in comp) || typeof comp.id !== 'string' || comp.id.trim() === '') {
    errors.push(`${path}.id: must be a non-empty string`);
  }

  // Required: type
  if (!('type' in comp) || typeof comp.type !== 'string') {
    errors.push(`${path}.type: must be a string`);
  } else if (!VALID_COMPONENT_TYPES.has(comp.type)) {
    errors.push(`${path}.type: unknown component type "${comp.type}"`);
  }

  // Optional: props must be an object if present
  if ('props' in comp && comp.props !== null && typeof comp.props !== 'object') {
    errors.push(`${path}.props: must be an object`);
  }

  // Optional: children must be an array if present
  if ('children' in comp) {
    if (!Array.isArray(comp.children)) {
      errors.push(`${path}.children: must be an array`);
    } else {
      for (let i = 0; i < comp.children.length; i++) {
        const childErrors = validateComponent(comp.children[i], `${path}.children[${i}]`);
        errors.push(...childErrors);
      }
    }
  }

  return errors;
}

/**
 * Validates a canvas descriptor (the top-level JSON object Jane provides).
 *
 * A valid descriptor must have:
 *   - title: non-empty string
 *   - components: array of valid component nodes
 *
 * The descriptor may also carry arbitrary metadata fields.
 */
export function validateDescriptor(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(['descriptor: must be a JSON object']);
  }

  const descriptor = body as Record<string, unknown>;
  const errors: string[] = [];

  // title: required string
  if (!('title' in descriptor) || typeof descriptor.title !== 'string' || descriptor.title.trim() === '') {
    errors.push('descriptor.title: must be a non-empty string');
  }

  // components: required array
  if (!('components' in descriptor)) {
    errors.push('descriptor.components: required field missing');
  } else if (!Array.isArray(descriptor.components)) {
    errors.push('descriptor.components: must be an array');
  } else {
    for (let i = 0; i < descriptor.components.length; i++) {
      const compErrors = validateComponent(descriptor.components[i], `descriptor.components[${i}]`);
      errors.push(...compErrors);
    }
  }

  if (errors.length > 0) {
    return fail(errors);
  }
  return ok();
}

/**
 * Validates a PATCH body for updating a canvas.
 *
 * Accepted fields:
 *   - descriptor: optional, validated as canvas descriptor if present
 *   - state: optional, must be an object if present
 *   - components: optional array of {id, props, state} patch objects
 */
export function validatePatchBody(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(['patch body: must be a JSON object']);
  }

  const patch = body as Record<string, unknown>;
  const errors: string[] = [];

  if (Object.keys(patch).length === 0) {
    errors.push('patch body: must contain at least one field to update');
  }

  // descriptor: optional — if present, validate it
  if ('descriptor' in patch) {
    const result = validateDescriptor(patch.descriptor);
    if (!result.valid) {
      errors.push(...result.errors);
    }
  }

  // state: optional object
  if ('state' in patch && (typeof patch.state !== 'object' || patch.state === null || Array.isArray(patch.state))) {
    errors.push('patch.state: must be an object');
  }

  // components: optional array of component patches
  if ('components' in patch) {
    if (!Array.isArray(patch.components)) {
      errors.push('patch.components: must be an array');
    } else {
      for (let i = 0; i < patch.components.length; i++) {
        const cp = patch.components[i];
        if (typeof cp !== 'object' || cp === null) {
          errors.push(`patch.components[${i}]: must be an object`);
          continue;
        }
        const cpObj = cp as Record<string, unknown>;
        if (!('id' in cpObj) || typeof cpObj.id !== 'string' || cpObj.id.trim() === '') {
          errors.push(`patch.components[${i}].id: must be a non-empty string`);
        }
        if ('props' in cpObj && (typeof cpObj.props !== 'object' || cpObj.props === null || Array.isArray(cpObj.props))) {
          errors.push(`patch.components[${i}].props: must be an object`);
        }
        if ('state' in cpObj && (typeof cpObj.state !== 'object' || cpObj.state === null || Array.isArray(cpObj.state))) {
          errors.push(`patch.components[${i}].state: must be an object`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return fail(errors);
  }
  return ok();
}

/**
 * Validates an action event payload from the frontend.
 *
 * Required fields:
 *   - componentId: non-empty string
 *   - eventType: non-empty string
 *
 * Optional:
 *   - value: any JSON value
 *   - metadata: object
 */
/**
 * Validates a single component node (for add_component endpoint).
 * Same rules as components inside a descriptor but at the top level.
 */
export function validateComponentNode(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(['component: must be a JSON object']);
  }

  const errors = validateComponent(body, 'component');
  if (errors.length > 0) {
    return fail(errors);
  }
  return ok();
}

/**
 * Validates a component update payload (for update_component endpoint).
 *
 * Accepted fields (at least one required):
 *   - props: object to merge into existing props
 *   - style: object to merge into existing style
 *   - children: array to replace children
 *   - events: array to replace events
 */
export function validateComponentUpdate(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(['component update: must be a JSON object']);
  }

  const patch = body as Record<string, unknown>;
  const errors: string[] = [];

  const validFields = ['props', 'style', 'children', 'events'];
  const hasField = validFields.some((f) => f in patch);
  if (!hasField) {
    errors.push('component update: must contain at least one of: props, style, children, events');
  }

  if ('props' in patch && (typeof patch.props !== 'object' || patch.props === null || Array.isArray(patch.props))) {
    errors.push('component update.props: must be an object');
  }

  if ('style' in patch && (typeof patch.style !== 'object' || patch.style === null || Array.isArray(patch.style))) {
    errors.push('component update.style: must be an object');
  }

  if ('children' in patch) {
    if (!Array.isArray(patch.children)) {
      errors.push('component update.children: must be an array');
    } else {
      for (let i = 0; i < patch.children.length; i++) {
        const childErrors = validateComponent(patch.children[i], `component update.children[${i}]`);
        errors.push(...childErrors);
      }
    }
  }

  if ('events' in patch && !Array.isArray(patch.events)) {
    errors.push('component update.events: must be an array');
  }

  if (errors.length > 0) {
    return fail(errors);
  }
  return ok();
}

export function validateActionEvent(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(['action body: must be a JSON object']);
  }

  const action = body as Record<string, unknown>;
  const errors: string[] = [];

  if (!('componentId' in action) || typeof action.componentId !== 'string' || action.componentId.trim() === '') {
    errors.push('action.componentId: must be a non-empty string');
  }

  if (!('eventType' in action) || typeof action.eventType !== 'string' || action.eventType.trim() === '') {
    errors.push('action.eventType: must be a non-empty string');
  }

  if ('metadata' in action && (typeof action.metadata !== 'object' || action.metadata === null || Array.isArray(action.metadata))) {
    errors.push('action.metadata: must be an object');
  }

  if (errors.length > 0) {
    return fail(errors);
  }
  return ok();
}
