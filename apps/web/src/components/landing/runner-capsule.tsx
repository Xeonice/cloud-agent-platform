/**
 * `RunnerCapsule` — the landing hero's live run-pool demo
 * (console-design-pixel-merge Track 5, tasks 5.1/5.2).
 *
 * A NATIVE React port of the design revision's vanilla `runner-capsule.js`
 * Web Component (design-baseline/components/runner-capsule.js), replacing the
 * former static `HeroPreview`. It preserves the SAME ordered loop state
 * machine: idle (1300ms) → assigning (1800ms) → booting (1700ms) → running
 * (3200ms) → loop, each phase re-arming a timeout with that phase's duration
 * and advancing `(index + 1) % PHASES.length` — exactly the Web Component's
 * `queueNext()` loop.
 *
 * SSR-SAFE under the established mounted-flag pattern (task 5.2):
 *   - The server render AND the first client paint use the reduced-motion
 *     (static) branch — the final "running" phase frozen, `data-reduce-motion`
 *     set — with NO `window`/`matchMedia` access during render, so hydration
 *     matches byte-for-byte.
 *   - Only AFTER mount does an effect read
 *     `matchMedia('(prefers-reduced-motion: no-preference)')`; when it matches,
 *     the component upgrades to the animation loop from phase 0 (mirroring the
 *     Web Component's `renderState(0)` + `queueNext()` start).
 *   - A `prefers-reduced-motion: reduce` visitor keeps the static branch
 *     (mirroring the Web Component's `renderState(STATES.length - 1)` +
 *     `dataset.reduceMotion = "true"` branch).
 *
 * The original component rendered into a Shadow Root with scoped styles; the
 * React port reproduces the same DOM + the same stylesheet, scoped instead via
 * a `[data-slot="runner-capsule"]` prefix on every rule (the component is
 * rendered once per page). All copy is literal sample data from the design —
 * no live data, clock, or random.
 */
import * as React from "react";

/** One phase of the ordered demo loop (verbatim design `STATES` data). */
interface CapsulePhase {
  stage: "idle" | "assigning" | "booting" | "running";
  label: string;
  status: string;
  caption: string;
  runnerCopy: string;
  taskCopy: string;
  miniCopy: string;
  taskInside: boolean;
  step: number;
  duration: number;
}

/**
 * The final "running" phase — also the static reduced-motion frame (the design
 * Web Component's `renderState(STATES.length - 1)` branch) and the
 * `noUncheckedIndexedAccess` fallback for phase lookups.
 */
const RUNNING_PHASE: CapsulePhase = {
  stage: "running",
  label: "Running",
  status: "iad-02 · running",
  caption: "task_27c9 is live. Operator can take over.",
  runnerCopy: "running task_27c9",
  taskCopy: "running on iad-02",
  miniCopy: "running task_27c9",
  taskInside: true,
  step: 3,
  duration: 3200,
};

/** The design's loop state machine, in its exact order and timing. */
const PHASES: readonly CapsulePhase[] = [
  {
    stage: "idle",
    label: "Pool ready",
    status: "iad-02 · ready",
    caption: "task_27c9 is queued for scheduler assignment.",
    runnerCopy: "ready",
    taskCopy: "queued for assignment",
    miniCopy: "ready",
    taskInside: false,
    step: 0,
    duration: 1300,
  },
  {
    stage: "assigning",
    label: "Assigning",
    status: "iad-02 · leasing",
    caption: "Control plane assigns task_27c9 to iad-02.",
    runnerCopy: "leasing workspace",
    taskCopy: "assigned to iad-02",
    miniCopy: "leasing",
    taskInside: false,
    step: 1,
    duration: 1800,
  },
  {
    stage: "booting",
    label: "Booting runner",
    status: "iad-02 · booting",
    caption: "The runner binds identity, repo, and session boundary.",
    runnerCopy: "booting task_27c9",
    taskCopy: "claimed by iad-02",
    miniCopy: "booting",
    taskInside: true,
    step: 2,
    duration: 1700,
  },
  RUNNING_PHASE,
];

/** The 3 in-runner stage chips (design `.runner-steps`). */
const RUNNER_STEPS = ["Lease", "Boot", "Attach"] as const;

