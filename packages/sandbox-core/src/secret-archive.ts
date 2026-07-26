import { SandboxProviderConfigurationError } from './errors.js';

const TAR_BLOCK_SIZE = 512;
const TAR_UID_GID_MAX = 0o7777777;

/**
 * Build the provider-neutral private-file transport envelope used by sandbox
 * adapters. The archive contains exactly one regular file and fixes its mode
 * to 0600; callers cannot smuggle provider-specific metadata into the header.
 */
export function createSandboxMode0600FileArchive(
  name: string,
  content: Uint8Array,
  ownership: { readonly uid: number; readonly gid: number } = {
    uid: 0,
    gid: 0,
  },
): Uint8Array {
  // Hidden runtime files such as Claude's `.claude.json` are valid leaf names.
  // Keep the tar entry flat and ASCII-only, while rejecting the two path
  // navigation components themselves and every slash/backslash form.
  if (
    !/^[A-Za-z0-9._-]{1,100}$/u.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox secret archive file name is invalid',
    );
  }
  if (
    !Number.isSafeInteger(ownership.uid) ||
    ownership.uid < 0 ||
    ownership.uid > TAR_UID_GID_MAX ||
    !Number.isSafeInteger(ownership.gid) ||
    ownership.gid < 0 ||
    ownership.gid > TAR_UID_GID_MAX
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox secret archive ownership is invalid',
    );
  }

  const bodyBlocks = Math.ceil(content.byteLength / TAR_BLOCK_SIZE);
  const archive = Buffer.alloc(
    TAR_BLOCK_SIZE * (1 + bodyBlocks + 2),
    0,
  );
  const header = archive.subarray(0, TAR_BLOCK_SIZE);
  writeTarText(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o600);
  writeTarOctal(header, 108, 8, ownership.uid);
  writeTarOctal(header, 116, 8, ownership.gid);
  writeTarOctal(header, 124, 12, content.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarText(header, 257, 6, 'ustar');
  writeTarText(header, 263, 2, '00');
  writeTarText(header, 265, 32, 'cap');
  writeTarText(header, 297, 32, 'cap');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  archive.set(content, TAR_BLOCK_SIZE);
  return archive;
}

function writeTarText(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  header.write(
    value.toString(8).padStart(length - 1, '0'),
    offset,
    length - 1,
    'ascii',
  );
  header[offset + length - 1] = 0;
}
