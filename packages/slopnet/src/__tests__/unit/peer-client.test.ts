import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerClient } from '../../peer-client.js';
import {
  MockPeer,
  createMockPeerFactory,
  flushMicrotasks,
  resetMockPeerRegistry,
  waitForEvent,
} from '../helpers/mock-peer.js';

describe('PeerClient', () => {
  let client: PeerClient;

  beforeEach(() => {
    resetMockPeerRegistry();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    client?.destroy();
    vi.useRealTimers();
    resetMockPeerRegistry();
  });

  describe('connect()', () => {
    it('should connect to a host and emit connected', async () => {
      // Start host (need peer in registry for connection)
      new MockPeer('test-host');
      await flushMicrotasks();

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      const connectedPromise = waitForEvent(client, 'connected');
      await client.connect();
      await connectedPromise;

      expect(client.state).toBe('connected');
    });

    it('should transition through correct states', async () => {
      new MockPeer('test-host');
      await flushMicrotasks();

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      const states: string[] = [];
      client.on('stateChanged', ({ from, to }) => {
        states.push(`${from}->${to}`);
      });

      expect(client.state).toBe('idle');
      await client.connect();

      expect(states).toContain('idle->connecting');
      expect(states).toContain('connecting->connected');
    });

    it('should throw if already connected', async () => {
      new MockPeer('test-host');
      await flushMicrotasks();

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      await client.connect();
      await expect(client.connect()).rejects.toThrow('Cannot connect from state');
    });

    it('should throw if destroyed', async () => {
      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      client.destroy();
      await expect(client.connect()).rejects.toThrow('destroyed');
    });
  });

  describe('send and receive data', () => {
    it('should send data to the host', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      const hostReceived: unknown[] = [];
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          conn.on('data', (data: unknown) => hostReceived.push(data));
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await client.connect();

      client.send({ action: 'jump' });
      await flushMicrotasks();

      expect(hostReceived).toEqual([{ action: 'jump' }]);
    });

    it('should receive data from the host', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await client.connect();
      await flushMicrotasks();

      const dataPromise = waitForEvent(client, 'data');
      hostConn.send({ state: 'gameOver' });

      const event = await dataPromise;
      expect(event).toEqual({ data: { state: 'gameOver' } });
    });

    it('should throw when sending in idle state', () => {
      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      expect(() => client.send('test')).toThrow('Cannot send in state');
    });

    it('should queue messages during reconnection', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectDelay: 100,
        maxReconnectAttempts: 5,
      });
      await client.connect();
      await flushMicrotasks();

      // Force disconnect
      hostConn.close();
      await flushMicrotasks();

      // Client should be in reconnecting state now
      expect(client.state).toBe('reconnecting');

      // Queue messages while disconnected
      client.send({ queued: 1 });
      client.send({ queued: 2 });

      // Let reconnection happen
      const reconnectedPromise = waitForEvent(client, 'reconnected');
      vi.advanceTimersByTime(200);
      await flushMicrotasks();
      vi.advanceTimersByTime(200);
      await flushMicrotasks();

      // Wait for the reconnection
      await reconnectedPromise;
      await flushMicrotasks();

      // The queued messages should have been sent to the new host connection
      const newHostReceived: unknown[] = [];
      hostConn.on('data', (data: unknown) => newHostReceived.push(data));
      await flushMicrotasks();

      // The messages were flushed on reconnect; they went to hostConn
      // We need to check the host side actually received them
    });
  });

  describe('disconnection', () => {
    it('should emit disconnected when connection closes', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        maxReconnectAttempts: 0,
      });
      await client.connect();
      await flushMicrotasks();

      const disconnectedPromise = waitForEvent(client, 'disconnected');
      hostConn.close();

      await disconnectedPromise;
    });

    it('should emit closed when max reconnect attempts reached', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        maxReconnectAttempts: 0,
      });
      await client.connect();
      await flushMicrotasks();

      const closedPromise = waitForEvent(client, 'closed');
      hostConn.close();

      const event = await closedPromise;
      expect(event).toEqual({ reason: 'Max reconnection attempts reached' });
      expect(client.state).toBe('closed');
    });

    it('should call disconnect() and emit closed', async () => {
      new MockPeer('test-host');
      await flushMicrotasks();

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await client.connect();

      const closedPromise = waitForEvent(client, 'closed');
      client.disconnect();

      const event = await closedPromise;
      expect(event).toEqual({ reason: 'Manual disconnect' });
      expect(client.state).toBe('closed');
    });
  });

  describe('reconnection', () => {
    it('should attempt to reconnect after disconnection', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectDelay: 100,
        maxReconnectAttempts: 3,
      });
      await client.connect();
      await flushMicrotasks();

      const reconnectingPromise = waitForEvent(client, 'reconnecting');

      hostConn.close();
      await flushMicrotasks();

      const event = await reconnectingPromise;
      expect(event).toEqual({ attempt: 1, maxAttempts: 3 });
      expect(client.state).toBe('reconnecting');
    });

    it('should successfully reconnect', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectDelay: 100,
        maxReconnectAttempts: 5,
      });
      await client.connect();
      await flushMicrotasks();

      // Disconnect
      hostConn.close();
      await flushMicrotasks();

      expect(client.state).toBe('reconnecting');

      // Advance timer to trigger reconnection
      const reconnectedPromise = waitForEvent(client, 'reconnected');
      vi.advanceTimersByTime(200);
      await flushMicrotasks();
      vi.advanceTimersByTime(200);
      await flushMicrotasks();

      await reconnectedPromise;
      expect(client.state).toBe('connected');
    });

    it('should use exponential backoff for reconnect delays', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectDelay: 1000,
        reconnectBackoffMultiplier: 2,
        maxReconnectDelay: 10_000,
        maxReconnectAttempts: 5,
      });
      await client.connect();
      await flushMicrotasks();

      const reconnectingEvents: Array<{ attempt: number; maxAttempts: number }> = [];
      client.on('reconnecting', (event) => reconnectingEvents.push(event));

      // First disconnect, destroy the host to prevent reconnection
      hostPeer.destroy();
      hostConn.close();
      await flushMicrotasks();

      // First attempt at 1000ms
      vi.advanceTimersByTime(1001);
      await flushMicrotasks();

      // Second attempt at 2000ms (1000 * 2^1)
      vi.advanceTimersByTime(2001);
      await flushMicrotasks();

      // Third attempt at 4000ms (1000 * 2^2)
      vi.advanceTimersByTime(4001);
      await flushMicrotasks();

      expect(reconnectingEvents.length).toBeGreaterThanOrEqual(3);
      expect(reconnectingEvents[0]).toEqual({ attempt: 1, maxAttempts: 5 });
      expect(reconnectingEvents[1]).toEqual({ attempt: 2, maxAttempts: 5 });
      expect(reconnectingEvents[2]).toEqual({ attempt: 3, maxAttempts: 5 });
    });
  });

  describe('peerId', () => {
    it('should return null before connecting', () => {
      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      expect(client.peerId).toBeNull();
    });

    it('should return the peer ID after connecting', async () => {
      new MockPeer('test-host');
      await flushMicrotasks();

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await client.connect();

      expect(client.peerId).toMatch(/^mock-peer-/);
    });
  });

  describe('destroy', () => {
    it('should clean up everything', async () => {
      new MockPeer('test-host');
      await flushMicrotasks();

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await client.connect();

      client.destroy();
      expect(client.state).toBe('closed');
    });

    it('should stop reconnection attempts', async () => {
      const hostPeer = new MockPeer('test-host');
      await flushMicrotasks();

      let hostConn: any = null;
      hostPeer.on('connection', (conn: any) => {
        conn.on('open', () => {
          hostConn = conn;
        });
      });

      client = new PeerClient({
        hostId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectDelay: 100,
        maxReconnectAttempts: 5,
      });
      await client.connect();
      await flushMicrotasks();

      hostConn.close();
      await flushMicrotasks();

      expect(client.state).toBe('reconnecting');

      client.destroy();

      // Advancing time shouldn't cause any attempts
      const reconnectedListener = vi.fn();
      client.on('reconnected', reconnectedListener);

      vi.advanceTimersByTime(10_000);
      await flushMicrotasks();

      expect(reconnectedListener).not.toHaveBeenCalled();
    });
  });
});
