/**
 * Ephemeral session-scoped credentials module (session-scoped credentials track,
 * task 8.4).
 *
 * Public surface for the per-session credential provider that is the primary
 * safety boundary for a task. Credentials are minted in memory, scoped to one
 * session, and destroyed at session end (completion / failure / teardown).
 */
export { CredsModule } from './creds.module';
export { SessionCredentialsService } from './session-credentials.service';
export {
  SessionCredential,
  type SessionCredentialSnapshot,
  type SessionEndReason,
} from './session-credential';
