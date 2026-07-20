import type {
  SandboxDetachedJobLaunchPlan,
  SandboxDetachedJobSettlement,
  SandboxDetachedJobTriage,
  SandboxWorkspaceProgressEvent,
  SandboxWorkspaceTransferProgressSnapshot,
} from '../src/index.js';

const workspaceJob: SandboxDetachedJobLaunchPlan = {
  jobId: 'task-1-clone',
  command: 'git clone --progress https://example.com/repo /staging/tree',
  publish: { stagingPath: '/staging/tree', finalPath: '/workspace/tree' },
};
void workspaceJob;

const exhaustiveTriage = (triage: SandboxDetachedJobTriage): string => {
  switch (triage.state) {
    case 'alive':
      return `alive:${triage.pid}`;
    case 'exited':
      return `exited:${triage.exitCode}`;
    case 'unknown':
      return 'unknown';
  }
};
void exhaustiveTriage;

const exhaustiveSettlement = (
  settlement: SandboxDetachedJobSettlement,
): boolean => {
  switch (settlement.kind) {
    case 'running':
      return false;
    case 'exited':
      return settlement.outcome === 'succeeded';
    case 'unprovable':
      return false;
  }
};
void exhaustiveSettlement;

// Unknown is modeled explicitly as null — never 0 (AIP-151).
const indeterminate: SandboxWorkspaceTransferProgressSnapshot = {
  percent: null,
  receivedObjects: null,
  totalObjects: null,
  receivedBytes: null,
  throughputBytesPerSecond: null,
};
void indeterminate;

const progressEvent: SandboxWorkspaceProgressEvent = {
  status: 'progress',
  stage: 'workspace_transfer',
  progress: indeterminate,
};
void progressEvent;

// @ts-expect-error the progress variant is transfer-stage only
const rejectedStage: SandboxWorkspaceProgressEvent = {
  status: 'progress',
  stage: 'checkout',
  progress: indeterminate,
};
void rejectedStage;

const rejectedNonNumeric: SandboxWorkspaceTransferProgressSnapshot = {
  // @ts-expect-error progress fields are numeric-only (or explicitly null)
  percent: '42',
  receivedObjects: null,
  totalObjects: null,
  receivedBytes: null,
  throughputBytesPerSecond: null,
};
void rejectedNonNumeric;
