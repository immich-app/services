import type { PeerJSOption } from 'peerjs';

/**
 * Internal message types used for heartbeat protocol.
 * These are transparent to consumers - they never see heartbeat messages.
 */
export type InternalMessage =
  | { __type: '__heartbeat__'; timestamp: number }
  | { __type: '__heartbeat_ack__'; timestamp: number }
  | { __type: '__reconnect__'; previousId: string };

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface PeerHostOptions {
  /** Custom peer ID for the host. If not provided, PeerJS will auto-generate one. */
  peerId?: string;
  /** Options passed directly to the PeerJS Peer constructor. */
  peerOptions?: PeerJSOption;
  /** Interval in ms between heartbeat pings. Set to 0 to disable. Default: 5000 */
  heartbeatInterval?: number;
  /** Time in ms to wait for a heartbeat ack before considering a client dead. Default: 10000 */
  heartbeatTimeout?: number;
  /** Time in ms to allow a disconnected client to reconnect before removing them. Default: 30000 */
  reconnectWindow?: number;
  /** Factory function to create a Peer instance. Useful for testing with mocks. */

  peerFactory?: (id: string | undefined, options?: PeerJSOption) => any;
}

export interface PeerClientOptions {
  /** The peer ID of the host to connect to. */
  hostId: string;
  /** Options passed directly to the PeerJS Peer constructor. */
  peerOptions?: PeerJSOption;
  /** Maximum number of reconnection attempts. Default: 10 */
  maxReconnectAttempts?: number;
  /** Initial delay in ms before first reconnect attempt. Default: 1000 */
  reconnectDelay?: number;
  /** Multiplier for exponential backoff. Default: 1.5 */
  reconnectBackoffMultiplier?: number;
  /** Maximum delay in ms between reconnect attempts. Default: 30000 */
  maxReconnectDelay?: number;
  /** Interval in ms between heartbeat pings. Set to 0 to disable. Default: 5000 */
  heartbeatInterval?: number;
  /** Time in ms to wait for a heartbeat ack before considering connection dead. Default: 10000 */
  heartbeatTimeout?: number;
  /** Factory function to create a Peer instance. Useful for testing with mocks. */

  peerFactory?: (id: string | undefined, options?: PeerJSOption) => any;
}

export interface ClientInfo {
  id: string;

  connection: any;
  connected: boolean;
  lastHeartbeat: number;
  disconnectedAt?: number;
}

export interface HostEvents {
  clientConnected: { clientId: string };
  clientDisconnected: { clientId: string };
  clientReconnected: { clientId: string };
  clientRemoved: { clientId: string };
  data: { clientId: string; data: unknown };
  error: { error: Error; clientId?: string };
  started: { peerId: string };
  closed: undefined;
}

export interface ClientEvents {
  connected: undefined;
  disconnected: undefined;
  reconnecting: { attempt: number; maxAttempts: number };
  reconnected: undefined;
  closed: { reason: string };
  data: { data: unknown };
  error: { error: Error };
  stateChanged: { from: ConnectionState; to: ConnectionState };
}
