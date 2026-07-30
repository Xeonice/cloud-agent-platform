import assert from 'node:assert/strict';
import test from 'node:test';

import { CONSOLE_BUILD_ID_HEADER } from '@cap-console/contracts';

import {
  ConsoleBuildGuard,
  CONSOLE_BUILD_ENFORCED_ENV_VAR,
} from './console-build.guard';

/**
 * The console build guard.
 *
 * Two things carry the risk here and both are asserted rather than reasoned
 * about: WHO the guard applies to (only a browser session — an api key or MCP
 * token has no console build, and refusing it would break every programmatic
 * client), and that it enforces WITHOUT being armed (an escape hatch that has to
 * be reached for, rather than a gate that only works once somebody remembers to
 * switch it on).
 */

const API_VERSION = 'v0.47.0';

/** A request with a given principal kind and optional presented build. */
function request(options: {
  kind?: string | null;
  presented?: string | string[];
}): unknown {
  return {
    operatorPrincipal:
      options.kind === null || options.kind === undefined
        ? undefined
        : { kind: options.kind, user: { id: 'u' } },
    headers:
      options.presented === undefined
        ? {}
        : { [CONSOLE_BUILD_ID_HEADER]: options.presented },
  };
}

/** An ExecutionContext double carrying that request. */
function context(req: unknown, type = 'http'): never {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

/** Runs the guard with a scoped environment, always restoring it. */
function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Unset means ENFORCED. The escape hatch turns the refusal OFF, not on — so
// forgetting to configure anything leaves the invariant enforced, rather than
// leaving a gate that only works once somebody remembers to arm it.
const enforcing = {
  CAP_VERSION: API_VERSION,
  [CONSOLE_BUILD_ENFORCED_ENV_VAR]: undefined,
};
const observing = {
  CAP_VERSION: API_VERSION,
  [CONSOLE_BUILD_ENFORCED_ENV_VAR]: '0',
};

// ---- who it applies to -----------------------------------------------------

test('a machine credential is never refused, however it is built', () => {
  // The scope is by principal KIND, not by path: an api-key or MCP caller reaches
  // /v1 and the MCP surface, is not a console, and has no build to present.
  // Refusing it would break every programmatic client, and a path allowlist would
  // have to be kept in sync with the routes forever.
  const guard = new ConsoleBuildGuard();
  withEnv(enforcing, () => {
    for (const kind of ['api-key', 'mcp', 'legacy-token']) {
      assert.equal(
        guard.canActivate(context(request({ kind }))),
        true,
        `${kind} was refused`,
      );
    }
  });
});

test('an unauthenticated request is not this guard\'s business', () => {
  // The auth guard runs first and rejects it; this one must not throw a different
  // error on the way past and mask that.
  const guard = new ConsoleBuildGuard();
  withEnv(enforcing, () => {
    assert.equal(guard.canActivate(context(request({ kind: null }))), true);
  });
});

test('a non-http context is passed through', () => {
  // A WebSocket carries its identity on the handshake URL, not in a header — the
  // console never sends a connect frame — so that path handles it separately.
  const guard = new ConsoleBuildGuard();
  withEnv(enforcing, () => {
    assert.equal(guard.canActivate(context(request({ kind: 'session' }), 'ws')), true);
  });
});

// ---- when it refuses -------------------------------------------------------

test('a session on the same build is served', () => {
  const guard = new ConsoleBuildGuard();
  withEnv(enforcing, () => {
    assert.equal(
      guard.canActivate(context(request({ kind: 'session', presented: API_VERSION }))),
      true,
    );
  });
});

test('a session on a different build is refused, naming both versions', () => {
  const guard = new ConsoleBuildGuard();
  withEnv(enforcing, () => {
    try {
      guard.canActivate(context(request({ kind: 'session', presented: 'v0.46.1' })));
      assert.fail('a mismatched console was served');
    } catch (error) {
      const body = (error as { getResponse?: () => unknown }).getResponse?.() as
        | Record<string, unknown>
        | undefined;
      assert.equal(body?.error, 'console_build_mismatch');
      assert.equal(body?.apiVersion, API_VERSION);
      assert.equal(body?.consoleBuild, 'v0.46.1');
      // The first question anyone asks is which side is behind; an error that
      // does not answer it sends them to the logs of whichever they guessed.
      assert.match(String(body?.message), /v0\.46\.1/);
      assert.match(String(body?.message), /v0\.47\.0/);
    }
  });
});

test('a session presenting nothing is refused', () => {
  const guard = new ConsoleBuildGuard();
  withEnv(enforcing, () => {
    try {
      guard.canActivate(context(request({ kind: 'session' })));
      assert.fail('an unidentified console was served');
    } catch (error) {
      const body = (error as { getResponse?: () => unknown }).getResponse?.() as
        | Record<string, unknown>
        | undefined;
      assert.equal(body?.error, 'console_build_unidentified');
      assert.equal(body?.consoleBuild, null);
    }
  });
});

test('the escape hatch turns the refusal off for recovery', () => {
  // For a deployment that HAS diverged and needs its console back to fix that.
  // Recovery, not a supported steady state — which is why it is off-by-value.
  const guard = new ConsoleBuildGuard();
  withEnv(observing, () => {
    for (const presented of [undefined, 'v0.46.1', 'dev']) {
      assert.equal(
        guard.canActivate(context(request({ kind: 'session', presented }))),
        true,
        `refused while observing: ${String(presented)}`,
      );
    }
  });
});

test('an api that does not know its own version refuses nothing', () => {
  // A source build reports "unknown". Refusing every console against it would
  // break the ordinary dev loop to enforce an invariant that only means anything
  // between two DEPLOYED artifacts.
  const guard = new ConsoleBuildGuard();
  withEnv({ CAP_VERSION: undefined, [CONSOLE_BUILD_ENFORCED_ENV_VAR]: '1' }, () => {
    assert.equal(
      guard.canActivate(context(request({ kind: 'session', presented: 'v0.46.1' }))),
      true,
    );
  });
});

test('an unset escape hatch enforces, and so does a value that is not off', () => {
  // The failure mode being avoided: a typo in the env var silently disabling the
  // gate. Only an explicit off-value disables; anything else enforces.
  const guard = new ConsoleBuildGuard();
  for (const raw of [undefined, '', 'yes', '1', 'true', 'enabled', 'nope']) {
    withEnv({ CAP_VERSION: API_VERSION, [CONSOLE_BUILD_ENFORCED_ENV_VAR]: raw }, () => {
      assert.throws(
        () => guard.canActivate(context(request({ kind: 'session', presented: 'v0.1.0' }))),
        `served while ${CONSOLE_BUILD_ENFORCED_ENV_VAR}=${String(raw)}`,
      );
    });
  }
  for (const raw of ['0', 'false', 'FALSE', ' false ']) {
    withEnv({ CAP_VERSION: API_VERSION, [CONSOLE_BUILD_ENFORCED_ENV_VAR]: raw }, () => {
      assert.equal(
        guard.canActivate(context(request({ kind: 'session', presented: 'v0.1.0' }))),
        true,
        `refused while ${CONSOLE_BUILD_ENFORCED_ENV_VAR}=${raw}`,
      );
    });
  }
});

// ---- header handling -------------------------------------------------------

test('a duplicated header takes the first value rather than joining', () => {
  // A joined value can never equal a version, so joining would turn a duplicated
  // header into a "mismatch" — reporting a different fault than the one present.
  const guard = new ConsoleBuildGuard();
  withEnv(enforcing, () => {
    assert.equal(
      guard.canActivate(
        context(request({ kind: 'session', presented: [API_VERSION, 'v0.1.0'] })),
      ),
      true,
    );
  });
});
