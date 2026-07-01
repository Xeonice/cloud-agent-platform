type ProviderFixtureKind = "aio" | "boxlite";

export interface ProviderSelectedRunFixture {
  readonly taskId: string;
  readonly providerId: string;
  readonly providerSandboxId: string;
  readonly connection: {
    readonly baseUrl: string;
    readonly wsUrl: string;
  };
  readonly terminal: {
    readonly protocol: string;
    readonly wsUrl: string;
  };
  readonly command: {
    readonly protocol: string;
    readonly baseUrl: string;
    readonly workingDirectory: string;
  };
  readonly workspace: {
    readonly mode: string;
    readonly path: string;
  };
  readonly retention: {
    readonly mode: string;
  };
}

export interface ProviderTerminalFrameFixture {
  readonly snapshot: string;
  readonly tail: string;
  readonly live: readonly string[];
}

export interface ProviderTerminalFixture {
  readonly kind: ProviderFixtureKind;
  readonly providerId: string;
  readonly sessionId: string;
  readonly selectedRun: ProviderSelectedRunFixture;
  readonly frames: ProviderTerminalFrameFixture;
  readonly privateLeakSentinels: readonly string[];
}

const AIO_PRIVATE_BASE = "http://cap-aio-private-fixture:8080";
const BOXLITE_PRIVATE_BASE = "https://boxlite-private.fixture.invalid/v1/boxes/private";

export const providerTerminalFixtures: Record<
  ProviderFixtureKind,
  ProviderTerminalFixture
> = {
  aio: {
    kind: "aio",
    providerId: "aio-local",
    sessionId: "provider-fixture-aio-session",
    selectedRun: {
      taskId: "provider-fixture-aio-session",
      providerId: "aio-local",
      providerSandboxId: "aio-private-sandbox-id",
      connection: {
        baseUrl: AIO_PRIVATE_BASE,
        wsUrl: `${AIO_PRIVATE_BASE.replace(/^http/, "ws")}/v1/shell/ws`,
      },
      terminal: {
        protocol: "aio-json-v1",
        wsUrl: `${AIO_PRIVATE_BASE.replace(/^http/, "ws")}/v1/shell/ws`,
      },
      command: {
        protocol: "aio-http-exec-v1",
        baseUrl: AIO_PRIVATE_BASE,
        workingDirectory: "/home/gem/workspace",
      },
      workspace: {
        mode: "git",
        path: "/home/gem/workspace",
      },
      retention: {
        mode: "stop-retain",
      },
    },
    frames: {
      snapshot:
        "PROVIDER_FIXTURE_AIO_SNAPSHOT_BEGIN\r\n" +
        "AIO descriptor: aio-json-v1 / aio-http-exec-v1\r\n" +
        "PROVIDER_FIXTURE_SNAPSHOT_READY\r\n",
      tail:
        "PROVIDER_FIXTURE_AIO_TAIL_REPLAY_BEGIN\r\n" +
        Array.from({ length: 36 }, (_, index) =>
          `PROVIDER_FIXTURE_AIO_REPLAY_${String(index + 1).padStart(3, "0")} scrollback`,
        ).join("\r\n") +
        "\r\nPROVIDER_FIXTURE_TAIL_FINAL\r\n",
      live: [
        "PROVIDER_FIXTURE_AIO_LIVE_001\r\n",
        "PROVIDER_FIXTURE_AIO_LIVE_002\r\n",
      ],
    },
    privateLeakSentinels: [
      "aio-private-sandbox-id",
      "cap-aio-private-fixture",
      AIO_PRIVATE_BASE,
      "AIO_SANDBOX_IMAGE",
    ],
  },
  boxlite: {
    kind: "boxlite",
    providerId: "boxlite",
    sessionId: "provider-fixture-boxlite-session",
    selectedRun: {
      taskId: "provider-fixture-boxlite-session",
      providerId: "boxlite",
      providerSandboxId: "boxlite-private-sandbox-id",
      connection: {
        baseUrl: BOXLITE_PRIVATE_BASE,
        wsUrl: "wss://boxlite-private.fixture.invalid/terminal/private",
      },
      terminal: {
        protocol: "boxlite-v1",
        wsUrl: "wss://boxlite-private.fixture.invalid/terminal/private",
      },
      command: {
        protocol: "boxlite-exec-v1",
        baseUrl: "https://boxlite-private.fixture.invalid",
        workingDirectory: "/home/gem/workspace",
      },
      workspace: {
        mode: "archive",
        path: "/home/gem/workspace",
      },
      retention: {
        mode: "provider-native",
      },
    },
    frames: {
      snapshot:
        "PROVIDER_FIXTURE_BOXLITE_SNAPSHOT_BEGIN\r\n" +
        "BoxLite descriptor: boxlite-v1 / boxlite-exec-v1\r\n" +
        "PROVIDER_FIXTURE_SNAPSHOT_READY\r\n",
      tail:
        "PROVIDER_FIXTURE_BOXLITE_TAIL_REPLAY_BEGIN\r\n" +
        Array.from({ length: 36 }, (_, index) =>
          `PROVIDER_FIXTURE_BOXLITE_REPLAY_${String(index + 1).padStart(3, "0")} scrollback`,
        ).join("\r\n") +
        "\r\nPROVIDER_FIXTURE_TAIL_FINAL\r\n",
      live: [
        "PROVIDER_FIXTURE_BOXLITE_LIVE_001\r\n",
        "PROVIDER_FIXTURE_BOXLITE_LIVE_002\r\n",
      ],
    },
    privateLeakSentinels: [
      "boxlite-private-sandbox-id",
      "boxlite-private.fixture.invalid",
      BOXLITE_PRIVATE_BASE,
      "BOXLITE_API_TOKEN",
    ],
  },
};

export function providerFixtureFromQuery(): ProviderTerminalFixture | null {
  const raw = new URLSearchParams(window.location.search).get("fixture");
  return raw === "aio" || raw === "boxlite"
    ? providerTerminalFixtures[raw]
    : null;
}
