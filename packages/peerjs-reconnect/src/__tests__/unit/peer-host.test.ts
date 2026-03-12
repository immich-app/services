import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerHost } from '../../peer-host.js';
import {
  MockPeer,
  createMockPeerFactory,
  flushMicrotasks,
  resetMockPeerRegistry,
  waitForEvent,
} from '../helpers/mock-peer.js';

describe('PeerHost', () => {
  let host: PeerHost;

  beforeEach(() => {
    resetMockPeerRegistry();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    host?.destroy();
    vi.useRealTimers();
    resetMockPeerRegistry();
  });

  describe('start()', () => {
    it('should start and emit started event', async () => {
      host = new PeerHost({
        peerId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      const startedPromise = waitForEvent(host, 'started');
      const peerId = await host.start();

      expect(peerId).toBe('test-host');
      const event = await startedPromise;
      expect(event).toEqual({ peerId: 'test-host' });
    });

    it('should auto-generate an ID if none provided', async () => {
      host = new PeerHost({
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      const peerId = await host.start();
      expect(peerId).toMatch(/^mock-peer-/);
    });

    it('should throw if started twice', async () => {
      host = new PeerHost({
        peerId: 'test-host',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      await host.start();
      await expect(host.start()).rejects.toThrow('already started');
    });

    it('should throw if destroyed', async () => {
      host = new PeerHost({
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });

      host.destroy();
      await expect(host.start()).rejects.toThrow('destroyed');
    });
  });

  describe('client connections', () => {
    it('should emit clientConnected when a client connects', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const connectedPromise = waitForEvent(host, 'clientConnected');

      // Simulate a client connecting
      const clientPeer = new MockPeer('client-1');
      await flushMicrotasks();
      clientPeer.connect('host-1');

      const event = await connectedPromise;
      expect(event).toEqual({ clientId: 'client-1' });
      expect(host.getClients()).toContain('client-1');
    });

    it('should track multiple clients', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const client1 = new MockPeer('client-1');
      const client2 = new MockPeer('client-2');
      await flushMicrotasks();

      const p1 = waitForEvent(host, 'clientConnected');
      client1.connect('host-1');
      await p1;

      const p2 = waitForEvent(host, 'clientConnected');
      client2.connect('host-1');
      await p2;

      expect(host.getClients()).toHaveLength(2);
      expect(host.getClients()).toContain('client-1');
      expect(host.getClients()).toContain('client-2');
    });

    it('should report isClientConnected correctly', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      expect(host.isClientConnected('client-1')).toBe(false);

      const client = new MockPeer('client-1');
      await flushMicrotasks();
      const p = waitForEvent(host, 'clientConnected');
      client.connect('host-1');
      await p;

      expect(host.isClientConnected('client-1')).toBe(true);
    });
  });

  describe('data messaging', () => {
    it('should emit data event when receiving data from a client', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;

      // Wait for client's connection to open
      await new Promise<void>((resolve) => conn.on('open', resolve));

      const dataPromise = waitForEvent(host, 'data');
      conn.send({ action: 'move', x: 10, y: 20 });

      const event = await dataPromise;
      expect(event).toEqual({ clientId: 'client-1', data: { action: 'move', x: 10, y: 20 } });
    });

    it('should not emit data event for internal heartbeat messages', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      const dataListener = vi.fn();
      host.on('data', dataListener);

      // Send an internal message
      conn.send({ __type: '__heartbeat__', timestamp: Date.now() });
      await flushMicrotasks();

      expect(dataListener).not.toHaveBeenCalled();
    });

    it('should send data to a specific client', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      const received: unknown[] = [];
      conn.on('data', (data: unknown) => received.push(data));

      host.send('client-1', { message: 'hello' });
      await flushMicrotasks();

      expect(received).toEqual([{ message: 'hello' }]);
    });

    it('should throw when sending to non-existent client', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      expect(() => host.send('nobody', { test: true })).toThrow('not connected');
    });

    it('should broadcast to all connected clients', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const client1 = new MockPeer('client-1');
      const client2 = new MockPeer('client-2');
      await flushMicrotasks();

      const p1 = waitForEvent(host, 'clientConnected');
      const conn1 = client1.connect('host-1');
      await p1;
      await new Promise<void>((resolve) => conn1.on('open', resolve));

      const p2 = waitForEvent(host, 'clientConnected');
      const conn2 = client2.connect('host-1');
      await p2;
      await new Promise<void>((resolve) => conn2.on('open', resolve));

      const received1: unknown[] = [];
      const received2: unknown[] = [];
      conn1.on('data', (data: unknown) => received1.push(data));
      conn2.on('data', (data: unknown) => received2.push(data));

      host.broadcast({ game: 'update' });
      await flushMicrotasks();

      expect(received1).toEqual([{ game: 'update' }]);
      expect(received2).toEqual([{ game: 'update' }]);
    });
  });

  describe('client disconnection', () => {
    it('should emit clientDisconnected when a client connection closes', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectWindow: 30_000,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      const disconnectedPromise = waitForEvent(host, 'clientDisconnected');
      conn.close();
      const event = await disconnectedPromise;

      expect(event).toEqual({ clientId: 'client-1' });
      expect(host.getClients()).not.toContain('client-1');
      expect(host.getDisconnectedClients()).toContain('client-1');
    });

    it('should emit clientRemoved after reconnect window expires', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectWindow: 5000,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      const removedPromise = waitForEvent(host, 'clientRemoved');
      conn.close();

      // Advance time past the reconnect window
      vi.advanceTimersByTime(5001);
      const event = await removedPromise;

      expect(event).toEqual({ clientId: 'client-1' });
      expect(host.getDisconnectedClients()).not.toContain('client-1');
    });

    it('should emit clientRemoved immediately when reconnectWindow is 0', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectWindow: 0,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      const removedListener = vi.fn();
      host.on('clientRemoved', removedListener);

      conn.close();
      await flushMicrotasks();

      expect(removedListener).toHaveBeenCalledWith({ clientId: 'client-1' });
    });
  });

  describe('client reconnection', () => {
    it('should emit clientReconnected when a disconnected client reconnects', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectWindow: 30_000,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      // Connect
      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      // Disconnect
      const disconnectedP = waitForEvent(host, 'clientDisconnected');
      conn.close();
      await disconnectedP;

      expect(host.getDisconnectedClients()).toContain('client-1');

      // Reconnect (same peer ID)
      const reconnectedP = waitForEvent(host, 'clientReconnected');
      client.connect('host-1');
      const event = await reconnectedP;

      expect(event).toEqual({ clientId: 'client-1' });
      expect(host.getClients()).toContain('client-1');
      expect(host.getDisconnectedClients()).not.toContain('client-1');
    });
  });

  describe('kick', () => {
    it('should kick a connected client', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      client.connect('host-1');
      await connP;

      const removedListener = vi.fn();
      host.on('clientRemoved', removedListener);

      host.kick('client-1');
      expect(host.getClients()).not.toContain('client-1');
      expect(removedListener).toHaveBeenCalledWith({ clientId: 'client-1' });
    });

    it('should kick a disconnected client waiting to reconnect', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
        reconnectWindow: 30_000,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      const discP = waitForEvent(host, 'clientDisconnected');
      conn.close();
      await discP;

      const removedListener = vi.fn();
      host.on('clientRemoved', removedListener);

      host.kick('client-1');
      expect(host.getDisconnectedClients()).not.toContain('client-1');
      expect(removedListener).toHaveBeenCalledWith({ clientId: 'client-1' });
    });
  });

  describe('heartbeat', () => {
    it('should detect dead clients via heartbeat timeout', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 1000,
        heartbeatTimeout: 3000,
        reconnectWindow: 30_000,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();

      const connP = waitForEvent(host, 'clientConnected');
      const conn = client.connect('host-1');
      await connP;
      await new Promise<void>((resolve) => conn.on('open', resolve));

      // Prevent client from responding to heartbeats
      conn.removeAllListeners('data');
      conn.on('data', () => {
        // swallow all data - don't respond to heartbeats
      });

      const disconnectedPromise = waitForEvent(host, 'clientDisconnected');

      // Advance past heartbeat timeout
      vi.advanceTimersByTime(4000);
      await flushMicrotasks();

      const event = await disconnectedPromise;
      expect(event).toEqual({ clientId: 'client-1' });
    });
  });

  describe('destroy', () => {
    it('should emit closed and clean up', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const closedListener = vi.fn();
      host.on('closed', closedListener);

      host.destroy();

      expect(closedListener).toHaveBeenCalled();
      expect(host.peerId).toBeNull();
    });

    it('should clean up all client connections on destroy', async () => {
      host = new PeerHost({
        peerId: 'host-1',
        peerFactory: createMockPeerFactory(),
        heartbeatInterval: 0,
      });
      await host.start();

      const client = new MockPeer('client-1');
      await flushMicrotasks();
      const connP = waitForEvent(host, 'clientConnected');
      client.connect('host-1');
      await connP;

      host.destroy();
      expect(host.getClients()).toHaveLength(0);
    });
  });
});
