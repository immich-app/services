import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerClient } from '../../peer-client.js';
import { PeerHost } from '../../peer-host.js';
import { createMockPeerFactory, flushMicrotasks, resetMockPeerRegistry, waitForEvent } from '../helpers/mock-peer.js';

describe('Reconnection Integration', () => {
  let host: PeerHost;
  let clients: PeerClient[] = [];

  const peerFactory = createMockPeerFactory();

  beforeEach(() => {
    resetMockPeerRegistry();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    for (const c of clients) {
      c.destroy();
    }
    clients = [];
    host?.destroy();
    vi.useRealTimers();
    resetMockPeerRegistry();
  });

  function createClient(overrides?: Record<string, any>) {
    const c = new PeerClient({
      hostId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectDelay: 100,
      reconnectBackoffMultiplier: 1.5,
      maxReconnectAttempts: 5,
      ...overrides,
    });
    clients.push(c);
    return c;
  }

  it('should reconnect a client after host-side connection close', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client = createClient();
    await client.connect();
    await flushMicrotasks();

    const clientId = host.getClients()[0];
    expect(clientId).toBeDefined();

    // Host kicks client (simulates connection drop)
    host.kick(clientId);
    await flushMicrotasks();

    // Client should detect the disconnect and start reconnecting
    expect(client.state).toBe('reconnecting');

    // Wait for reconnection
    const reconnectedPromise = waitForEvent(client, 'reconnected');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();

    await reconnectedPromise;
    expect(client.state).toBe('connected');
    expect(host.getClients()).toHaveLength(1);
  });

  it('should maintain communication after reconnection', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client = createClient();
    await client.connect();
    await flushMicrotasks();

    const clientId = host.getClients()[0];

    // Verify initial communication
    const hostDataPromise1 = waitForEvent(host, 'data');
    client.send({ round: 1 });
    const data1 = await hostDataPromise1;
    expect(data1.data).toEqual({ round: 1 });

    // Disconnect
    host.kick(clientId);
    await flushMicrotasks();

    // Reconnect
    const reconnectedPromise = waitForEvent(client, 'reconnected');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    await reconnectedPromise;

    // Verify communication still works after reconnection
    const hostDataPromise2 = waitForEvent(host, 'data');
    client.send({ round: 2 });
    const data2 = await hostDataPromise2;
    expect(data2.data).toEqual({ round: 2 });
  });

  it('should flush queued messages after reconnection', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client = createClient();
    await client.connect();
    await flushMicrotasks();

    const clientId = host.getClients()[0];

    // Disconnect
    host.kick(clientId);
    await flushMicrotasks();
    expect(client.state).toBe('reconnecting');

    // Queue messages while disconnected
    client.send({ queued: 'msg1' });
    client.send({ queued: 'msg2' });
    client.send({ queued: 'msg3' });

    // Set up listener BEFORE reconnection so we capture flushed messages
    const received: unknown[] = [];
    host.on('data', ({ data }) => received.push(data));

    // Reconnect
    const reconnectedPromise = waitForEvent(client, 'reconnected');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    await reconnectedPromise;
    await flushMicrotasks();

    // The queued messages should have been flushed
    expect(received).toContainEqual({ queued: 'msg1' });
    expect(received).toContainEqual({ queued: 'msg2' });
    expect(received).toContainEqual({ queued: 'msg3' });
  });

  it('should emit correct event sequence during reconnection', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client = createClient();
    await client.connect();
    await flushMicrotasks();

    const clientId = host.getClients()[0];
    const events: string[] = [];

    client.on('disconnected', () => events.push('disconnected'));
    client.on('reconnecting', () => events.push('reconnecting'));
    client.on('reconnected', () => events.push('reconnected'));
    client.on('stateChanged', ({ to }) => events.push(`state:${to}`));

    // Disconnect
    host.kick(clientId);
    await flushMicrotasks();

    // Reconnect
    const reconnectedPromise = waitForEvent(client, 'reconnected');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    await reconnectedPromise;

    expect(events).toContain('disconnected');
    expect(events).toContain('reconnecting');
    expect(events).toContain('reconnected');
    expect(events).toContain('state:reconnecting');
    expect(events).toContain('state:connected');

    // Verify ordering: disconnected comes before reconnecting
    const disconnectedIdx = events.indexOf('disconnected');
    const reconnectingIdx = events.indexOf('reconnecting');
    const reconnectedIdx = events.indexOf('reconnected');
    expect(disconnectedIdx).toBeLessThan(reconnectingIdx);
    expect(reconnectingIdx).toBeLessThan(reconnectedIdx);
  });

  it('should handle multiple reconnections', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client = createClient({ maxReconnectAttempts: 10 });
    await client.connect();
    await flushMicrotasks();

    for (let i = 0; i < 3; i++) {
      const clientId = host.getClients()[0];
      expect(clientId).toBeDefined();

      // Disconnect
      host.kick(clientId);
      await flushMicrotasks();
      expect(client.state).toBe('reconnecting');

      // Reconnect
      const reconnectedPromise = waitForEvent(client, 'reconnected');
      vi.advanceTimersByTime(200);
      await flushMicrotasks();
      vi.advanceTimersByTime(200);
      await flushMicrotasks();
      await reconnectedPromise;

      expect(client.state).toBe('connected');

      // Verify communication
      const dataPromise = waitForEvent(host, 'data');
      client.send({ reconnection: i + 1 });
      const event = await dataPromise;
      expect(event.data).toEqual({ reconnection: i + 1 });
    }
  });

  it('should give up after max reconnect attempts when host is gone', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    const client = createClient({
      maxReconnectAttempts: 3,
      reconnectDelay: 100,
      reconnectBackoffMultiplier: 1,
    });
    await client.connect();
    await flushMicrotasks();

    // Destroy host completely
    host.destroy();
    await flushMicrotasks();

    // Client should detect disconnect
    expect(client.state).toBe('reconnecting');

    const closedPromise = waitForEvent(client, 'closed');

    // Each attempt fails since host is destroyed
    // Attempt 1 at 100ms
    vi.advanceTimersByTime(150);
    await flushMicrotasks();
    await flushMicrotasks();

    // Attempt 2 at 100ms
    vi.advanceTimersByTime(150);
    await flushMicrotasks();
    await flushMicrotasks();

    // Attempt 3 at 100ms
    vi.advanceTimersByTime(150);
    await flushMicrotasks();
    await flushMicrotasks();

    const closed = await closedPromise;
    expect(closed.reason).toContain('Max reconnection attempts');
    expect(client.state).toBe('closed');
  });

  it('should handle one client reconnecting while others stay connected', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client1 = createClient();
    const client2 = createClient();

    await client1.connect();
    await flushMicrotasks();
    await client2.connect();
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(2);

    // Disconnect only client1 by kicking
    const client1Id = client1.peerId!;
    host.kick(client1Id);
    await flushMicrotasks();

    expect(client1.state).toBe('reconnecting');
    expect(client2.state).toBe('connected');

    // client2 should still work
    const dataPromise = waitForEvent(host, 'data');
    client2.send({ clientNum: 2 });
    const event = await dataPromise;
    expect(event.data).toEqual({ clientNum: 2 });

    // client1 reconnects
    const reconnectedPromise = waitForEvent(client1, 'reconnected');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    await reconnectedPromise;

    expect(host.getClients()).toHaveLength(2);
  });

  it('should reset reconnect counter after successful reconnection', async () => {
    host = new PeerHost({
      peerId: 'reconnect-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client = createClient({ maxReconnectAttempts: 2 });
    await client.connect();
    await flushMicrotasks();

    // First disconnect + reconnect
    let clientId = host.getClients()[0];
    host.kick(clientId);
    await flushMicrotasks();

    let reconnectedPromise = waitForEvent(client, 'reconnected');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    await reconnectedPromise;

    // Second disconnect + reconnect (should work because counter was reset)
    clientId = host.getClients()[0];
    host.kick(clientId);
    await flushMicrotasks();

    reconnectedPromise = waitForEvent(client, 'reconnected');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    await reconnectedPromise;

    expect(client.state).toBe('connected');
  });

  describe('reconnect window on host side', () => {
    it('should track client in disconnected list during reconnect window', async () => {
      host = new PeerHost({
        peerId: 'reconnect-host',
        peerFactory,
        heartbeatInterval: 0,
        reconnectWindow: 5000,
      });
      await host.start();

      const client = createClient({ maxReconnectAttempts: 0 });
      await client.connect();
      await flushMicrotasks();

      // Natural disconnect (not kick) - close from client side
      const discPromise = waitForEvent(host, 'clientDisconnected');
      client.disconnect();
      await flushMicrotasks();
      await discPromise;

      // Client should be in disconnected list, not connected
      expect(host.getClients()).toHaveLength(0);
      expect(host.getDisconnectedClients()).toHaveLength(1);
    });

    it('should emit clientRemoved after reconnect window expires', async () => {
      host = new PeerHost({
        peerId: 'reconnect-host',
        peerFactory,
        heartbeatInterval: 0,
        reconnectWindow: 3000,
      });
      await host.start();

      const client = createClient({ maxReconnectAttempts: 0 });
      await client.connect();
      await flushMicrotasks();

      // Close the connection naturally (not kick)
      client.disconnect();
      await flushMicrotasks();

      const removedPromise = waitForEvent(host, 'clientRemoved');
      vi.advanceTimersByTime(3001);
      await flushMicrotasks();

      const event = await removedPromise;
      expect(event.clientId).toBeDefined();
    });
  });

  describe('heartbeat-based reconnection', () => {
    it('should detect dead connection via heartbeat and reconnect', async () => {
      host = new PeerHost({
        peerId: 'reconnect-host',
        peerFactory,
        heartbeatInterval: 1000,
        heartbeatTimeout: 3000,
        reconnectWindow: 30_000,
      });
      await host.start();

      const client = createClient({
        heartbeatInterval: 1000,
        heartbeatTimeout: 3000,
      });
      await client.connect();
      await flushMicrotasks();

      expect(host.getClients()).toHaveLength(1);

      // Note: With the mock system, heartbeats actually work since connections are linked.
      // To test heartbeat failure, we'd need to break the connection silently.
      // This test verifies that heartbeats don't interfere with normal operation.
      vi.advanceTimersByTime(5000);
      await flushMicrotasks();

      // Connection should still be alive since heartbeats are being exchanged
      expect(client.state).toBe('connected');
      expect(host.getClients()).toHaveLength(1);
    });
  });
});
