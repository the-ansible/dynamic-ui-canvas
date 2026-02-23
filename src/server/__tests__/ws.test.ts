/**
 * Tests for CanvasWebSocketManager.
 *
 * Strategy: Start a real HTTP server on a random port, attach the WS manager to it,
 * then connect real WebSocket clients to verify the full message protocol.
 *
 * Each test gets a fresh server + manager via beforeEach to ensure isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { WebSocket } from 'ws';
import { CanvasWebSocketManager } from '../ws.js';
import type { ActionEventPayload } from '../ws.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates an HTTP server on a random port, attaches a WS manager, and returns both. */
async function createTestServer(): Promise<{
  wsManager: CanvasWebSocketManager;
  port: number;
  close: () => Promise<void>;
}> {
  const httpServer = createServer();
  const wsManager = new CanvasWebSocketManager(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve); // port 0 = random free port
  });

  const port = (httpServer.address() as { port: number }).port;

  return {
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

/** Opens a WebSocket connection to the test server and waits for the open event. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Collects the next N messages received by a WebSocket client. */
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

/** Sends a subscribe message and waits for the 'subscribed' response. */
async function subscribeClient(ws: WebSocket, canvasId: string): Promise<void> {
  const msgPromise = collectMessages(ws, 1);
  ws.send(JSON.stringify({ type: 'subscribe', canvasId }));
  const [msg] = await msgPromise;
  const m = msg as { type: string; canvasId: string };
  if (m.type !== 'subscribed' || m.canvasId !== canvasId) {
    throw new Error(`Unexpected response: ${JSON.stringify(msg)}`);
  }
}

/** Returns a promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CanvasWebSocketManager', () => {
  let wsManager: CanvasWebSocketManager;
  let port: number;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const result = await createTestServer();
    wsManager = result.wsManager;
    port = result.port;
    closeServer = result.close;
  });

  afterEach(async () => {
    await closeServer();
  });

  // ─── Connection management ──────────────────────────────────────────────────

  describe('connection management', () => {
    it('accepts WebSocket connections', async () => {
      const ws = await connectClient(port);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('tracks connected clients count after subscription', async () => {
      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-1');
      expect(wsManager.getClientCount('canvas-1')).toBe(1);
      ws.close();
    });

    it('decrements count when client disconnects', async () => {
      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-1');
      expect(wsManager.getClientCount('canvas-1')).toBe(1);

      ws.close();
      // Give the server time to process the close event
      await delay(50);
      expect(wsManager.getClientCount('canvas-1')).toBe(0);
    });

    it('supports multiple clients subscribed to the same canvas', async () => {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);
      await subscribeClient(ws1, 'canvas-1');
      await subscribeClient(ws2, 'canvas-1');
      expect(wsManager.getClientCount('canvas-1')).toBe(2);
      ws1.close();
      ws2.close();
    });

    it('supports clients subscribed to different canvases', async () => {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);
      await subscribeClient(ws1, 'canvas-A');
      await subscribeClient(ws2, 'canvas-B');
      expect(wsManager.getClientCount('canvas-A')).toBe(1);
      expect(wsManager.getClientCount('canvas-B')).toBe(1);
      ws1.close();
      ws2.close();
    });

    it('moves client subscription when subscribing to a new canvas', async () => {
      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-1');
      expect(wsManager.getClientCount('canvas-1')).toBe(1);

      await subscribeClient(ws, 'canvas-2');
      expect(wsManager.getClientCount('canvas-1')).toBe(0);
      expect(wsManager.getClientCount('canvas-2')).toBe(1);
      ws.close();
    });
  });

  // ─── Subscribe message protocol ──────────────────────────────────────────────

  describe('subscribe message', () => {
    it('sends subscribed confirmation', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'subscribe', canvasId: 'canvas-xyz' }));
      const [msg] = await msgPromise;
      expect(msg).toEqual({ type: 'subscribed', canvasId: 'canvas-xyz' });
      ws.close();
    });

    it('returns error for missing canvasId', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'subscribe' }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });

    it('returns error for empty canvasId', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'subscribe', canvasId: '' }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });
  });

  // ─── Broadcast canvas updates ────────────────────────────────────────────────

  describe('broadcastCanvasUpdate', () => {
    it('sends canvas_updated to subscribed clients', async () => {
      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-1');

      const msgPromise = collectMessages(ws, 1);
      wsManager.broadcastCanvasUpdate('canvas-1', { title: 'Test', components: [] });
      const [msg] = await msgPromise;

      expect(msg).toEqual({
        type: 'canvas_updated',
        canvasId: 'canvas-1',
        data: { title: 'Test', components: [] },
      });
      ws.close();
    });

    it('does not send to clients on a different canvas', async () => {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);
      await subscribeClient(ws1, 'canvas-A');
      await subscribeClient(ws2, 'canvas-B');

      // Collect on ws2 with a short timeout — should not receive anything
      let ws2Received = false;
      ws2.on('message', () => { ws2Received = true; });

      wsManager.broadcastCanvasUpdate('canvas-A', { data: 'for-A-only' });
      await delay(50);

      expect(ws2Received).toBe(false);
      ws1.close();
      ws2.close();
    });

    it('broadcasts to all clients on the same canvas', async () => {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);
      await subscribeClient(ws1, 'canvas-1');
      await subscribeClient(ws2, 'canvas-1');

      const p1 = collectMessages(ws1, 1);
      const p2 = collectMessages(ws2, 1);
      wsManager.broadcastCanvasUpdate('canvas-1', { updated: true });
      const [[msg1], [msg2]] = await Promise.all([p1, p2]);

      expect((msg1 as { type: string }).type).toBe('canvas_updated');
      expect((msg2 as { type: string }).type).toBe('canvas_updated');
      ws1.close();
      ws2.close();
    });

    it('does nothing when no clients are subscribed', () => {
      // Should not throw
      expect(() => wsManager.broadcastCanvasUpdate('nonexistent', {})).not.toThrow();
    });
  });

  // ─── Broadcast canvas deleted ────────────────────────────────────────────────

  describe('broadcastCanvasDeleted', () => {
    it('sends canvas_deleted to subscribed clients', async () => {
      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-del');

      const msgPromise = collectMessages(ws, 1);
      wsManager.broadcastCanvasDeleted('canvas-del');
      const [msg] = await msgPromise;

      expect(msg).toEqual({ type: 'canvas_deleted', canvasId: 'canvas-del' });
      ws.close();
    });

    it('removes subscription group after deletion broadcast', async () => {
      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-del');

      wsManager.broadcastCanvasDeleted('canvas-del');
      await delay(20);

      expect(wsManager.getClientCount('canvas-del')).toBe(0);
      ws.close();
    });
  });

  // ─── Action events from clients ───────────────────────────────────────────────

  describe('action messages', () => {
    it('calls action handler and sends action_ack', async () => {
      const handledActions: ActionEventPayload[] = [];
      wsManager.setActionHandler(async (payload) => {
        handledActions.push(payload);
        return 'test-event-id';
      });

      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-1');

      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({
        type: 'action',
        canvasId: 'canvas-1',
        componentId: 'btn-1',
        eventType: 'click',
      }));
      const [msg] = await msgPromise;

      expect((msg as { type: string }).type).toBe('action_ack');
      expect((msg as { eventId: string }).eventId).toBe('test-event-id');
      expect(handledActions).toHaveLength(1);
      expect(handledActions[0]).toMatchObject({
        canvasId: 'canvas-1',
        componentId: 'btn-1',
        eventType: 'click',
      });
      ws.close();
    });

    it('passes value and metadata to action handler', async () => {
      const handledActions: ActionEventPayload[] = [];
      wsManager.setActionHandler(async (payload) => {
        handledActions.push(payload);
        return 'evt-id';
      });

      const ws = await connectClient(port);
      await subscribeClient(ws, 'canvas-1');

      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({
        type: 'action',
        canvasId: 'canvas-1',
        componentId: 'input-1',
        eventType: 'change',
        value: 'hello',
        metadata: { source: 'keyboard' },
      }));
      await msgPromise;

      expect(handledActions[0]).toMatchObject({
        canvasId: 'canvas-1',
        componentId: 'input-1',
        eventType: 'change',
        value: 'hello',
        metadata: { source: 'keyboard' },
      });
      ws.close();
    });

    it('returns error for missing canvasId in action', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'action', componentId: 'btn', eventType: 'click' }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });

    it('returns error for missing componentId in action', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'action', canvasId: 'c-1', eventType: 'click' }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });

    it('returns error for missing eventType in action', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'action', canvasId: 'c-1', componentId: 'btn' }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });

    it('sends error when action handler throws', async () => {
      wsManager.setActionHandler(async () => {
        throw new Error('Canvas not found');
      });

      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({
        type: 'action',
        canvasId: 'nonexistent',
        componentId: 'btn',
        eventType: 'click',
      }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });
  });

  // ─── Unknown message types ───────────────────────────────────────────────────

  describe('unknown message types', () => {
    it('returns error for unknown message type', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ type: 'ping' }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });

    it('returns error for invalid JSON', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send('not valid json');
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });

    it('returns error for message without type field', async () => {
      const ws = await connectClient(port);
      const msgPromise = collectMessages(ws, 1);
      ws.send(JSON.stringify({ canvasId: 'c-1' }));
      const [msg] = await msgPromise;
      expect((msg as { type: string }).type).toBe('error');
      ws.close();
    });
  });

  // ─── getTotalClientCount ────────────────────────────────────────────────────

  describe('getTotalClientCount', () => {
    it('returns 0 with no connected clients', () => {
      expect(wsManager.getTotalClientCount()).toBe(0);
    });

    it('returns correct count with multiple subscribed clients', async () => {
      const ws1 = await connectClient(port);
      const ws2 = await connectClient(port);
      await subscribeClient(ws1, 'canvas-1');
      await subscribeClient(ws2, 'canvas-2');
      expect(wsManager.getTotalClientCount()).toBe(2);
      ws1.close();
      ws2.close();
    });
  });
});
