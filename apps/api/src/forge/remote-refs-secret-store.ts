import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

export interface RemoteRefsSecretLease {
  /** Safe to reference from argv; secret content never appears in this value. */
  readonly configPath: string;
  /** Resolves only after recursive removal is confirmed by the filesystem API. */
  cleanup(): Promise<void>;
}

export class RemoteRefsSecretStoreError extends Error {
  constructor(readonly reason: 'setup_failed' | 'cleanup_failed') {
    super(`remote refs secret ${reason}`);
    this.name = 'RemoteRefsSecretStoreError';
  }
}

/** Structured seam for a short-lived exact-host git credential file. */
export abstract class RemoteRefsSecretStore {
  abstract create(cleanUrl: string, authHeader: string): Promise<RemoteRefsSecretLease>;
}

/** Host filesystem implementation; no secret/path value is ever logged. */
@Injectable()
export class NodeRemoteRefsSecretStore extends RemoteRefsSecretStore {
  async create(cleanUrl: string, authHeader: string): Promise<RemoteRefsSecretLease> {
    let secretDirectory: string | null = null;
    try {
      secretDirectory = await mkdtemp(join(tmpdir(), 'cap-remote-refs-'));
      await chmod(secretDirectory, 0o700);
      const configPath = join(secretDirectory, 'gitconfig');
      await writeFile(configPath, this.exactHostConfig(cleanUrl, authHeader), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(configPath, 0o600);
      if (((await stat(configPath)).mode & 0o777) !== 0o600) {
        throw new RemoteRefsSecretStoreError('setup_failed');
      }

      const directory = secretDirectory;
      let cleaned = false;
      return {
        configPath,
        async cleanup(): Promise<void> {
          if (cleaned) return;
          try {
            await rm(directory, { recursive: true, force: true });
            cleaned = true;
          } catch {
            throw new RemoteRefsSecretStoreError('cleanup_failed');
          }
        },
      };
    } catch (error) {
      if (secretDirectory) {
        try {
          await rm(secretDirectory, { recursive: true, force: true });
        } catch {
          throw new RemoteRefsSecretStoreError('cleanup_failed');
        }
      }
      if (error instanceof RemoteRefsSecretStoreError) throw error;
      throw new RemoteRefsSecretStoreError('setup_failed');
    }
  }

  private exactHostConfig(cleanUrl: string, authHeader: string): string {
    const url = new URL(cleanUrl);
    const origin = `${url.protocol}//${url.host}/`;
    const quotedOrigin = origin.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return (
      `[credential]\n` +
      `\thelper =\n` +
      `\tinteractive = never\n` +
      `[http]\n` +
      `\tfollowRedirects = false\n` +
      `[http "${quotedOrigin}"]\n` +
      `\textraHeader = ${authHeader}\n`
    );
  }
}
