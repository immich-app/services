import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerClient } from '../../peer-client.js';
import { PeerHost } from '../../peer-host.js';
import { createMockPeerFactory, flushMicrotasks, resetMockPeerRegistry, waitForEvent } from '../helpers/mock-peer.js';

describe('Multi-Client Integration', () => {
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
      hostId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectDelay: 100,
      maxReconnectAttempts: 5,
      ...overrides,
    });
    clients.push(c);
    return c;
  }

  it('should handle 10 simultaneous clients', async () => {
    host = new PeerHost({
      peerId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    for (let i = 0; i < 10; i++) {
      const c = createClient();
      await c.connect();
      await flushMicrotasks();
    }

    expect(host.getClients()).toHaveLength(10);
  });

  it('should broadcast to many clients efficiently', async () => {
    host = new PeerHost({
      peerId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    const clientCount = 5;
    const receivedData: Map<number, unknown[]> = new Map();

    for (let i = 0; i < clientCount; i++) {
      const c = createClient();
      await c.connect();
      await flushMicrotasks();

      receivedData.set(i, []);
      c.on('data', ({ data }) => receivedData.get(i)!.push(data));
    }

    // Broadcast 3 messages
    host.broadcast({ round: 1 });
    host.broadcast({ round: 2 });
    host.broadcast({ round: 3 });
    await flushMicrotasks();

    for (let i = 0; i < clientCount; i++) {
      expect(receivedData.get(i)).toEqual([{ round: 1 }, { round: 2 }, { round: 3 }]);
    }
  });

  it('should handle mixed connect/disconnect of multiple clients', async () => {
    host = new PeerHost({
      peerId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 0,
    });
    await host.start();

    const client1 = createClient({ maxReconnectAttempts: 0 });
    const client2 = createClient({ maxReconnectAttempts: 0 });
    const client3 = createClient({ maxReconnectAttempts: 0 });

    // Connect all
    await client1.connect();
    await flushMicrotasks();
    await client2.connect();
    await flushMicrotasks();
    await client3.connect();
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(3);

    // Disconnect client2
    client2.disconnect();
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(2);

    // Add a new client4
    const client4 = createClient({ maxReconnectAttempts: 0 });
    await client4.connect();
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(3);

    // Disconnect client1
    client1.disconnect();
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(2);

    // Remaining should be client3 and client4
    const remaining = host.getClients();
    expect(remaining).toContain(client3.peerId);
    expect(remaining).toContain(client4.peerId);
  });

  it('should isolate data between clients (no cross-talk)', async () => {
    host = new PeerHost({
      peerId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    const client1 = createClient();
    const client2 = createClient();

    await client1.connect();
    await flushMicrotasks();
    await client2.connect();
    await flushMicrotasks();

    // Send targeted message only to client1
    const client1Data: unknown[] = [];
    const client2Data: unknown[] = [];
    client1.on('data', ({ data }) => client1Data.push(data));
    client2.on('data', ({ data }) => client2Data.push(data));

    host.send(client1.peerId!, { private: 'for client1 only' });
    await flushMicrotasks();

    expect(client1Data).toEqual([{ private: 'for client1 only' }]);
    expect(client2Data).toEqual([]);
  });

  it('should track which client sent data to host', async () => {
    host = new PeerHost({
      peerId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    const client1 = createClient();
    const client2 = createClient();

    await client1.connect();
    await flushMicrotasks();
    await client2.connect();
    await flushMicrotasks();

    const received: Array<{ clientId: string; data: unknown }> = [];
    host.on('data', (event) => received.push(event));

    client1.send({ from: 'c1' });
    await flushMicrotasks();
    client2.send({ from: 'c2' });
    await flushMicrotasks();

    expect(received).toHaveLength(2);
    expect(received[0].clientId).toBe(client1.peerId);
    expect(received[0].data).toEqual({ from: 'c1' });
    expect(received[1].clientId).toBe(client2.peerId);
    expect(received[1].data).toEqual({ from: 'c2' });
  });

  it('should handle all clients reconnecting simultaneously', async () => {
    host = new PeerHost({
      peerId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 30_000,
    });
    await host.start();

    const client1 = createClient();
    const client2 = createClient();
    const client3 = createClient();

    await client1.connect();
    await flushMicrotasks();
    await client2.connect();
    await flushMicrotasks();
    await client3.connect();
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(3);

    // Kick all clients at once
    for (const id of host.getClients()) {
      host.kick(id);
    }
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(0);

    // All clients should be reconnecting
    expect(client1.state).toBe('reconnecting');
    expect(client2.state).toBe('reconnecting');
    expect(client3.state).toBe('reconnecting');

    // Let them all reconnect
    const r1 = waitForEvent(client1, 'reconnected');
    const r2 = waitForEvent(client2, 'reconnected');
    const r3 = waitForEvent(client3, 'reconnected');

    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();

    await Promise.all([r1, r2, r3]);

    expect(host.getClients()).toHaveLength(3);
    expect(client1.state).toBe('connected');
    expect(client2.state).toBe('connected');
    expect(client3.state).toBe('connected');
  });

  it('should handle a game lobby scenario: join, play, leave', async () => {
    host = new PeerHost({
      peerId: 'multi-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 5000,
    });
    await host.start();

    // Phase 1: Players join
    const players = [
      createClient({ maxReconnectAttempts: 0 }),
      createClient({ maxReconnectAttempts: 0 }),
      createClient({ maxReconnectAttempts: 0 }),
    ];

    for (const p of players) {
      await p.connect();
      await flushMicrotasks();
    }

    expect(host.getClients()).toHaveLength(3);

    // Phase 2: Host broadcasts game start
    const receivedByPlayers: Map<number, unknown[]> = new Map();
    for (let i = 0; i < players.length; i++) {
      receivedByPlayers.set(i, []);
      players[i].on('data', ({ data }) => receivedByPlayers.get(i)!.push(data));
    }

    host.broadcast({ type: 'gameStart', players: host.getClients() });
    await flushMicrotasks();

    for (let i = 0; i < 3; i++) {
      expect(receivedByPlayers.get(i)![0]).toHaveProperty('type', 'gameStart');
    }

    // Phase 3: Players send moves
    for (let i = 0; i < players.length; i++) {
      players[i].send({ type: 'move', player: i, action: 'roll' });
    }
    await flushMicrotasks();

    // Phase 4: One player leaves
    players[1].disconnect();
    await flushMicrotasks();

    expect(host.getClients()).toHaveLength(2);

    // Phase 5: Remaining players can still play
    host.broadcast({ type: 'playerLeft', player: 1 });
    await flushMicrotasks();

    expect(receivedByPlayers.get(0)).toContainEqual({ type: 'playerLeft', player: 1 });
    expect(receivedByPlayers.get(2)).toContainEqual({ type: 'playerLeft', player: 1 });
  });
});
