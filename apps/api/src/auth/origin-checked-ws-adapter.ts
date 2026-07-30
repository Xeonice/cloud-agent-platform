import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';

import { isTrustedRequestOrigin } from './request-origin';

/**
 * A `WsAdapter` that refuses a cross-origin handshake.
 *
 * Browsers do NOT apply the same-origin policy to WebSocket connections, and the
 * HTTP CORS allow-list does not cover them. The terminal gateway authenticates
 * from the handshake cookie, and in the cross-origin deployment shape that
 * cookie is `SameSite=None` — so without this check any page could open a socket
 * to the gateway with the operator's cookie attached and drive a PTY.
 *
 * The check runs at the UPGRADE, before a connection exists: nothing is created,
 * no gateway state is touched, and the gateway's own authentication never sees
 * the request.
 *
 * Why wrap `handleUpgrade` rather than pass `verifyClient`: the base adapter
 * creates its `ws` server with `noServer: true` and drives upgrades from its own
 * listener on the HTTP server, and `ws` only consults `verifyClient` when it owns
 * the upgrade itself. Wrapping the handshake entry point is therefore the one
 * place that cannot be bypassed by how the adapter routes upgrades.
 *
 * A refusal is invisible to the browser beyond a generic connection failure, so
 * the refused origin is logged — otherwise a misconfigured `WEB_ORIGIN` is
 * undiagnosable from the client side.
 */

type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  callback: (...args: unknown[]) => void,
) => void;

export interface UpgradableServer {
  handleUpgrade: UpgradeHandler;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Wrap a ws server's handshake entry point so an untrusted origin is refused.
 *
 * Exported separately from the adapter so the decision is unit-testable without
 * a booted Nest application: the adapter is the wiring, this is the behaviour.
 */
export function guardHandshakeOrigin(
  server: UpgradableServer,
  onRefused: (origin: string) => void,
): void {
  const passThrough = server.handleUpgrade.bind(server) as UpgradeHandler;

  server.handleUpgrade = (request, socket, head, callback) => {
    const origin = headerValue(request.headers.origin);
    // An absent Origin is allowed here, unlike on HTTP: a non-browser client
    // (the CLI, a test harness) legitimately omits it, and such a client is not
    // the threat this guards — a page cannot suppress the header a browser
    // attaches to every WebSocket handshake it opens.
    if (
      origin !== undefined &&
      !isTrustedRequestOrigin(origin, headerValue(request.headers.host))
    ) {
      onRefused(origin);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    passThrough(request, socket, head, callback);
  };
}

export class OriginCheckedWsAdapter extends WsAdapter {
  private readonly originLogger = new Logger(OriginCheckedWsAdapter.name);

  override create(port: number, options?: Record<string, unknown>): unknown {
    const server = super.create(port, options) as UpgradableServer;
    guardHandshakeOrigin(server, (origin) => {
      this.originLogger.warn(
        `refused a WebSocket handshake from untrusted origin ${origin}`,
      );
    });
    return server;
  }
}
