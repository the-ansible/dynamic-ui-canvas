/**
 * E2E Scenario 5: Convenience tools (show_chart, show_table, show_form) in sequence.
 *
 * Demonstrates that common use cases require minimal effort — each convenience
 * tool creates a fully functional, interactive canvas with a single API call
 * using the same descriptor structures the MCP convenience tools generate.
 *
 * Flow:
 *   1. Jane uses show_chart — creates a bar chart canvas with one call
 *   2. Jane uses show_table — creates a sortable data table canvas with one call
 *   3. Jane uses show_form — creates an interactive form canvas with one call
 *   4. User interacts with each canvas (sort table, fill and submit form)
 *   5. Jane reads state and events from each canvas
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

// ─── Convenience tool descriptor builders ─────────────────────────────────────
// These mirror the descriptor structures built by the MCP convenience tools.

function buildChartDescriptor(params: {
  title: string;
  chartType: string;
  labels: string[];
  datasets: Array<{ label: string; data: number[]; borderColor?: string; backgroundColor?: string; fill?: boolean }>;
  height?: string;
  options?: object;
}) {
  return {
    title: params.title,
    components: [
      {
        id: 'root',
        type: 'container',
        props: { direction: 'column', gap: '16px' },
        style: { padding: { all: '24px' }, maxWidth: '900px', margin: { left: 'auto', right: 'auto' } },
        children: [
          {
            id: 'chart-title',
            type: 'heading',
            props: { content: params.title, level: 2 },
          },
          {
            id: 'chart',
            type: 'chart',
            props: {
              chartType: params.chartType,
              height: params.height || '400px',
              data: { labels: params.labels, datasets: params.datasets },
              ...(params.options ? { options: params.options } : {}),
            },
          },
        ],
      },
    ],
  };
}

function buildTableDescriptor(params: {
  title: string;
  columns: Array<{ key: string; label: string; sortable?: boolean }>;
  data: object[];
  sortable?: boolean;
  filterable?: boolean;
  pageSize?: number;
}) {
  const tableProps: Record<string, unknown> = {
    columns: params.columns,
    data: params.data,
    sortable: params.sortable !== undefined ? params.sortable : true,
  };
  if (params.filterable) tableProps.filterable = true;
  if (params.pageSize !== undefined) {
    tableProps.pagination = { pageSize: params.pageSize, showPageInfo: true };
  }

  return {
    title: params.title,
    components: [
      {
        id: 'root',
        type: 'container',
        props: { direction: 'column', gap: '16px' },
        style: { padding: { all: '24px' } },
        children: [
          {
            id: 'table-title',
            type: 'heading',
            props: { content: params.title, level: 2 },
          },
          {
            id: 'table',
            type: 'table',
            props: tableProps,
          },
        ],
      },
    ],
  };
}

function buildFormDescriptor(params: {
  title: string;
  fields: Array<{
    name: string;
    label: string;
    type: string;
    required?: boolean;
    placeholder?: string;
    options?: Array<{ label: string; value: string }>;
  }>;
  submitLabel?: string;
  description?: string;
}) {
  const formChildren: object[] = [];

  for (const field of params.fields) {
    const fieldType = field.type.toLowerCase();
    if (fieldType === 'select') {
      formChildren.push({
        id: `field-${field.name}`,
        type: 'select',
        props: {
          name: field.name,
          label: field.label,
          options: field.options,
          ...(field.required ? { required: true } : {}),
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        },
      });
    } else if (fieldType === 'textarea') {
      formChildren.push({
        id: `field-${field.name}`,
        type: 'textarea',
        props: {
          name: field.name,
          label: field.label,
          rows: 4,
          ...(field.required ? { required: true } : {}),
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        },
      });
    } else if (fieldType === 'checkbox') {
      formChildren.push({
        id: `field-${field.name}`,
        type: 'checkbox',
        props: { name: field.name, label: field.label },
      });
    } else {
      formChildren.push({
        id: `field-${field.name}`,
        type: 'input',
        props: {
          name: field.name,
          label: field.label,
          inputType: fieldType,
          ...(field.required ? { required: true } : {}),
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        },
      });
    }
  }

  formChildren.push({
    id: 'submit-btn',
    type: 'button',
    props: { label: params.submitLabel || 'Submit', variant: 'primary', fullWidth: true },
  });

  const rootChildren: object[] = [
    { id: 'form-title', type: 'heading', props: { content: params.title, level: 2 } },
  ];

  if (params.description) {
    rootChildren.push({
      id: 'form-description',
      type: 'text',
      props: { content: params.description, variant: 'body1' },
      style: { color: '#64748b' },
    });
  }

  rootChildren.push({
    id: 'form',
    type: 'form',
    props: {
      onSubmit: { type: 'callback', callbackId: 'form-submit', payload: {} },
      validateOnBlur: true,
    },
    children: formChildren,
  });

  return {
    title: params.title,
    components: [
      {
        id: 'root',
        type: 'container',
        props: { direction: 'column', gap: '16px' },
        style: { padding: { all: '24px' }, maxWidth: '600px', margin: { left: 'auto', right: 'auto' } },
        children: rootChildren,
      },
    ],
  };
}

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe('E2E Scenario 5: Convenience tools in sequence', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('full flow: show_chart → show_table → show_form in sequence, all functional', async () => {
    // ── Step 1: Jane uses show_chart ────────────────────────────────────────
    const chartDescriptor = buildChartDescriptor({
      title: 'Q1 Revenue',
      chartType: 'bar',
      labels: ['Jan', 'Feb', 'Mar'],
      datasets: [
        { label: 'Revenue ($K)', data: [120, 185, 210], backgroundColor: '#3b82f6' },
        { label: 'Expenses ($K)', data: [80, 95, 110], backgroundColor: '#ef4444' },
      ],
    });

    const chartRes = await req(app, 'POST', '/api/canvases', chartDescriptor);
    expect(chartRes.status).toBe(201);
    const chartCanvas = await chartRes.json();
    expect(chartCanvas.id).toBeDefined();
    expect(chartCanvas.title).toBe('Q1 Revenue');

    // Verify chart descriptor structure in one call
    const chartGet = await req(app, 'GET', `/api/canvases/${chartCanvas.id}`);
    expect(chartGet.status).toBe(200);
    const chartData = await chartGet.json();
    const chartComponent = chartData.descriptor.components[0].children[1];
    expect(chartComponent.type).toBe('chart');
    expect(chartComponent.props.chartType).toBe('bar');
    expect(chartComponent.props.data.labels).toEqual(['Jan', 'Feb', 'Mar']);
    expect(chartComponent.props.data.datasets).toHaveLength(2);

    // ── Step 2: Jane uses show_table ────────────────────────────────────────
    const tableDescriptor = buildTableDescriptor({
      title: 'Team Members',
      columns: [
        { key: 'name', label: 'Name', sortable: true },
        { key: 'role', label: 'Role', sortable: true },
        { key: 'department', label: 'Department' },
      ],
      data: [
        { name: 'Alice Chen', role: 'Engineer', department: 'Backend' },
        { name: 'Bob Park', role: 'Designer', department: 'Product' },
        { name: 'Carol Wu', role: 'Engineer', department: 'Frontend' },
        { name: 'David Kim', role: 'PM', department: 'Product' },
        { name: 'Eve Lopez', role: 'Engineer', department: 'Backend' },
      ],
      sortable: true,
      filterable: true,
      pageSize: 3,
    });

    const tableRes = await req(app, 'POST', '/api/canvases', tableDescriptor);
    expect(tableRes.status).toBe(201);
    const tableCanvas = await tableRes.json();
    expect(tableCanvas.id).toBeDefined();
    expect(tableCanvas.title).toBe('Team Members');

    // Verify table descriptor: 5 rows, 3 columns, pagination, filterable
    const tableGet = await req(app, 'GET', `/api/canvases/${tableCanvas.id}`);
    expect(tableGet.status).toBe(200);
    const tableData = await tableGet.json();
    const tableComponent = tableData.descriptor.components[0].children[1];
    expect(tableComponent.type).toBe('table');
    expect(tableComponent.props.data).toHaveLength(5);
    expect(tableComponent.props.columns).toHaveLength(3);
    expect(tableComponent.props.sortable).toBe(true);
    expect(tableComponent.props.filterable).toBe(true);
    expect(tableComponent.props.pagination).toEqual({ pageSize: 3, showPageInfo: true });

    // User sorts by role
    const sortRes = await req(app, 'POST', `/api/canvases/${tableCanvas.id}/actions`, {
      componentId: 'table',
      eventType: 'sort',
      metadata: { column: 'role', direction: 'asc' },
    });
    expect(sortRes.status).toBe(201);

    // ── Step 3: Jane uses show_form ─────────────────────────────────────────
    const formDescriptor = buildFormDescriptor({
      title: 'Quick Feedback',
      description: 'Tell us what you think about the dashboard.',
      fields: [
        { name: 'rating', label: 'Rating (1-5)', type: 'number', required: true, placeholder: '1-5' },
        { name: 'category', label: 'Category', type: 'select', required: true, options: [
          { label: 'Bug Report', value: 'bug' },
          { label: 'Feature Request', value: 'feature' },
          { label: 'General Feedback', value: 'general' },
        ]},
        { name: 'comments', label: 'Comments', type: 'textarea', placeholder: 'Your thoughts...' },
        { name: 'subscribe', label: 'Subscribe to updates', type: 'checkbox' },
      ],
      submitLabel: 'Send Feedback',
    });

    const formRes = await req(app, 'POST', '/api/canvases', formDescriptor);
    expect(formRes.status).toBe(201);
    const formCanvas = await formRes.json();
    expect(formCanvas.id).toBeDefined();
    expect(formCanvas.title).toBe('Quick Feedback');

    // Verify form descriptor structure
    const formGet = await req(app, 'GET', `/api/canvases/${formCanvas.id}`);
    expect(formGet.status).toBe(200);
    const formData = await formGet.json();
    const rootChildren = formData.descriptor.components[0].children;
    // heading + description + form
    expect(rootChildren).toHaveLength(3);
    expect(rootChildren[0].type).toBe('heading');
    expect(rootChildren[1].type).toBe('text'); // description
    expect(rootChildren[2].type).toBe('form');
    // 4 fields + submit button
    expect(rootChildren[2].children).toHaveLength(5);

    // ── Step 4: User fills and submits the form ─────────────────────────────
    await req(app, 'POST', `/api/canvases/${formCanvas.id}/actions`, {
      componentId: 'field-rating',
      eventType: 'change',
      value: 5,
    });
    await req(app, 'POST', `/api/canvases/${formCanvas.id}/actions`, {
      componentId: 'field-category',
      eventType: 'change',
      value: 'feature',
    });
    await req(app, 'POST', `/api/canvases/${formCanvas.id}/actions`, {
      componentId: 'field-comments',
      eventType: 'change',
      value: 'The charts look great! Would love line chart support too.',
    });
    await req(app, 'POST', `/api/canvases/${formCanvas.id}/actions`, {
      componentId: 'field-subscribe',
      eventType: 'change',
      value: true,
    });

    // Submit
    const submitRes = await req(app, 'POST', `/api/canvases/${formCanvas.id}/actions`, {
      componentId: 'submit-btn',
      eventType: 'click',
      metadata: { callbackId: 'form-submit' },
    });
    expect(submitRes.status).toBe(201);

    // ── Step 5: Jane reads form submission ──────────────────────────────────
    const pendingRes = await req(app, 'GET', `/api/canvases/${formCanvas.id}/events/pending?eventType=click`);
    expect(pendingRes.status).toBe(200);
    const pending = await pendingRes.json();
    expect(pending.events.length).toBe(1);
    expect(pending.events[0].payload.metadata.callbackId).toBe('form-submit');

    // Read all form values from state
    const stateRes = await req(app, 'GET', `/api/canvases/${formCanvas.id}/state`);
    expect(stateRes.status).toBe(200);
    const snapshot = await stateRes.json();
    expect(snapshot.components['field-rating'].value).toBe(5);
    expect(snapshot.components['field-category'].value).toBe('feature');
    expect(snapshot.components['field-comments'].value).toBe('The charts look great! Would love line chart support too.');
    expect(snapshot.components['field-subscribe'].value).toBe(true);

    // Acknowledge the submission event
    const ackRes = await req(app, 'POST', `/api/canvases/${formCanvas.id}/events/${pending.events[0].id}/acknowledge`);
    expect(ackRes.status).toBe(200);

    // ── Step 6: Verify all 3 canvases co-exist ──────────────────────────────
    const listRes = await req(app, 'GET', '/api/canvases');
    expect(listRes.status).toBe(200);
    const allCanvases = await listRes.json();
    expect(allCanvases).toHaveLength(3);
    const titles = allCanvases.map((c: { title: string }) => c.title).sort();
    expect(titles).toEqual(['Q1 Revenue', 'Quick Feedback', 'Team Members']);
  });

  it('each convenience tool creates a canvas with a single API call', async () => {
    // show_chart: one POST creates a fully formed chart canvas
    const chartRes = await req(app, 'POST', '/api/canvases', buildChartDescriptor({
      title: 'Simple Pie',
      chartType: 'pie',
      labels: ['A', 'B', 'C'],
      datasets: [{ label: 'Values', data: [30, 50, 20] }],
    }));
    expect(chartRes.status).toBe(201);
    const chart = await chartRes.json();
    expect(chart.descriptor.components[0].children[1].type).toBe('chart');
    expect(chart.descriptor.components[0].children[1].props.chartType).toBe('pie');

    // show_table: one POST creates a fully formed table canvas
    const tableRes = await req(app, 'POST', '/api/canvases', buildTableDescriptor({
      title: 'Simple Table',
      columns: [{ key: 'id', label: 'ID' }, { key: 'value', label: 'Value' }],
      data: [{ id: 1, value: 'one' }, { id: 2, value: 'two' }],
    }));
    expect(tableRes.status).toBe(201);
    const table = await tableRes.json();
    expect(table.descriptor.components[0].children[1].type).toBe('table');
    expect(table.descriptor.components[0].children[1].props.data).toHaveLength(2);

    // show_form: one POST creates a fully formed form canvas
    const formRes = await req(app, 'POST', '/api/canvases', buildFormDescriptor({
      title: 'Simple Form',
      fields: [
        { name: 'email', label: 'Email', type: 'email', required: true },
      ],
    }));
    expect(formRes.status).toBe(201);
    const form = await formRes.json();
    const formComponent = form.descriptor.components[0].children[1];
    expect(formComponent.type).toBe('form');
    expect(formComponent.children).toHaveLength(2); // 1 field + submit button
  });

  it('table created via show_table supports sorting and filtering interactions', async () => {
    const tableRes = await req(app, 'POST', '/api/canvases', buildTableDescriptor({
      title: 'Sortable Products',
      columns: [
        { key: 'name', label: 'Product', sortable: true },
        { key: 'price', label: 'Price', sortable: true },
      ],
      data: [
        { name: 'Widget', price: 9.99 },
        { name: 'Gadget', price: 24.99 },
        { name: 'Doohickey', price: 14.99 },
      ],
      sortable: true,
      filterable: true,
    }));
    expect(tableRes.status).toBe(201);
    const canvas = await tableRes.json();

    // User sorts by price descending
    const sortRes = await req(app, 'POST', `/api/canvases/${canvas.id}/actions`, {
      componentId: 'table',
      eventType: 'sort',
      metadata: { column: 'price', direction: 'desc' },
    });
    expect(sortRes.status).toBe(201);

    // User filters by "Gad"
    const filterRes = await req(app, 'POST', `/api/canvases/${canvas.id}/actions`, {
      componentId: 'table',
      eventType: 'filter',
      metadata: { query: 'Gad' },
    });
    expect(filterRes.status).toBe(201);

    // Jane reads event history — both interactions recorded
    const eventsRes = await req(app, 'GET', `/api/canvases/${canvas.id}/events`);
    expect(eventsRes.status).toBe(200);
    const history = await eventsRes.json();
    expect(history.events.length).toBe(2);
    // Newest first
    expect(history.events[0].eventType).toBe('filter');
    expect(history.events[0].payload.metadata.query).toBe('Gad');
    expect(history.events[1].eventType).toBe('sort');
    expect(history.events[1].payload.metadata.column).toBe('price');
  });

  it('form created via show_form captures submission and Jane reads all field values', async () => {
    const formRes = await req(app, 'POST', '/api/canvases', buildFormDescriptor({
      title: 'Contact Us',
      fields: [
        { name: 'name', label: 'Your Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'subject', label: 'Subject', type: 'select', required: true, options: [
          { label: 'Sales', value: 'sales' },
          { label: 'Support', value: 'support' },
          { label: 'Other', value: 'other' },
        ]},
        { name: 'message', label: 'Message', type: 'textarea', required: false },
      ],
      submitLabel: 'Send Message',
      description: 'We typically respond within 24 hours.',
    }));
    expect(formRes.status).toBe(201);
    const canvas = await formRes.json();

    // User fills out the form
    await req(app, 'POST', `/api/canvases/${canvas.id}/actions`, {
      componentId: 'field-name', eventType: 'change', value: 'Jane Doe',
    });
    await req(app, 'POST', `/api/canvases/${canvas.id}/actions`, {
      componentId: 'field-email', eventType: 'change', value: 'jane@example.com',
    });
    await req(app, 'POST', `/api/canvases/${canvas.id}/actions`, {
      componentId: 'field-subject', eventType: 'change', value: 'support',
    });
    await req(app, 'POST', `/api/canvases/${canvas.id}/actions`, {
      componentId: 'field-message', eventType: 'change', value: 'Need help with my account',
    });

    // User clicks submit
    await req(app, 'POST', `/api/canvases/${canvas.id}/actions`, {
      componentId: 'submit-btn', eventType: 'click', metadata: { callbackId: 'form-submit' },
    });

    // Jane reads submission
    const pendingRes = await req(app, 'GET', `/api/canvases/${canvas.id}/events/pending?eventType=click`);
    const pending = await pendingRes.json();
    expect(pending.events.length).toBe(1);

    // Jane reads form state
    const stateRes = await req(app, 'GET', `/api/canvases/${canvas.id}/state`);
    const snapshot = await stateRes.json();
    expect(snapshot.components['field-name'].value).toBe('Jane Doe');
    expect(snapshot.components['field-email'].value).toBe('jane@example.com');
    expect(snapshot.components['field-subject'].value).toBe('support');
    expect(snapshot.components['field-message'].value).toBe('Need help with my account');

    // Acknowledge
    await req(app, 'POST', `/api/canvases/${canvas.id}/events/${pending.events[0].id}/acknowledge`);
    const afterAck = await req(app, 'GET', `/api/canvases/${canvas.id}/events/pending?eventType=click`);
    const afterAckBody = await afterAck.json();
    expect(afterAckBody.events.length).toBe(0);
  });
});
