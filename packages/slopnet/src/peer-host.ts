import type { DataConnection } from 'peerjs';
import { Peer } from 'peerjs';
import { TypedEmitter } from './typed-emitter.js';
import type { ClientInfo, HostEvents, InternalMessage, PeerHostOptions } from './types.js';

const DEFAULT_HEARTBEAT_INTERVAL = 5000;
const DEFAULT_HEARTBEAT_TIMEOUT = 10_000;
const DEFAULT_RECONNECT_WINDOW = 30_000;

function isInternalMessage(data: unknown): data is InternalMessage {
  return typeof data === 'object' && data !== null && '__type' in data;
}

export class PeerHost extends TypedEmitter<HostEvents> {
  private peer: any = null;
  private clients = new Map<string, ClientInfo>();
  private disconnectedClients = new Map<string, ClientInfo>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private destroyed = false;

  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private readonly reconnectWindow: number;
  private readonly peerFactory: PeerHostOptions['peerFactory'];

  constructor(private readonly options: PeerHostOptions = {}) {
    super();
    this.heartbeatInterval = options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeout = options.heartbeatTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.reconnectWindow = options.reconnectWindow ?? DEFAULT_RECONNECT_WINDOW;
    this.peerFactory = options.peerFactory ?? ((id, opts) => (id ? new Peer(id, opts as any) : new Peer(opts as any)));
  }

  async start(): Promise<string> {
    if (this.destroyed) {
      throw new Error('PeerHost has been destroyed');
    }
    if (this.peer) {
      throw new Error('PeerHost is already started');
    }

    return new Promise<string>((resolve, reject) => {
      this.peer = this.peerFactory!(this.options.peerId, this.options.peerOptions);

      this.peer.on('open', (id: string) => {
        this.setupPeerListeners();
        this.startHeartbeat();
        this.emit('started', { peerId: id });
        resolve(id);
      });

      this.peer.on('error', (error: Error) => {
        if (!this.peer?.open) {
          reject(error);
        }
      });
    });
  }

  private setupPeerListeners(): void {
    if (!this.peer) {
      return;
    }

    this.peer.on('connection', (conn: DataConnection) => {
      this.handleNewConnection(conn);
    });

    this.peer.on('error', (error: Error) => {
      this.emit('error', { error });
    });

    this.peer.on('disconnected', () => {
      // The peer lost connection to the signaling server, try to reconnect
      if (this.peer && !this.destroyed) {
        this.peer.reconnect();
      }
    });
  }

  private handleNewConnection(conn: DataConnection): void {
    conn.on('open', () => {
      this.onConnectionOpen(conn);
    });

    conn.on('error', (error: Error) => {
      this.emit('error', { error, clientId: conn.peer });
    });
  }

  private onConnectionOpen(conn: DataConnection): void {
    const clientId = conn.peer;

    // Check if this is a reconnecting client
    const wasDisconnected = this.disconnectedClients.has(clientId);
    if (wasDisconnected) {
      this.clearReconnectTimer(clientId);
      this.disconnectedClients.delete(clientId);
    }

    // If there's an existing connected client with this ID, clean up old connection
    const existing = this.clients.get(clientId);
    if (existing?.connection) {
      try {
        existing.connection.close();
      } catch {
        // ignore close errors on stale connections
      }
    }

    const clientInfo: ClientInfo = {
      id: clientId,
      connection: conn,
      connected: true,
      lastHeartbeat: Date.now(),
    };

    this.clients.set(clientId, clientInfo);
    this.setupConnectionListeners(conn, clientId);

    if (wasDisconnected) {
      this.emit('clientReconnected', { clientId });
    } else {
      this.emit('clientConnected', { clientId });
    }
  }

