/**
 * WebSocket manager for the Dynamic UI Canvas server.
 *
 * Responsibilities:
 * - Maintain a registry of WebSocket connections per canvas ID
 * - Broadcast canvas update messages to all clients subscribed to a canvas
 * - Accept user interaction events from clients and store them via callback
 * - Handle connection and disconnection gracefully
 *
 * Message protocol (JSON):
 *
 * Client → Server (sent after connection, to subscribe):
 *   { type: 'subscribe', canvasId: string }
 *
 * Client → Server (user interaction events):
 *   { type: 'action', canvasId: string, componentId: string, eventType: string, value?: unknown, metadata?: object }
 *
 * Server → Client (canvas updated by Jane):
 *   { type: 'canvas_updated', canvasId: string, data: object }
 *
 * Server → Client (canvas deleted):
 *   { type: 'canvas_deleted', canvasId: string }
 *
 * Server → Client (user action acknowledged):
 *   { type: 'action_ack', canvasId: string, eventId: string }
 *
 * Server → Client (error):
 *   { type: 'error', message: string }
 *
 * Server → Client (subscribed confirmation):
 *   { type: 'subscribed', canvasId: string }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { Http2Server, Http2SecureServer } from 'http2';

type AnyHttpServer = Server | Http2Server | Http2SecureServer;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CanvasUpdatePayload {
  canvasId: string;
  data: object;
}

export interface ActionEventPayload {
  canvasId: string;
  componentId: string;
  eventType: string;
  value?: unknown;
  metadata?: object;
}

/**
 * Callback invoked when a client sends an action event.
 * Returns the generated event ID so an ack can be sent back.
 */
export type ActionHandler = (payload: ActionEventPayload) => Promise<string>;

// ─── WebSocket Manager ───────────────────────────────────────────────────────

/**
 * Manages WebSocket connections for the canvas server.
 *
 * Connections are grouped by canvas ID. Each WebSocket can subscribe to
 * exactly one canvas at a time (re-subscription moves the socket).
 */
export class CanvasWebSocketManager {
  private wss: WebSocketServer;
  /** Map from canvasId → Set of subscribed WebSocket clients */
  private canvasClients: Map<string, Set<WebSocket>> = new Map();
  /** Map from WebSocket → canvasId (reverse index for cleanup) */
  private clientCanvas: Map<WebSocket, string> = new Map();
  private actionHandler: ActionHandler | null = null;

  constructor(server: AnyHttpServer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.wss = new WebSocketServer({ server: server as any });
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      this.handleConnection(ws);
    });
  }

  /**
   * Register the handler that will be called when clients send action events.
   */
  setActionHandler(handler: ActionHandler): void {
    this.actionHandler = handler;
  }

  /**
   * Broadcast a canvas_updated message to all clients subscribed to the canvas.
   */
  broadcastCanvasUpdate(canvasId: string, data: object): void {
    this.broadcast(canvasId, {
      type: 'canvas_updated',
      canvasId,
      data,
    });
  }

  /**
   * Broadcast a canvas_deleted message to all clients subscribed to the canvas,
   * then clean up the subscription group.
   */
  broadcastCanvasDeleted(canvasId: string): void {
    this.broadcast(canvasId, {
      type: 'canvas_deleted',
      canvasId,
    });
    // Clean up subscription group
    const clients = this.canvasClients.get(canvasId);
    if (clients) {
      for (const ws of clients) {
        this.clientCanvas.delete(ws);
      }
      this.canvasClients.delete(canvasId);
    }
  }

  /**
   * Returns the number of clients currently subscribed to a canvas.
   * Useful for testing.
   */
  getClientCount(canvasId: string): number {
    return this.canvasClients.get(canvasId)?.size ?? 0;
  }

  /**
   * Returns total number of active WebSocket connections.
   */
  getTotalClientCount(): number {
    return this.clientCanvas.size;
  }

  /**
   * Close the underlying WebSocketServer. Used during testing/shutdown.
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      this.handleMessage(ws, data.toString());
    });

    ws.on('close', () => {
      this.removeClient(ws);
    });

    ws.on('error', () => {
      this.removeClient(ws);
    });
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.sendError(ws, 'Invalid JSON message');
      return;
    }

    if (typeof msg.type !== 'string') {
      this.sendError(ws, 'Message must have a string "type" field');
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        this.handleSubscribe(ws, msg);
        break;
      case 'action':
        this.handleAction(ws, msg);
        break;
      default:
        this.sendError(ws, `Unknown message type: ${msg.type}`);
    }
  }

  private handleSubscribe(ws: WebSocket, msg: Record<string, unknown>): void {
    if (typeof msg.canvasId !== 'string' || !msg.canvasId) {
      this.sendError(ws, 'subscribe requires a non-empty string "canvasId"');
      return;
    }

    const canvasId = msg.canvasId;

    // Remove from previous subscription if any
    this.removeClient(ws);

    // Add to new subscription group
    if (!this.canvasClients.has(canvasId)) {
      this.canvasClients.set(canvasId, new Set());
    }
    this.canvasClients.get(canvasId)!.add(ws);
    this.clientCanvas.set(ws, canvasId);

    this.send(ws, { type: 'subscribed', canvasId });
  }

  private handleAction(ws: WebSocket, msg: Record<string, unknown>): void {
    if (typeof msg.canvasId !== 'string' || !msg.canvasId) {
      this.sendError(ws, 'action requires a non-empty string "canvasId"');
      return;
    }
    if (typeof msg.componentId !== 'string' || !msg.componentId) {
      this.sendError(ws, 'action requires a non-empty string "componentId"');
      return;
    }
    if (typeof msg.eventType !== 'string' || !msg.eventType) {
      this.sendError(ws, 'action requires a non-empty string "eventType"');
      return;
    }

    if (!this.actionHandler) {
      this.sendError(ws, 'Server not ready to handle actions');
      return;
    }

    const payload: ActionEventPayload = {
      canvasId: msg.canvasId,
      componentId: msg.componentId,
      eventType: msg.eventType,
    };
    if ('value' in msg) payload.value = msg.value;
    if ('metadata' in msg && typeof msg.metadata === 'object' && msg.metadata !== null) {
      payload.metadata = msg.metadata as object;
    }

    this.actionHandler(payload)
      .then((eventId) => {
        this.send(ws, { type: 'action_ack', canvasId: msg.canvasId, eventId });
      })
      .catch(() => {
        this.sendError(ws, 'Failed to process action');
      });
  }

  private removeClient(ws: WebSocket): void {
    const canvasId = this.clientCanvas.get(ws);
    if (canvasId) {
      const clients = this.canvasClients.get(canvasId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          this.canvasClients.delete(canvasId);
        }
      }
      this.clientCanvas.delete(ws);
    }
  }

  private broadcast(canvasId: string, message: object): void {
    const clients = this.canvasClients.get(canvasId);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private send(ws: WebSocket, message: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, { type: 'error', message });
  }
}
