/**
 * Test-only fixtures exposed through the sandbox facade so consuming packages
 * do not depend on provider/conformance subpackages directly.
 */
export {
  createGeneratedPrivateGitFixture,
  type CreateGeneratedPrivateGitFixtureOptions,
  type GeneratedPrivateGitFixture,
} from '@cap/sandbox-conformance';
