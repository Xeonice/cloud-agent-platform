/**
 * The harness-maker seam (unlock-extension-axes, design D7).
 *
 * The conformance suite owns EVERY scenario assertion. A runtime participates by
 * supplying only a harness maker — runtime CONSTRUCTION plus ENVIRONMENT HOOKS
 * (fixture material, launch expectations, credential stubs) — and contributes no
 * scenario logic of its own. The seam is deliberately typed as construction +
 * hooks only: no member accepts or returns a test assertion, so a runtime
 * physically cannot fork scenario logic through it (go-cloud drivertest layout).
 *
 * Admitting a runtime to the suite = registering a harness maker in the
 * runtime-keyed ledger Record (`RUNTIME_CONFORMANCE_HARNESSES`) and, when the
 * runtime declares new execution modes, ledger data — never new assertions.
 */
import type { AgentRuntimeId, ExecutionMode } from '@cap-console/contracts';
import type {
  SandboxRuntimePrivateFile,
  TaskModelLaunchMaterial,
} from '@cap-console/sandbox';

// ---------------------------------------------------------------------------
// The runtime surface the scenario families exercise.
//
// This is the STRUCTURAL subset of the api's `AgentRuntime` port that the five
// families touch. It is declared here (not imported from `apps/api`) because the
// suite package must typecheck with no import resolving into `apps/api` — the
// api's runtime objects satisfy it structurally through the seed bridge. The
// vocabulary types it does share (runtime ids, execution modes, private files)
// come from their single declarations in `@cap-console/contracts` and
// `@cap-console/sandbox`.
// ---------------------------------------------------------------------------

/** Per-launch context, mirroring the api port's `LaunchContext` structurally. */
export interface ConformanceLaunchContext {
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly sessionId?: string;
  readonly model: TaskModelLaunchMaterial;
}

/** Declarative terminal-startup policy (DSR reply + prompt submit + quiesce). */
export interface ConformanceTerminalStartup {
  readonly replyToStartupDSR: boolean;
  readonly promptSubmit: 'none' | 'cr-on-quiesce';
  readonly quiesceMs?: number;
}

/** The narrow scripted-exec handle `detectExit` runs over. */
export interface ConformanceExec {
  exec(command: string): Promise<{ stdout: string; code: number | null }>;
}

export type ConformanceExitSignal = { readonly status: 'running' | 'done' };

/** One provision-time setup command + its fail-closed policy + private files. */
export interface ConformanceSetupCommand {
  readonly command: string;
  readonly tolerateUnresolvedExit: boolean;
  readonly privateFiles?: readonly SandboxRuntimePrivateFile[];
  readonly descriptor: { readonly commandKind: string; readonly ordinal: number };
}

export type ConformanceSetupPlan =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly commands: readonly ConformanceSetupCommand[] };

export interface ConformanceSetupContext {
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly prompt: string | null;
}

/** Credential material stub shape (thin optional-field union, as in the port). */
export interface ConformanceAuthMaterial {
  readonly authJson?: string;
  readonly oauthToken?: string;
  readonly codexCompatible?: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
  };
}

/** The runtime under conformance — construction output of the harness maker. */
export interface RuntimeUnderConformance {
  readonly id: AgentRuntimeId;
  readonly executionModes: ReadonlySet<ExecutionMode>;
  readonly terminalStartup: ConformanceTerminalStartup;
  readonly transcriptFormat: string;
  readonly readTranscriptSource: { readonly kind: string };
  buildLaunchLine(ctx: ConformanceLaunchContext): string;
  buildHeadlessLine?(ctx: ConformanceLaunchContext): string;
  buildResumeLine?(ctx: ConformanceLaunchContext, prevSessionId: string): string;
  transcriptArtifact(ctx: ConformanceLaunchContext): {
    readonly dir: string;
    readonly filenameGlob: RegExp;
  };
  detectExit(
    exec: ConformanceExec,
    ctx: ConformanceLaunchContext,
  ): Promise<ConformanceExitSignal>;
  sandboxSetupCommands(
    ctx: ConformanceSetupContext,
    material: ConformanceAuthMaterial | null,
  ): ConformanceSetupPlan;
  preStopTrimCommands(): readonly string[];
}

