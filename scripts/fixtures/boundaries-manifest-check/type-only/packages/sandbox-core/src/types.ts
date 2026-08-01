import type { TaskStatus } from "@cap-console/contracts";
import { type SandboxId, isSandboxId } from "./ids";

export type RunState = { status: TaskStatus; id: SandboxId };

export const guard = isSandboxId;
