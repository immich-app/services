import { Peer } from 'peerjs';
import { TypedEmitter } from './typed-emitter.js';
import type { ClientEvents, ConnectionState, InternalMessage, PeerClientOptions } from './types.js';

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_RECONNECT_DELAY = 1000;
const DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = 1.5;
const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL = 5000;
const DEFAULT_HEARTBEAT_TIMEOUT = 10_000;

function isInternalMessage(data: unknown): data is InternalMessage {
  return typeof data === 'object' && data !== null && '__type' in data;
}

export class PeerClient extends TypedEmitter<ClientEvents> {
  private peer: any = null;
  private connection: any = null;
  private _state: ConnectionState = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAck = 0;
  private destroyed = false;
  private messageQueue: unknown[] = [];
  private previousPeerId: string | null = null;

  private readonly hostId: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly reconnectBackoffMultiplier: number;
  private readonly maxReconnectDelay: number;
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private readonly peerFactory: PeerClientOptions['peerFactory'];

  constructor(private readonly options: PeerClientOptions) {
    super();
    this.hostId = options.hostId;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = options.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    this.reconnectBackoffMultiplier = options.reconnectBackoffMultiplier ?? DEFAULT_RECONNECT_BACKOFF_MULTIPLIER;
    this.maxReconnectDelay = options.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY;
    this.heartbeatInterval = options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeout = options.heartbeatTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.peerFactory = options.peerFactory ?? ((id, opts) => (id ? new Peer(id, opts as any) : new Peer(opts as any)));
  }

  get state(): ConnectionState {
    return this._state;
  }

  get peerId(): string | null {
    return this.peer?.id ?? null;
  }

  private setState(newState: ConnectionState): void {
    if (this._state === newState) {
      return;
    }
    const from = this._state;
    this._state = newState;
    this.emit('stateChanged', { from, to: newState });
  }

  async connect(): Promise<void> {
    if (this.destroyed) {
      throw new Error('PeerClient has been destroyed');
    }
    if (this._state !== 'idle') {
      throw new Error(`Cannot connect from state: ${this._state}`);
    }

    this.setState('connecting');
    return this.createPeerAndConnect();
  }

  private async createPeerAndConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const isReconnecting = this._state === 'reconnecting';

      this.peer = this.peerFactory!(undefined, this.options.peerOptions);

      this.peer.on('open', () => {
        this.connectToHost()
          .then(() => resolve())
          .catch((error) => reject(error));
      });

      this.peer.on('error', (error: Error) => {
        if (!this.peer?.open && !isReconnecting) {
          reject(error);
          return;
        }
        this.emit('error', { error });

        // If we lose connection, start reconnection
        if (this._state === 'connected') {
          this.handleDisconnect();
        }
      });