/** Design `[data-step]` walk: before current → done, current → active. */
function stepState(stepIndex: number, phaseStep: number): "done" | "active" | "idle" {
  if (stepIndex < phaseStep) return "done";
  if (stepIndex === phaseStep) return "active";
  return "idle";
}

/** The live runner-capsule hero demo. */
export function RunnerCapsule() {
  // Mounted-flag pattern: false on the server and the first client paint, so
  // both render the static reduced-motion branch with no `window` access.
  const [animate, setAnimate] = React.useState(false);
  // Static branch shows the final "running" phase (the design's reduce-motion
  // `renderState(STATES.length - 1)`).
  const [index, setIndex] = React.useState(PHASES.length - 1);

  // Upgrade to the animation loop only after mount, and only when the visitor
  // does NOT prefer reduced motion (a `reduce` visitor keeps the static branch).
  React.useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
      return;
    }
    setAnimate(true);
    setIndex(0);
  }, []);

  // The ordered loop: each phase holds for its own duration, then advances to
  // the next phase modulo the phase count (the Web Component's `queueNext`).
  React.useEffect(() => {
    if (!animate) return;
    const timer = window.setTimeout(
      () => {
        setIndex((current) => (current + 1) % PHASES.length);
      },
      (PHASES[index] ?? RUNNING_PHASE).duration,
    );
    return () => window.clearTimeout(timer);
  }, [animate, index]);

  const phase = PHASES[index] ?? RUNNING_PHASE;

  return (
    <div data-slot="runner-capsule">
      <style>{CAPSULE_CSS}</style>
      <div className="preview-shell">
        <div className="preview-chrome">
          <span className="window-dots" aria-hidden="true">
            <span className="dot danger" />
            <span className="dot warn" />
            <span className="dot green" />
          </span>
          <span>agent-control · run-pool</span>
        </div>
        <section
          className="capsule"
          data-stage={phase.stage}
          data-step={phase.step}
          data-task-inside={phase.taskInside ? "true" : "false"}
          data-reduce-motion={animate ? undefined : "true"}
          aria-label="远端 Agent 运行池动画"
        >
          <header className="capsule-head">
            <div>
              <div className="eyebrow">Agent Run Pool</div>
              <h2>将 task 分配给空闲 runner。</h2>
            </div>
            <div className="stage-pill">{phase.label}</div>
          </header>

          <div className="pool-scene">
            <div className="runner-strip" aria-label="远端 runner 池">
              <article className="runner-mini" data-tone="busy">
                <strong>iad-01</strong>
                <span>running task_81a3</span>
              </article>
              <article className="runner-mini" data-tone="target">
                <strong>iad-02</strong>
                <span>{phase.miniCopy}</span>
              </article>
              <article className="runner-mini">
                <strong>iad-03</strong>
                <span>ready</span>
              </article>
              <article className="runner-mini" data-tone="paused">
                <strong>iad-04</strong>
                <span>paused</span>
              </article>
            </div>

            <div className="stage-canvas">
              <article className="target-runner" aria-label="iad-02 runner">
                <div className="runner-status">{phase.status}</div>
                <strong className="target-name">iad-02</strong>
                <span className="target-copy">{phase.runnerCopy}</span>
                <div className="inside-task">
                  <b>task_27c9</b>
                  <small>cloud-agent-platform · main</small>
                </div>
                <button className="takeover" type="button">
                  Take over
                </button>
                <div className="runner-steps" aria-label="runner 内部阶段">
                  {RUNNER_STEPS.map((step, stepIndex) => (
                    <div
                      key={step}
                      className="step"
                      data-state={stepState(stepIndex, phase.step)}
                    >
                      {step}
                    </div>
                  ))}
                </div>
              </article>

              <article className="task-card" aria-label="待分配 task">
                <small>Task</small>
                <strong>task_27c9</strong>
                <span>{phase.taskCopy}</span>
              </article>
              <span className="assign-line" aria-hidden="true" />
              <div className="caption">{phase.caption}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The design Web Component's shadow stylesheet, ported verbatim with every
 * rule scoped under `[data-slot="runner-capsule"]` (replacing the Shadow Root
 * boundary) and the keyframes renamed `rc-assign-packet` (keyframe names are
 * global). Token fallbacks resolve against the app's `:root` custom properties.
 */
const CAPSULE_CSS = `
[data-slot="runner-capsule"] {
  display: block;
  color: var(--foreground, #171717);
  font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
}

[data-slot="runner-capsule"] * {
  box-sizing: border-box;
}

[data-slot="runner-capsule"] .preview-shell {
  width: 100%;
  max-width: 720px;
  margin-inline: auto;
  overflow: hidden;
  border-radius: 12px;
  background: #ffffff;
  box-shadow:
    0 0 0 1px rgba(0,0,0,0.08),
    0 28px 80px -48px rgba(0,0,0,0.18);
}

[data-slot="runner-capsule"] .preview-chrome {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  background: #fafafa;
  color: var(--muted-foreground, #666);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  box-shadow: var(--shadow-ring, rgb(235,235,235) 0 0 0 1px);
}

[data-slot="runner-capsule"] .window-dots {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

[data-slot="runner-capsule"] .dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #d8d8d8;
}

[data-slot="runner-capsule"] .danger { background: #ff5b4f; }
[data-slot="runner-capsule"] .warn { background: #f5a623; }
[data-slot="runner-capsule"] .green { background: #2da44e; }

[data-slot="runner-capsule"] .capsule {
  display: grid;
  gap: 14px;
  padding: 16px;
  background: #ffffff;
}

[data-slot="runner-capsule"] .capsule-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

[data-slot="runner-capsule"] .eyebrow {
  color: var(--muted-foreground, #666);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

[data-slot="runner-capsule"] h2 {
  max-width: 430px;
  margin: 5px 0 0;
  font-size: clamp(20px, 2.2vw, 26px);
  font-weight: 600;
  line-height: 1.08;
  letter-spacing: -0.8px;
  text-wrap: balance;
}

[data-slot="runner-capsule"] .stage-pill {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  border-radius: 999px;
  padding: 0 11px;
  background: #f5f9ff;
  color: var(--info, #0969da);
  box-shadow: inset 0 0 0 1px rgba(10,114,239,0.14);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

[data-slot="runner-capsule"] .pool-scene {
  position: relative;
  min-height: 320px;
  overflow: hidden;
  border-radius: 16px;
  padding: 16px;
  background:
    linear-gradient(rgba(0,0,0,0.026) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,0,0,0.026) 1px, transparent 1px),
    linear-gradient(180deg, #ffffff, #fafafa);
  background-size: 32px 32px, 32px 32px, auto;
  box-shadow:
    rgba(0,0,0,0.08) 0 0 0 1px,
    rgba(0,0,0,0.04) 0 2px 2px,
    #fafafa 0 0 0 1px inset;
}

[data-slot="runner-capsule"] .runner-strip {
  position: absolute;
  top: 16px;
  left: 16px;
  right: 16px;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

[data-slot="runner-capsule"] .runner-mini {
  min-width: 0;
  border-radius: 10px;
  padding: 8px 9px;
  background: rgba(255,255,255,0.86);
  color: var(--muted-foreground, #666);
  box-shadow: rgb(235,235,235) 0 0 0 1px;
}

[data-slot="runner-capsule"] .runner-mini strong,
[data-slot="runner-capsule"] .target-name {
  display: block;
  color: var(--foreground, #171717);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  font-weight: 600;
}

[data-slot="runner-capsule"] .runner-mini span {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-slot="runner-capsule"] .runner-mini::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 999px;
  background: #d4d4d4;
}

[data-slot="runner-capsule"] .runner-mini[data-tone="busy"]::before {
  background: var(--success, #1a7f37);
}

[data-slot="runner-capsule"] .runner-mini[data-tone="target"] {
  background: #f5f9ff;
  box-shadow: 0 0 0 1px rgba(10,114,239,0.16);
}

[data-slot="runner-capsule"] .runner-mini[data-tone="target"]::before {
  background: var(--info, #0969da);
}

[data-slot="runner-capsule"] .runner-mini[data-tone="paused"] {
  opacity: 0.58;
}

[data-slot="runner-capsule"] .stage-canvas {
  position: relative;
  min-height: 288px;
}

[data-slot="runner-capsule"] .target-runner {
  position: absolute;
  left: 68%;
  top: 76px;
  width: min(300px, calc(100% - 230px));
  min-width: 230px;
  min-height: 168px;
  border-radius: 14px;
  padding: 14px;
  background: rgba(255,255,255,0.96);
  transform: translateX(-50%);
  box-shadow:
    rgba(0,0,0,0.08) 0 0 0 1px,
    rgba(0,0,0,0.04) 0 2px 2px,
    #fafafa 0 0 0 1px inset;
  transition:
    box-shadow 260ms ease,
    transform 260ms ease,
    background 260ms ease;
}

[data-slot="runner-capsule"] .runner-status {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  border-radius: 999px;
  padding: 0 10px;
  background: #ffffff;
  color: var(--muted-foreground, #666);
  box-shadow:
    rgba(0,0,0,0.08) 0 0 0 1px,
    rgba(0,0,0,0.04) 0 2px 2px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

[data-slot="runner-capsule"] .target-copy {
  display: block;
  margin-top: 7px;
  color: var(--muted-foreground, #666);
  font-size: 12px;
}

[data-slot="runner-capsule"] .inside-task {
  position: absolute;
  left: 14px;
  right: 114px;
  top: 56px;
  min-height: 48px;
  border-radius: 10px;
  padding: 10px 11px;
  background: #f5f9ff;
  color: var(--info, #0969da);
  box-shadow: 0 0 0 1px rgba(10,114,239,0.16);
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 220ms ease, transform 260ms ease;
}

[data-slot="runner-capsule"] .inside-task b {
  display: block;
  overflow: hidden;
  color: var(--foreground, #171717);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-slot="runner-capsule"] .inside-task small {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: var(--muted-foreground, #666);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-slot="runner-capsule"] .runner-steps {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 12px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

[data-slot="runner-capsule"] .step {
  border-radius: 999px;
  padding: 6px 8px;
  background: #fafafa;
  color: var(--muted-foreground, #666);
  box-shadow: rgb(235,235,235) 0 0 0 1px;
  font-size: 10px;
  font-weight: 600;
  text-align: center;
  transition:
    background 220ms ease,
    color 220ms ease,
    box-shadow 220ms ease;
}

[data-slot="runner-capsule"] .step[data-state="active"] {
  background: #f5f9ff;
  color: var(--info, #0969da);
  box-shadow: 0 0 0 1px rgba(10,114,239,0.2);
}

[data-slot="runner-capsule"] .step[data-state="done"] {
  background: #f6fffa;
  color: var(--success, #1a7f37);
  box-shadow: 0 0 0 1px rgba(26,127,55,0.18);
}

[data-slot="runner-capsule"] .task-card {
  position: absolute;
  left: 18px;
  bottom: 46px;
  z-index: 6;
  width: 164px;
  border-radius: 12px;
  padding: 12px;
  background: rgba(255,255,255,0.98);
  box-shadow:
    rgba(0,0,0,0.08) 0 0 0 1px,
    0 18px 44px -30px rgba(0,0,0,0.55),
    #fafafa 0 0 0 1px inset;
  transition:
    transform 260ms ease,
    opacity 220ms ease,
    box-shadow 260ms ease;
}

[data-slot="runner-capsule"] .task-card small {
  display: block;
  color: var(--muted-foreground, #666);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

[data-slot="runner-capsule"] .task-card strong {
  display: block;
  margin-top: 6px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 14px;
  font-weight: 600;
}

[data-slot="runner-capsule"] .task-card span {
  display: block;
  margin-top: 7px;
  color: var(--muted-foreground, #666);
  font-size: 11px;
  line-height: 1.35;
}

[data-slot="runner-capsule"] .assign-line {
  position: absolute;
  left: 184px;
  right: 260px;
  bottom: 111px;
  z-index: 5;
  height: 1px;
  background: linear-gradient(90deg, rgba(10,114,239,0), rgba(10,114,239,0.58), rgba(10,114,239,0));
  opacity: 0;
  transform: scaleX(0.72);
  transform-origin: left center;
  transition: opacity 180ms ease, transform 320ms ease;
}

[data-slot="runner-capsule"] .assign-line::after {
  content: "";
  position: absolute;
  top: -4px;
  left: 0;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--info, #0969da);
  box-shadow: 0 0 0 4px rgba(10,114,239,0.12);
  opacity: 0;
}

[data-slot="runner-capsule"] .caption {
  display: none;
}

[data-slot="runner-capsule"] .takeover {
  position: absolute;
  right: 14px;
  top: 66px;
  min-height: 29px;
  border: 0;
  border-radius: 6px;
  padding: 0 10px;
  background: var(--foreground, #171717);
  color: #ffffff;
  box-shadow: 0 12px 26px -18px rgba(0,0,0,0.55);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 220ms ease, transform 220ms ease;
}

[data-slot="runner-capsule"] .capsule[data-stage="assigning"] .target-runner,
[data-slot="runner-capsule"] .capsule[data-stage="booting"] .target-runner,
[data-slot="runner-capsule"] .capsule[data-stage="running"] .target-runner {
  background: #ffffff;
  transform: translateX(-50%) translateY(-2px);
  box-shadow:
    0 0 0 1px rgba(10,114,239,0.24),
    0 22px 62px -40px rgba(10,114,239,0.72),
    #fafafa 0 0 0 1px inset;
}

[data-slot="runner-capsule"] .capsule[data-stage="assigning"] .runner-status,
[data-slot="runner-capsule"] .capsule[data-stage="booting"] .runner-status {
  color: var(--info, #0969da);
}

[data-slot="runner-capsule"] .capsule[data-stage="running"] .runner-status {
  color: var(--success, #1a7f37);
}

[data-slot="runner-capsule"] .capsule[data-stage="assigning"] .task-card {
  transform: translateY(-2px);
  box-shadow:
    0 0 0 1px rgba(10,114,239,0.22),
    0 18px 46px -30px rgba(10,114,239,0.58),
    #fafafa 0 0 0 1px inset;
}

[data-slot="runner-capsule"] .capsule[data-stage="assigning"] .assign-line {
  opacity: 1;
  transform: scaleX(1);
}

[data-slot="runner-capsule"] .capsule[data-stage="assigning"] .assign-line::after {
  animation: rc-assign-packet 900ms cubic-bezier(.2,.8,.2,1) infinite;
  opacity: 1;
}

[data-slot="runner-capsule"] .capsule[data-stage="booting"] .task-card,
[data-slot="runner-capsule"] .capsule[data-stage="running"] .task-card {
  opacity: 0;
  transform: translateY(0) scale(0.98);
}

[data-slot="runner-capsule"] .capsule[data-task-inside="true"] .inside-task {
  opacity: 1;
  transform: translateY(0);
}

[data-slot="runner-capsule"] .capsule[data-stage="running"] .takeover {
  opacity: 1;
  transform: translateY(0);
}

[data-slot="runner-capsule"] .capsule[data-reduce-motion="true"] .task-card,
[data-slot="runner-capsule"] .capsule[data-reduce-motion="true"] .assign-line::after {
  transition: none;
  animation: none;
}

@keyframes rc-assign-packet {
  0% {
    transform: translateX(0);
    opacity: 0;
  }
  18% {
    opacity: 1;
  }
  82% {
    opacity: 1;
  }
  100% {
    transform: translateX(calc(100% - 9px));
    opacity: 0;
  }
}

@media (max-width: 620px) {
  [data-slot="runner-capsule"] .capsule {
    padding: 14px;
  }

  [data-slot="runner-capsule"] .capsule-head {
    display: grid;
    gap: 10px;
  }

  [data-slot="runner-capsule"] .pool-scene {
    min-height: 370px;
    padding: 13px;
  }

  [data-slot="runner-capsule"] .runner-strip {
    position: static;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  [data-slot="runner-capsule"] .runner-mini:nth-child(4) {
    display: none;
  }

  [data-slot="runner-capsule"] .stage-canvas {
    margin-top: 10px;
    min-height: 264px;
  }

  [data-slot="runner-capsule"] .target-runner {
    left: 50%;
    top: 34px;
    width: min(100%, 320px);
    min-width: 0;
  }

  [data-slot="runner-capsule"] .inside-task {
    right: 104px;
  }

  [data-slot="runner-capsule"] .takeover {
    right: 12px;
    padding-inline: 9px;
  }

  [data-slot="runner-capsule"] .task-card {
    left: 12px;
    bottom: 26px;
    width: min(184px, calc(100% - 24px));
  }

  [data-slot="runner-capsule"] .assign-line {
    display: none;
  }

  [data-slot="runner-capsule"] .caption {
    left: 12px;
    right: 12px;
    bottom: 6px;
    max-width: none;
  }
}
`;
