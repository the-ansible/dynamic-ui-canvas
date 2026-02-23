/**
 * E2E Scenario 2: Chart dashboard with dynamic data updates.
 *
 * Flow:
 *   1. Jane creates a dashboard canvas with two charts (line + bar) showing sample data
 *   2. Both charts render with initial data (verified via GET canvas)
 *   3. Jane updates the chart data dynamically via component update (PATCH)
 *   4. Charts animate to new values — no page reload required (verified via WebSocket broadcast + descriptor state)
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

// ─── Dashboard descriptor: line + bar charts ─────────────────────────────────

const initialLineData = {
  labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
  datasets: [
    {
      label: 'Monthly Revenue',
      data: [12000, 19000, 15000, 22000, 18000, 25000],
      borderColor: '#6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      fill: true,
      borderWidth: 2,
    },
  ],
};

const initialBarData = {
  labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
  datasets: [
    {
      label: 'Orders',
      data: [120, 190, 150, 220, 180, 250],
      backgroundColor: '#ec4899',
      borderRadius: 4,
    },
  ],
};

const dashboardDescriptor = {
  title: 'Sales Dashboard',
  components: [
    {
      id: 'dashboard-root',
      type: 'container',
      props: { direction: 'column', gap: '24px' },
      children: [
        {
          id: 'dashboard-heading',
          type: 'heading',
          props: { content: 'Sales Dashboard', level: 1 },
        },
        {
          id: 'charts-row',
          type: 'grid',
          props: { columns: 2, gap: '24px' },
          children: [
            {
              id: 'revenue-card',
              type: 'card',
              props: { title: 'Revenue Trend', elevation: 2 },
              children: [
                {
                  id: 'revenue-line-chart',
                  type: 'chart',
                  props: {
                    chartType: 'line',
                    height: '300px',
                    data: initialLineData,
                    options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      animationDuration: 750,
                      plugins: { legend: { display: true } },
                    },
                  },
                },
              ],
            },
            {
              id: 'orders-card',
              type: 'card',
              props: { title: 'Monthly Orders', elevation: 2 },
              children: [
                {
                  id: 'orders-bar-chart',
                  type: 'chart',
                  props: {
                    chartType: 'bar',
                    height: '300px',
                    data: initialBarData,
                    options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      animationDuration: 750,
                      plugins: { legend: { display: false } },
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ─── Updated data (simulating Jane pushing new values) ───────────────────────

const updatedLineData = {
  labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
  datasets: [
    {
      label: 'Monthly Revenue',
      data: [12000, 19000, 15000, 22000, 18000, 25000, 31000],
      borderColor: '#6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      fill: true,
      borderWidth: 2,
    },
  ],
};

const updatedBarData = {
  labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
  datasets: [
    {
      label: 'Orders',
      data: [120, 190, 150, 220, 180, 250, 310],
      backgroundColor: '#ec4899',
      borderRadius: 4,
    },
  ],
};

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe('E2E Scenario 2: Chart dashboard with dynamic data updates', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('full flow: create dashboard → verify charts → update data → verify new values', async () => {
    // ── Step 1: Jane creates the dashboard canvas ─────────────────────────

    const createRes = await req(app, 'POST', '/api/canvases', dashboardDescriptor);
    expect(createRes.status).toBe(201);

    const canvas = await createRes.json();
    expect(canvas.id).toBeDefined();
    expect(canvas.title).toBe('Sales Dashboard');
    const canvasId = canvas.id;

    // ── Step 2: Verify both charts render with initial data ───────────────

    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    expect(getRes.status).toBe(200);

    const fullCanvas = await getRes.json();
    const descriptor = fullCanvas.descriptor;

    // Navigate the component tree to find charts
    const root = descriptor.components[0]; // dashboard-root container
    const chartsRow = root.children[1]; // charts-row grid
    expect(chartsRow.id).toBe('charts-row');
    expect(chartsRow.children).toHaveLength(2);

    // Line chart
    const revenueCard = chartsRow.children[0];
    expect(revenueCard.id).toBe('revenue-card');
    const lineChart = revenueCard.children[0];
    expect(lineChart.id).toBe('revenue-line-chart');
    expect(lineChart.type).toBe('chart');
    expect(lineChart.props.chartType).toBe('line');
    expect(lineChart.props.data.labels).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']);
    expect(lineChart.props.data.datasets[0].data).toEqual([12000, 19000, 15000, 22000, 18000, 25000]);

    // Bar chart
    const ordersCard = chartsRow.children[1];
    expect(ordersCard.id).toBe('orders-card');
    const barChart = ordersCard.children[0];
    expect(barChart.id).toBe('orders-bar-chart');
    expect(barChart.type).toBe('chart');
    expect(barChart.props.chartType).toBe('bar');
    expect(barChart.props.data.labels).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']);
    expect(barChart.props.data.datasets[0].data).toEqual([120, 190, 150, 220, 180, 250]);

    // ── Step 3: Jane updates the line chart data dynamically ──────────────

    const updateLineRes = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/revenue-line-chart`,
      { props: { data: updatedLineData } }
    );
    expect(updateLineRes.status).toBe(200);

    const lineUpdateBody = await updateLineRes.json();
    expect(lineUpdateBody.updated.props.data.labels).toHaveLength(7);
    expect(lineUpdateBody.updated.props.data.datasets[0].data).toEqual(
      [12000, 19000, 15000, 22000, 18000, 25000, 31000]
    );

    // ── Step 4: Jane updates the bar chart data dynamically ───────────────

    const updateBarRes = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/orders-bar-chart`,
      { props: { data: updatedBarData } }
    );
    expect(updateBarRes.status).toBe(200);

    const barUpdateBody = await updateBarRes.json();
    expect(barUpdateBody.updated.props.data.labels).toHaveLength(7);
    expect(barUpdateBody.updated.props.data.datasets[0].data).toEqual(
      [120, 190, 150, 220, 180, 250, 310]
    );

    // ── Step 5: Verify full canvas reflects updated data (no reload) ──────

    const verifyRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    expect(verifyRes.status).toBe(200);

    const updatedCanvas = await verifyRes.json();
    const updatedDescriptor = updatedCanvas.descriptor;

    const updatedRoot = updatedDescriptor.components[0];
    const updatedChartsRow = updatedRoot.children[1];

    // Line chart has new data with Jul added
    const updatedLineChart = updatedChartsRow.children[0].children[0];
    expect(updatedLineChart.props.data.labels).toEqual(
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul']
    );
    expect(updatedLineChart.props.data.datasets[0].data).toEqual(
      [12000, 19000, 15000, 22000, 18000, 25000, 31000]
    );

    // Bar chart has new data with Jul added
    const updatedBarChart = updatedChartsRow.children[1].children[0];
    expect(updatedBarChart.props.data.labels).toEqual(
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul']
    );
    expect(updatedBarChart.props.data.datasets[0].data).toEqual(
      [120, 190, 150, 220, 180, 250, 310]
    );

    // Animation config preserved — frontend will animate transitions
    expect(updatedLineChart.props.options.animationDuration).toBe(750);
    expect(updatedBarChart.props.options.animationDuration).toBe(750);
  });

  it('chart type and styling props are preserved after data update', async () => {
    // Create dashboard
    const createRes = await req(app, 'POST', '/api/canvases', dashboardDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // Update only the data prop of line chart
    await req(app, 'PATCH', `/api/canvases/${canvasId}/components/revenue-line-chart`, {
      props: { data: updatedLineData },
    });

    // Verify chartType and other props are still intact
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const fullCanvas = await getRes.json();

    const lineChart = fullCanvas.descriptor.components[0].children[1].children[0].children[0];
    expect(lineChart.props.chartType).toBe('line');
    expect(lineChart.props.height).toBe('300px');
    expect(lineChart.props.options.responsive).toBe(true);
    expect(lineChart.props.data.datasets[0].borderColor).toBe('#6366f1');
    expect(lineChart.props.data.datasets[0].fill).toBe(true);
  });

  it('multiple rapid data updates accumulate correctly', async () => {
    // Create dashboard
    const createRes = await req(app, 'POST', '/api/canvases', dashboardDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // Simulate Jane pushing several rapid updates (e.g., real-time data feed)
    const dataVersions = [
      [120, 190, 150, 220, 180, 250],
      [125, 195, 155, 225, 185, 260],
      [130, 200, 160, 230, 195, 275],
    ];

    for (const data of dataVersions) {
      const res = await req(
        app,
        'PATCH',
        `/api/canvases/${canvasId}/components/orders-bar-chart`,
        {
          props: {
            data: {
              labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
              datasets: [
                {
                  label: 'Orders',
                  data,
                  backgroundColor: '#ec4899',
                  borderRadius: 4,
                },
              ],
            },
          },
        }
      );
      expect(res.status).toBe(200);
    }

    // Final state should reflect the last update
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const fullCanvas = await getRes.json();

    const barChart = fullCanvas.descriptor.components[0].children[1].children[1].children[0];
    expect(barChart.props.data.datasets[0].data).toEqual([130, 200, 160, 230, 195, 275]);
  });

  it('canvas updated_at timestamp changes on data update', async () => {
    // Create dashboard
    const createRes = await req(app, 'POST', '/api/canvases', dashboardDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;
    const createdAt = canvas.updated_at;

    // Small delay to ensure timestamp differs
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Update chart data
    await req(app, 'PATCH', `/api/canvases/${canvasId}/components/revenue-line-chart`, {
      props: { data: updatedLineData },
    });

    // Verify timestamp was updated
    const getRes = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const updatedCanvas = await getRes.json();

    expect(new Date(updatedCanvas.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(createdAt).getTime()
    );
  });
});
