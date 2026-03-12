import { EventEmitter } from 'node:events';

/**
 * Mock PeerJS implementation for testing.
 *
 * Uses an in-memory "signaling registry" to simulate PeerJS connections
 * without requiring WebRTC or a real signaling server.
 */

// Global registry of mock peers (simulates signaling server)
const peerRegistry = new Map<string, MockPeer>();

let idCounter = 0;

export function resetMockPeerRegistry(): void {
  for (const peer of peerRegistry.values()) {
    peer.destroy();
  }
  peerRegistry.clear();
  idCounter = 0;
}

export class MockDataConnection extends EventEmitter {
  open = false;
  readonly peer: string;
  readonly reliable: boolean;
  private _remotePeer: MockDataConnection | null = null;
  private _closed = false;

  constructor(peer: string, options?: { reliable?: boolean }) {
    super();
    this.peer = peer;
    this.reliable = options?.reliable ?? false;
  }

  /** Link two connections together (simulates signaling handshake) */
  _linkTo(remote: MockDataConnection): void {
    this._remotePeer = remote;
  }

  _simulateOpen(): void {
    if (this._closed) {
      return;
    }
    this.open = true;
    // Defer to simulate async behavior
    queueMicrotask(() => {
      if (!this._closed) {
        this.emit('open');
      }
    });
  }

  send(data: unknown): void {
    if (this._closed || !this.open) {
      throw new Error('Connection is not open');
    }
    if (this._remotePeer && !this._remotePeer._closed) {
      const remote = this._remotePeer;
      // Simulate async data delivery
      queueMicrotask(() => {
        if (!remote._closed && remote.open) {
          remote.emit('data', data);
        }
      });
    }
  }

  close(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this.open = false;

    // Notify remote end
    if (this._remotePeer && !this._remotePeer._closed) {
      const remote = this._remotePeer;
      queueMicrotask(() => {
        remote._simulateRemoteClose();
      });
    }

    queueMicrotask(() => {
      this.emit('close');
    });
  }

  _simulateRemoteClose(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this.open = false;
    queueMicrotask(() => {
      this.emit('close');
    });
  }

  _simulateError(error: Error): void {
    queueMicrotask(() => {
      this.emit('error', error);
    });
  }

  /** Forcefully kill the connection without notifying the remote end (simulates network failure) */
  _simulateNetworkDeath(): void {
    this._closed = true;
    this.open = false;
    this._remotePeer = null;
    queueMicrotask(() => {
      this.emit('close');
    });
  }
}

export class MockPeer extends EventEmitter {
  id: string;
  open = false;
  destroyed = false;
  disconnected = false;

  private _connections = new Map<string, MockDataConnection[]>();
  private _openDelay: number;

  constructor(
    id?: string,
    private _options?: Record<string, unknown>,
  ) {
    super();
    this.id = id ?? `mock-peer-${++idCounter}`;
    this._openDelay = (_options?.openDelay as number) ?? 0;

    // Auto-register and "open" after a microtask (simulates signaling server connection)
    queueMicrotask(() => {
      if (!this.destroyed) {
        this._register();
      }
    });
  }

  private _register(): void {
    if (peerRegistry.has(this.id)) {
      const error = new Error(`ID "${this.id}" is taken`);
      (error as any).type = 'unavailable-id';
      this.emit('error', error);
      return;
    }

    const doOpen = () => {
      if (this.destroyed) {
        return;
      }
      peerRegistry.set(this.id, this);
      this.open = true;
      this.disconnected = false;
      this.emit('open', this.id);
    };

    if (this._openDelay > 0) {
      setTimeout(doOpen, this._openDelay);
    } else {
      doOpen();
    }
  }

  connect(remoteId: string, options?: { reliable?: boolean }): MockDataConnection {
    if (this.destroyed) {
      throw new Error('Peer is destroyed');
    }

    const localConn = new MockDataConnection(remoteId, options);
    if (!this._connections.has(remoteId)) {
      this._connections.set(remoteId, []);
    }
    this._connections.get(remoteId)!.push(localConn);

    // Simulate async connection establishment
    queueMicrotask(() => {
      if (this.destroyed) {
        return;
      }

      const remotePeer = peerRegistry.get(remoteId);
      if (!remotePeer || remotePeer.destroyed) {
        localConn._simulateError(new Error(`Could not connect to peer ${remoteId}`));
        return;
      }

      // Create remote-side connection
      const remoteConn = new MockDataConnection(this.id, options);
      if (!remotePeer._connections.has(this.id)) {
        remotePeer._connections.set(this.id, []);
      }
      remotePeer._connections.get(this.id)!.push(remoteConn);

      // Link them bidirectionally
      localConn._linkTo(remoteConn);
      remoteConn._linkTo(localConn);

      // Notify remote peer of incoming connection
      remotePeer.emit('connection', remoteConn);

      // Open both connections
      localConn._simulateOpen();
      remoteConn._simulateOpen();
    });

    return localConn;
  }

  reconnect(): void {
    if (this.destroyed) {
      return;
    }
    if (!this.disconnected) {
      return;
    }

    queueMicrotask(() => {
      if (!this.destroyed) {
        peerRegistry.set(this.id, this);
        this.open = true;
        this.disconnected = false;
        this.emit('open', this.id);
      }
    });
  }

  disconnect(): void {
    if (this.destroyed) {
      return;
    }
    this.open = false;
    this.disconnected = true;
    peerRegistry.delete(this.id);
    this.emit('disconnected');
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.open = false;
    this.disconnected = true;

    // Close all connections
    for (const conns of this._connections.values()) {
      for (const conn of conns) {
        if (conn.open) {
          conn.close();
        }
      }
    }
    this._connections.clear();

    peerRegistry.delete(this.id);
    this.emit('close');
    this.removeAllListeners();
  }

  /** Simulate the signaling server going down (peer gets disconnected) */
  _simulateSignalingDisconnect(): void {
    this.open = false;
    this.disconnected = true;
    peerRegistry.delete(this.id);
    this.emit('disconnected');
  }

  /** Simulate a network failure that kills all connections without clean close */
  _simulateNetworkFailure(): void {
    for (const conns of this._connections.values()) {
      for (const conn of conns) {
        if (conn.open) {
          conn._simulateNetworkDeath();
        }
      }
    }
    this._connections.clear();
  }
}

/**
 * Creates a peer factory function for use with PeerHost/PeerClient options.
 * This replaces the real PeerJS Peer constructor with MockPeer.
 */
export function createMockPeerFactory(options?: { openDelay?: number }): (id: string | undefined) => MockPeer {
  return (id: string | undefined) => {
    return new MockPeer(id ?? undefined, { openDelay: options?.openDelay ?? 0 }) as any;
  };
}

/** Wait for a specified number of milliseconds */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flush all queued microtasks and timers */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait for an event to be emitted, with timeout */
export function waitForEvent(emitter: any, event: string, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event "${event}" after ${timeout}ms`));
    }, timeout);

    emitter.on(event, (data: any) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
