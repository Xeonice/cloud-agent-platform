/**
 * Minimal in-memory tar reader for dockerode `getArchive` output.
 *
 * `Container.getArchive({ path })` always returns a (uncompressed) tar stream —
 * even for a single file the Docker daemon wraps it in tar. We only ever need to
 * pull regular files (the codex `rollout-*.jsonl`) out of a STOPPED container's
 * frozen layer, so this implements just the USTAR read subset rather than taking
 * a `tar-stream` dependency (which is unresolvable from `@cap/api` under pnpm's
 * strict hoisting, and whose `@types` are not in the offline store).
 *
 * Supported: POSIX/USTAR + GNU regular-file entries (typeflag `0`/`\0`), the
 * `prefix` field for long paths, and GNU `././@LongLink` (`L`) long-name
 * extensions. NOT supported (irrelevant here): sparse files, pax extended
 * headers, hardlinks. Unknown entry types are skipped by their declared size,
 * so an unexpected entry never derails the walk.
 */

/** One extracted regular-file entry. */
export interface TarEntry {
  /** Full path as stored in the archive (e.g. `home/gem/.codex/sessions/...`). */
  name: string;
  /** The file's raw bytes. */
  content: Buffer;
}

const BLOCK = 512;

/** Read a NUL-terminated ASCII field out of a header block. */
function readString(block: Buffer, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end += 1;
  return block.toString('utf8', offset, end);
}

/**
 * Parse a tar `size` field. Normally octal ASCII; GNU also emits a base-256
 * big-endian encoding flagged by the high bit of the first byte (for sizes that
 * do not fit the 11-octal-digit field). We handle both so large rollout files
 * never mis-size.
 */
function readSize(block: Buffer, offset: number, length: number): number {
  const first = block[offset];
  if (first & 0x80) {
    // base-256: high bit set, remaining bytes big-endian magnitude.
    let value = first & 0x7f;
    for (let i = offset + 1; i < offset + length; i += 1) {
      value = value * 256 + block[i];
    }
    return value;
  }
  const octal = readString(block, offset, length).trim();
  if (octal === '') return 0;
  const parsed = parseInt(octal, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Round a byte count up to the next 512-byte tar block boundary. */
function padToBlock(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/**
 * Walk a tar buffer and return every regular-file entry whose full path matches
 * `predicate`. Pure + synchronous: the caller collects the dockerode stream to a
 * Buffer first. Malformed tails (a truncated final block) terminate the walk
 * rather than throwing — a best-effort read of a frozen layer should degrade to
 * "what was readable", never crash the history endpoint.
 */
export function extractFilesFromTar(
  buffer: Buffer,
  predicate: (name: string) => boolean,
): TarEntry[] {
  const out: TarEntry[] = [];
  let offset = 0;
  // A pending GNU long name (from a `././@LongLink`/`L` entry) overrides the
  // next entry's truncated 100-byte name field.
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);

    // Two consecutive all-zero blocks mark the archive end; one is enough to
    // stop us safely.
    if (header.every((b) => b === 0)) break;

    const rawName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readSize(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);

    offset += BLOCK;
    const dataStart = offset;
    offset += padToBlock(size);
    if (dataStart + size > buffer.length) break; // truncated — stop cleanly.

    if (typeflag === 'L') {
      // GNU long-name extension: the data IS the next entry's name.
      pendingLongName = buffer
        .toString('utf8', dataStart, dataStart + size)
        .replace(/\0+$/, '');
      continue;
    }

    const name =
      pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    // Regular file: typeflag '0' (POSIX) or '\0' (legacy). Skip everything else
    // (dirs `5`, links, pax `x`/`g`, etc.) — we only read file bytes.
    const isRegular = typeflag === '0' || typeflag === '\0' || header[156] === 0;
    if (isRegular && predicate(name)) {
      out.push({ name, content: buffer.subarray(dataStart, dataStart + size) });
    }
  }

  return out;
}
