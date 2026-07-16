import {
  AUDIT_KIND_DESCRIPTORS,
  assertResultCodeLevelConsistent,
} from './audit-mapping';

/** Stable identity shared by transactional acceptance and legacy audit upsert. */
export function taskCreatedAuditDedupeKey(taskId: string): string {
  return `task.created:${taskId}`;
}

/** Secret-free immutable create payload for the acceptance transaction. */
export function taskCreatedAuditData(taskId: string, userId: string | null) {
  const descriptor = AUDIT_KIND_DESCRIPTORS['task.created'];
  const validated = assertResultCodeLevelConsistent(
    descriptor.level,
    descriptor.resultCode,
  );
  return {
    taskId,
    userId,
    type: 'task.created',
    level: validated.level,
    resultCode: validated.resultCode ?? null,
    title: descriptor.title,
    description: descriptor.title,
    dedupeKey: taskCreatedAuditDedupeKey(taskId),
  } as const;
}
