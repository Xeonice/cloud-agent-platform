import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LOCAL_REPO_IMPORT_ROOT_ENV } from '@cap/contracts';
import type { LocalImportRejection } from './local-import';

/**
 * Stable, secret-free HTTP failures for the local-path import gate.
 *
 * Every message is actionable and NONE discloses anything about the filesystem
 * outside the allowlist root: an escaping path and a path that resolves to a
 * forbidden location produce the same `repo_local_import_path_outside_root`
 * answer, with no echo of what (if anything) lives at the escape target.
 */
export function throwLocalImportRejection(rejection: LocalImportRejection): never {
  switch (rejection) {
    case 'disabled':
      throw new ForbiddenException({
        error: 'repo_local_import_disabled',
        message:
          `Local path import is disabled. Set ${LOCAL_REPO_IMPORT_ROOT_ENV} on the ` +
          'api service to an absolute allowlist root (and mount that directory ' +
          'into the api container) to enable it.',
      });
    case 'root_unavailable':
      throw new ServiceUnavailableException({
        error: 'repo_local_import_disabled',
        message:
          `Local path import is configured but its ${LOCAL_REPO_IMPORT_ROOT_ENV} ` +
          'root is not accessible inside the api container. Mount the directory ' +
          'and restart the api service.',
      });
    case 'path_invalid':
      throw new BadRequestException({
        error: 'repo_local_import_path_invalid',
        message: 'The requested path is not a usable filesystem path.',
      });
    case 'outside_root':
      throw new ForbiddenException({
        error: 'repo_local_import_path_outside_root',
        message:
          'The requested path resolves outside the configured local import root. ' +
          'Choose a repository inside the allowlist root.',
      });
    case 'not_found':
      throw new NotFoundException({
        error: 'repo_local_import_path_not_found',
        message:
          'No such path inside the configured local import root.',
      });
    case 'not_a_git_repository':
      throw new UnprocessableEntityException({
        error: 'repo_local_import_not_a_git_repository',
        message:
          'The selected path is not a git repository. Local import requires a ' +
          'git working tree (containing `.git`) or a bare repository.',
      });
  }
}