  private setupConnectionListeners(conn: DataConnection, clientId: string): void {
    conn.on('data', (rawData: unknown) => {
      if (isInternalMessage(rawData)) {
        this.handleInternalMessage(clientId, rawData);
        return;
      }
      this.emit('data', { clientId, data: rawData });
    });

    conn.on('close', () => {
      this.handleClientDisconnect(clientId);
    });

    conn.on('error', (error: Error) => {
      this.emit('error', { error, clientId });
    });
  }

  private handleInternalMessage(clientId: string, message: InternalMessage): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    switch (message.__type) {
      case '__heartbeat__': {
        client.lastHeartbeat = Date.now();
        try {
          void client.connection.send({ __type: '__heartbeat_ack__', timestamp: message.timestamp });
        } catch {
          // connection may have closed
        }
        break;
      }
      case '__heartbeat_ack__': {
        client.lastHeartbeat = Date.now();
        break;
      }
      case '__reconnect__': {
        // Client is telling us it previously had a different ID
        const previousId = message.previousId;
        if (this.disconnectedClients.has(previousId)) {
          this.clearReconnectTimer(previousId);
          this.disconnectedClients.delete(previousId);
          this.emit('clientReconnected', { clientId });
        }
        break;
      }
    }
  }

  private handleClientDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.connected = false;
    client.disconnectedAt = Date.now();
    this.clients.delete(clientId);
    this.disconnectedClients.set(clientId, client);

    this.emit('clientDisconnected', { clientId });

    // Start reconnect window timer
    if (this.reconnectWindow > 0) {
      const timer = setTimeout(() => {
        if (this.disconnectedClients.has(clientId)) {
          this.disconnectedClients.delete(clientId);
          this.reconnectTimers.delete(clientId);
          this.emit('clientRemoved', { clientId });
        }
      }, this.reconnectWindow);
      this.reconnectTimers.set(clientId, timer);
    } else {
      this.disconnectedClients.delete(clientId);
      this.emit('clientRemoved', { clientId });
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [clientId, client] of this.clients) {
        // Check if client has timed out
        if (now - client.lastHeartbeat > this.heartbeatTimeout) {
          this.handleClientDisconnect(clientId);
          try {
            client.connection.close();
          } catch {
            // ignore
          }
          continue;
        }

        // Send heartbeat
        try {
          void client.connection.send({ __type: '__heartbeat__', timestamp: now } satisfies InternalMessage);
        } catch {
          // connection may have closed
        }
      }
    }, this.heartbeatInterval);
  }

  private clearReconnectTimer(clientId: string): void {
    const timer = this.reconnectTimers.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(clientId);
    }
  }

  send(clientId: string, data: unknown): void {
    const client = this.clients.get(clientId);
    if (!client?.connected) {
      throw new Error(`Client ${clientId} is not connected`);
    }
    void client.connection.send(data);
  }

  broadcast(data: unknown): void {
    for (const client of this.clients.values()) {
      if (client.connected) {
        try {
          void client.connection.send(data);
        } catch {
          // individual send failures shouldn't stop the broadcast
        }
      }
    }
  }

  kick(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.clients.delete(clientId);
      try {
        client.connection.close();
      } catch {
        // ignore
      }
      this.emit('clientRemoved', { clientId });
    }

    // Also clean up from disconnected
    if (this.disconnectedClients.has(clientId)) {
      this.clearReconnectTimer(clientId);
      this.disconnectedClients.delete(clientId);
      this.emit('clientRemoved', { clientId });
    }
  }

  getClients(): string[] {
    return [...this.clients.keys()];
  }

  getDisconnectedClients(): string[] {
    return [...this.disconnectedClients.keys()];
  }

  isClientConnected(clientId: string): boolean {
    return this.clients.get(clientId)?.connected === true;
  }

  get peerId(): string | null {
    return this.peer?.id ?? null;
  }

  destroy(): void {
    this.destroyed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const client of this.clients.values()) {
      try {
        client.connection.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.disconnectedClients.clear();

    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
    }

    this.emit('closed', undefined as never);
    this.removeAllListeners();
  }
}
