import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { db, initializeDatabase } from './db.js';
import { createCanvasesRouter } from './routes/canvases.js';
import { CanvasWebSocketManager } from './ws.js';
import { StateEngine } from './state-engine.js';

const app = new Hono();

app.use('/*', cors());

// Initialize database on startup
await initializeDatabase();

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'dynamic-ui-canvas', timestamp: new Date().toISOString() });
});

const port = parseInt(process.env.PORT || '3001', 10);
console.log(`Dynamic UI Canvas API running on http://localhost:${port}`);

const server = serve({
  fetch: app.fetch,
  port,
});

// StateEngine: central state management for the canvas server
const stateEngine = new StateEngine(db);

// Attach WebSocket server to the HTTP server
const wsManager = new CanvasWebSocketManager(server);

// Wire up action handler so client action events are persisted via StateEngine
wsManager.setActionHandler(async (payload) => {
  const { canvasId, componentId, eventType, value, metadata } = payload;

  // Verify canvas exists
  const canvasCheck = await db.query<{ id: string }>(
    `SELECT id FROM canvases WHERE id = $1`,
    [canvasId]
  );
  if (canvasCheck.rows.length === 0) {
    throw new Error(`Canvas not found: ${canvasId}`);
  }

  return stateEngine.applyAction(
    canvasId,
    componentId,
    eventType,
    value,
    metadata as Record<string, unknown> | undefined
  );
});

// Canvas CRUD + actions routes (with WebSocket manager for real-time broadcast)
app.route('/api/canvases', createCanvasesRouter(db, wsManager));

// Serve static frontend files from public/ directory (built Canvas Web App)
app.use('/*', serveStatic({ root: './public' }));
// SPA fallback: serve index.html for any non-API, non-file route
app.get('/*', serveStatic({ root: './public', path: 'index.html' }));