      this.peer.on('disconnected', () => {
        if (!this.destroyed && this.peer) {
          // Try to reconnect to signaling server
          this.peer.reconnect();
        }
      });
    });
  }

  private async connectToHost(): Promise<void> {
    if (!this.peer) {
      throw new Error('Peer not initialized');
    }

    return new Promise<void>((resolve, reject) => {
      const conn = this.peer!.connect(this.hostId, { reliable: true });
      let settled = false;

      conn.on('open', () => {
        if (settled) {
          return;
        }
        settled = true;
        this.connection = conn;
        this.setupConnectionListeners(conn);

        // If reconnecting with a new peer ID, tell the host our previous ID
        if (this.previousPeerId && this._state === 'reconnecting') {
          try {
            void conn.send({ __type: '__reconnect__', previousId: this.previousPeerId } satisfies InternalMessage);
          } catch {
            // non-critical
          }
        }

        this.previousPeerId = this.peer?.id ?? null;
        const wasReconnecting = this._state === 'reconnecting';
        this.setState('connected');
        this.reconnectAttempt = 0;
        this.lastHeartbeatAck = Date.now();
        this.startHeartbeat();
        this.flushMessageQueue();

        if (wasReconnecting) {
          this.emit('reconnected', undefined as never);
        } else {
          this.emit('connected', undefined as never);
        }
        resolve();
      });

      conn.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        this.emit('error', { error });
      });

      conn.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('Connection closed before opening'));
        }
      });
    });
  }

  private setupConnectionListeners(conn: any): void {
    conn.on('data', (rawData: unknown) => {
      if (isInternalMessage(rawData)) {
        this.handleInternalMessage(rawData);
        return;
      }
      this.emit('data', { data: rawData });
    });

    conn.on('close', () => {
      if (this._state === 'connected') {
        this.handleDisconnect();
      }
    });

    conn.on('error', (error: Error) => {
      this.emit('error', { error });
    });
  }

  private handleInternalMessage(message: InternalMessage): void {
    switch (message.__type) {
      case '__heartbeat__': {
        // Respond to host heartbeat
        try {
          void this.connection?.send({
            __type: '__heartbeat_ack__',
            timestamp: message.timestamp,
          } satisfies InternalMessage);
        } catch {
          // connection may have closed
        }
        break;
      }
      case '__heartbeat_ack__': {
        this.lastHeartbeatAck = Date.now();
        break;
      }
    }
  }

  private handleDisconnect(): void {
    this.stopHeartbeat();
    this.connection = null;

    if (this.destroyed) {
      return;
    }

    this.emit('disconnected', undefined as never);

    if (this.reconnectAttempt < this.maxReconnectAttempts) {
      this.attemptReconnect();
    } else {
      this.setState('closed');
      this.emit('closed', { reason: 'Max reconnection attempts reached' });
    }
  }

  private attemptReconnect(): void {
    this.setState('reconnecting');
    this.reconnectAttempt++;

    this.emit('reconnecting', {
      attempt: this.reconnectAttempt,
      maxAttempts: this.maxReconnectAttempts,
    });

    const delay = Math.min(
      this.reconnectDelay * Math.pow(this.reconnectBackoffMultiplier, this.reconnectAttempt - 1),
      this.maxReconnectDelay,
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.destroyed) {
        return;
      }

      // Clean up old peer
      if (this.peer) {
        try {
          this.peer.destroy();
        } catch {
          // ignore
        }
        this.peer = null;
      }

      void this.createPeerAndConnect().catch(() => {
        // Failed to reconnect, try again
        if (!this.destroyed && this.reconnectAttempt < this.maxReconnectAttempts) {
          this.attemptReconnect();
        } else if (!this.destroyed) {
          this.setState('closed');
          this.emit('closed', { reason: 'Max reconnection attempts reached' });
        }
      });
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.connection) {
        try {
          void this.connection.send({ __type: '__heartbeat__', timestamp: Date.now() } satisfies InternalMessage);
        } catch {
          // connection may have closed
        }
      }
    }, this.heartbeatInterval);

    this.heartbeatCheckTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeatAck > this.heartbeatTimeout && this._state === 'connected') {
        // Heartbeat timeout - connection is dead
        this.stopHeartbeat();
        try {
          this.connection?.close();
        } catch {
          // ignore
        }
        this.handleDisconnect();
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }
  }

  send(data: unknown): void {
    if (this._state === 'connected' && this.connection) {
      void this.connection.send(data);
    } else if (this._state === 'reconnecting') {
      this.messageQueue.push(data);
    } else {
      throw new Error(`Cannot send in state: ${this._state}`);
    }
  }

  private flushMessageQueue(): void {
    if (!this.connection) {
      return;
    }
    const queue = [...this.messageQueue];
    this.messageQueue = [];
    for (const data of queue) {
      try {
        void this.connection.send(data);
      } catch {
        // If sending fails, re-queue
        this.messageQueue.push(data);
        break;
      }
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // ignore
      }
      this.connection = null;
    }

    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
    }

    this.setState('closed');
    this.emit('closed', { reason: 'Manual disconnect' });
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.messageQueue = [];
    this.removeAllListeners();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
