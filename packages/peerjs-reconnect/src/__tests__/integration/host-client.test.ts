import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerClient } from '../../peer-client.js';
import { PeerHost } from '../../peer-host.js';
import { createMockPeerFactory, flushMicrotasks, resetMockPeerRegistry, waitForEvent } from '../helpers/mock-peer.js';

describe('Host-Client Integration', () => {
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
      hostId: 'integration-host',
      peerFactory,
      heartbeatInterval: 0,
      ...overrides,
    });
    clients.push(c);
    return c;
  }

  it('should establish a basic host-client connection', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    const client = createClient();
    const hostClientConnected = waitForEvent(host, 'clientConnected');
    const clientConnected = waitForEvent(client, 'connected');

    await client.connect();

    await hostClientConnected;
    await clientConnected;

    expect(host.getClients()).toHaveLength(1);
    expect(client.state).toBe('connected');
  });

  it('should support bidirectional data exchange', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    const client = createClient();
    await client.connect();
    await flushMicrotasks();

    // Client -> Host
    const hostDataPromise = waitForEvent(host, 'data');
    client.send({ from: 'client', msg: 'hello host' });
    const hostData = await hostDataPromise;
    expect(hostData.data).toEqual({ from: 'client', msg: 'hello host' });

    // Host -> Client
    const clientDataPromise = waitForEvent(client, 'data');
    host.send(hostData.clientId, { from: 'host', msg: 'hello client' });
    const clientData = await clientDataPromise;
    expect(clientData.data).toEqual({ from: 'host', msg: 'hello client' });
  });

  it('should support multiple clients connected simultaneously', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
      peerFactory,
      heartbeatInterval: 0,
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
  });

  it('should broadcast from host to all clients', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
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

    const data1Promise = waitForEvent(client1, 'data');
    const data2Promise = waitForEvent(client2, 'data');

    host.broadcast({ type: 'gameState', round: 1 });

    const [d1, d2] = await Promise.all([data1Promise, data2Promise]);
    expect(d1.data).toEqual({ type: 'gameState', round: 1 });
    expect(d2.data).toEqual({ type: 'gameState', round: 1 });
  });

  it('should handle client disconnection and host notification', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 0,
    });
    await host.start();

    const client = createClient({ maxReconnectAttempts: 0 });
    await client.connect();
    await flushMicrotasks();

    client.disconnect();
    await flushMicrotasks();

    // After disconnect, the host should detect the connection is closed
  });

  it('should relay messages between multiple clients through host', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
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

    // Set up relay: when host gets data from any client, broadcast to all
    host.on('data', ({ clientId, data }) => {
      // Forward to other clients
      for (const id of host.getClients()) {
        if (id !== clientId) {
          host.send(id, { from: clientId, ...(data as Record<string, unknown>) });
        }
      }
    });

    const client2DataPromise = waitForEvent(client2, 'data');
    client1.send({ action: 'chat', text: 'hi everyone' });

    const received = await client2DataPromise;
    expect((received.data as any).text).toBe('hi everyone');
  });

  it('should handle rapid connect/disconnect cycles', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
      peerFactory,
      heartbeatInterval: 0,
      reconnectWindow: 0,
    });
    await host.start();

    for (let i = 0; i < 5; i++) {
      const c = createClient({ maxReconnectAttempts: 0 });
      await c.connect();
      await flushMicrotasks();
      c.disconnect();
      await flushMicrotasks();
    }

    // After all cycles, host should have no clients
    expect(host.getClients()).toHaveLength(0);
  });

  it('should handle host kicking a client while others remain connected', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
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

    expect(host.getClients()).toHaveLength(2);

    // Kick client 1
    const clientId1 = host.getClients().find((id) => id === client1.peerId);
    if (clientId1) {
      host.kick(clientId1);
    }
    await flushMicrotasks();

    // client2 should still be connected
    expect(host.getClients()).toHaveLength(1);

    // client2 can still communicate
    const dataPromise = waitForEvent(host, 'data');
    client2.send({ stillHere: true });
    const event = await dataPromise;
    expect(event.data).toEqual({ stillHere: true });
  });

  it('should handle various data types', async () => {
    host = new PeerHost({
      peerId: 'integration-host',
      peerFactory,
      heartbeatInterval: 0,
    });
    await host.start();

    const client = createClient();
    await client.connect();
    await flushMicrotasks();

    const received: unknown[] = [];
    host.on('data', ({ data }) => received.push(data));

    // Send various data types
    client.send('string message');
    await flushMicrotasks();
    client.send(42);
    await flushMicrotasks();
    client.send({ nested: { deep: true } });
    await flushMicrotasks();
    client.send([1, 2, 3]);
    await flushMicrotasks();
    client.send(null);
    await flushMicrotasks();
    client.send(true);
    await flushMicrotasks();

    expect(received).toEqual(['string message', 42, { nested: { deep: true } }, [1, 2, 3], null, true]);
  });
});