/** A parsed transcript, as the shared render-contract parsers produce it. */
export interface ConformanceParsedTranscript {
  readonly turns: readonly {
    readonly kind: string;
    readonly text?: string;
    readonly isFinalAnswer?: boolean;
  }[];
  readonly meta: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Environment hooks: fixture material + expectations as DATA. The assertions
// that consume them live exclusively in the suite-owned scenario modules.
// ---------------------------------------------------------------------------

export interface LaunchExpectations {
  readonly context: ConformanceLaunchContext;
  /**
   * Byte-exact golden fixture for the full detached launch line (codex). The
   * fixture is MOVED from the seed suite, never regenerated: the scenario
   * compares `buildLaunchLine` output to it byte-for-byte.
   */
  readonly goldenDetachedLine?: string;
  readonly mustInclude: readonly string[];
  readonly mustExclude: readonly string[];
  /** Whether `buildLaunchLine` must refuse a context without a sessionId. */
  readonly requiresSessionId: boolean;
}

export interface LifecycleExpectations {
  readonly context: ConformanceLaunchContext;
  readonly startup: {
    readonly replyToStartupDSR: boolean;
    readonly promptSubmit: 'none' | 'cr-on-quiesce';
  };
  /** Env-tunable quiesce window (codex): the var and its documented default. */
  readonly quiesceTunable?: {
    readonly envVar: string;
    readonly defaultMs: number;
  };
}

export interface TranscriptExpectations {
  readonly context: ConformanceLaunchContext;
  readonly format: string;
  readonly strategyKind: string;
  readonly artifactDir: string;
  /** A filename the declared glob must accept. */
  readonly matchingFilename: string;
  /** A filename the declared glob must reject. */
  readonly nonMatchingFilename: string;
  /** Parse handle from the seed bridge (environment hook, not an assertion). */
  readonly parse: (jsonl: string) => ConformanceParsedTranscript;
  /** Fixture JSONL moved from the runtime's seed parser test. */
  readonly fixtureJsonl: string;
  readonly expectedTurnKinds: readonly string[];
  readonly expectedFinalAnswerText: string;
  /** Optional malformed-line fixture: parsing must never abort. */
  readonly malformed?: {
    readonly jsonl: string;
    readonly expectedSurvivorTexts: readonly string[];
  };
}

export interface HeadlessExpectations {
  readonly context: ConformanceLaunchContext;
  readonly mustInclude: readonly string[];
  readonly mustExclude: readonly string[];
  /** The headless wrapper's exit-code sentinel path for this context. */
  readonly exitSentinelPath: string;
  readonly resume: {
    readonly previousSessionId: string;
    readonly mustInclude: readonly string[];
    readonly mustExclude: readonly string[];
  };
  /** A shell-active resume id `buildResumeLine` must refuse (with pattern). */
  readonly hostileResume?: {
    readonly sessionId: string;
    readonly rejectionPattern: string;
  };
  /** Flags that must appear EXACTLY once on every launch mode's line. */
  readonly exactlyOnceFlags?: readonly string[];
}

export interface SecretCanaryVariant {
  readonly label: string;
  /** Credential stub carrying the canary value. */
  readonly material: ConformanceAuthMaterial;
}

export interface SecretCanaryExpectations {
  readonly setupContext: ConformanceSetupContext;
  /** One unique value reused by every secret-leak assertion in the family. */
  readonly canary: string;
  /** Credential variants; each must inject the canary exactly once. */
  readonly variants: readonly SecretCanaryVariant[];
  /** What `sandboxSetupCommands(ctx, null)` must do without a credential. */
  readonly absentCredential: 'fail-closed' | 'degrades';
  /** A blank credential stub that must also fail closed (when applicable). */
  readonly blankMaterial?: ConformanceAuthMaterial;
  /** Paths the pre-stop trim must PROVE absent (`test ! -e <path>`). */
  readonly trimProvesAbsent: readonly string[];
}

export interface RuntimeEnvironmentHooks {
  readonly launch: LaunchExpectations;
  readonly lifecycle: LifecycleExpectations;
  readonly transcript: TranscriptExpectations;
  /** Present iff the runtime declares `headless-exec`. */
  readonly headless?: HeadlessExpectations;
  readonly secretCanary: SecretCanaryExpectations;
}

// ---------------------------------------------------------------------------
// The seam itself.
// ---------------------------------------------------------------------------

/**
 * The construction bridge a suite run supplies to every harness maker. The
 * runtime implementations live in `apps/api` today; the bridge constructs them
 * at TEST RUNTIME (the repo's compile-the-real-source harness convention), so
 * this package's compile graph carries no `apps/api` import.
 */
export interface RuntimeSeedBridge {
  constructRuntime(id: AgentRuntimeId): Promise<RuntimeUnderConformance>;
  parseTranscript(jsonl: string, format: string): ConformanceParsedTranscript;
}

/** Construction + hooks. Nothing else can cross the seam. */
export interface RuntimeHarness {
  readonly runtime: RuntimeUnderConformance;
  readonly hooks: RuntimeEnvironmentHooks;
}

export interface RuntimeHarnessMaker {
  readonly runtimeId: AgentRuntimeId;
  make(bridge: RuntimeSeedBridge): Promise<RuntimeHarness>;
}
