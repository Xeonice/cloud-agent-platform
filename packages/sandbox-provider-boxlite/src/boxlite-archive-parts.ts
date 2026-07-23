import { createHash } from 'node:crypto';
import { createSandboxMode0600FileArchive } from '@cap/sandbox-core';

/**
 * Body-limit-safe archive delivery (chunk-archive-injection-with-progress D1).
 *
 * BoxLite serve buffers each file upload wholesale and rejects request bodies
 * above ~2MB (413 `length limit exceeded`, observed on 0.9.5), so one streamed
 * PUT of a repo mirror dies on any real repository. The tar stream is instead
 * re-chunked into fixed-size parts, each delivered as its OWN single-entry tar
 * (the daemon's `/files` endpoint EXTRACTS the uploaded body at `path` —
 * proven live: a raw byte body is rejected with `failed to extract tar`, a
 * single-entry tar lands as a file and missing parent directories are
 * created). The extracted parts under `<dir>/.parts/` are reassembled INSIDE
 * the box with `cat` and verified (byte count + SHA-256, both accumulated
 * while streaming on the api side) before the mirror tar itself is extracted
 * by an explicit in-box `tar -xf`.
 *
 * Each per-part envelope is a `Uint8Array` on purpose: every PUT carries a
 * Content-Length and stays on the transport path the daemon demonstrably
 * accepts, avoiding chunked-transfer edge cases entirely. The ~2KB tar
 * envelope overhead keeps a 1.5MB part safely under the 2MB body limit.
 */

export interface BoxLiteArchivePartUploadClient {
  uploadArchive(request: {
    readonly sandboxId: string;
    readonly path: string;
    readonly archive: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  exec(request: {
    readonly sandboxId: string;
    readonly command: string;
    readonly timeoutMs?: number;
    readonly cancellationSignal?: AbortSignal;
  }): Promise<{ readonly exitCode: number; readonly output: string }>;
}

export interface BoxLiteArchivePartsUploadArgs {
  readonly client: BoxLiteArchivePartUploadClient;
  readonly sandboxId: string;
  /** Absolute box directory the extracted archive must end up in. */
  readonly path: string;
  readonly archive: AsyncIterable<Uint8Array>;
  readonly partBytes: number;
  readonly signal?: AbortSignal;
  readonly execTimeoutMs?: number;
  readonly onBytesUploaded?: (uploadedBytes: number) => void;
}

export class BoxLiteArchivePartsError extends Error {
  constructor(
    readonly reason:
      | 'part_upload_failed'
      | 'reassembly_failed'
      | 'integrity_mismatch'
      | 'extract_failed',
    detail: string,
  ) {
    super(`BoxLite archive parts transfer ${reason}: ${detail}`);
    this.name = 'BoxLiteArchivePartsError';
  }
}

const PART_NAME_WIDTH = 6;
const PARTS_DIRNAME = '.parts';
const ASSEMBLED_NAME = '.cap-archive.tar';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function partName(index: number): string {
  const name = String(index).padStart(PART_NAME_WIDTH, '0');
  if (name.length > PART_NAME_WIDTH) {
    // 10^6 parts at the minimum part size is far beyond any plausible mirror;
    // fail closed rather than break `cat`'s lexicographic reassembly order.
    throw new BoxLiteArchivePartsError(
      'part_upload_failed',
      `part index ${index} exceeds the ordered naming width`,
    );
  }
  return name;
}

/** Re-chunk an arbitrary byte stream into parts of exactly `partBytes` (last part smaller). */
export async function* splitIntoParts(
  source: AsyncIterable<Uint8Array>,
  partBytes: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) {
    throw new BoxLiteArchivePartsError(
      'part_upload_failed',
      `partBytes must be a positive integer, received ${partBytes}`,
    );
  }
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(partBytes - pendingBytes, chunk.length - offset);
      pending.push(chunk.subarray(offset, offset + take));
      pendingBytes += take;
      offset += take;
      if (pendingBytes === partBytes) {
        yield concatParts(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
      }
    }
  }
  if (pendingBytes > 0) yield concatParts(pending, pendingBytes);
}

function concatParts(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * Upload the archive as ordered parts, reassemble in-box, verify byte count +
 * SHA-256, extract, and clean up. Throws a typed {@link BoxLiteArchivePartsError};
 * on any failure the target directory is wiped so no partially assembled
 * archive or workspace source survives.
 */
export async function uploadBoxLiteArchiveInParts(
  args: BoxLiteArchivePartsUploadArgs,
): Promise<void> {
  const partsDir = `${args.path}/${PARTS_DIRNAME}`;
  const assembled = `${args.path}/${ASSEMBLED_NAME}`;
  const hash = createHash('sha256');
  let uploadedBytes = 0;
  let partIndex = 0;

  const exec = async (command: string) =>
    args.client.exec({
      sandboxId: args.sandboxId,
      command,
      ...(args.execTimeoutMs === undefined
        ? {}
        : { timeoutMs: args.execTimeoutMs }),
      ...(args.signal === undefined ? {} : { cancellationSignal: args.signal }),
    });

  const wipeTarget = async () => {
    try {
      await exec(
        `rm -rf -- ${shellQuote(partsDir)} ${shellQuote(assembled)}`,
      );
    } catch {
      // Best-effort cleanup; sandbox teardown removes the box wholesale.
    }
  };

  try {
    for await (const part of splitIntoParts(args.archive, args.partBytes)) {
      hash.update(part);
      const name = partName(partIndex);
      partIndex += 1;
      // The daemon extracts the body at `path`, so the raw part bytes travel
      // inside a single-entry tar envelope that materializes `<partsDir>/<name>`.
      const envelope = createSandboxMode0600FileArchive(name, part);
      try {
        await args.client.uploadArchive({
          sandboxId: args.sandboxId,
          path: partsDir,
          archive: envelope,
          ...(args.signal === undefined ? {} : { signal: args.signal }),
        });
      } catch (error) {
        throw new BoxLiteArchivePartsError(
          'part_upload_failed',
          `part ${name} (${part.length} bytes): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      uploadedBytes += part.length;
      try {
        args.onBytesUploaded?.(uploadedBytes);
      } catch {
        // Progress is best-effort and never load-bearing.
      }
    }

    const sha256Hex = hash.digest('hex');
    // Reassemble, drop the parts before extracting to halve peak disk usage,
    // verify byte count + checksum, then extract at the target directory.
    // Some daemon builds extract uploads into an `extracted/` subdirectory of
    // `path` (proven live on 0.9.5) while others land entries directly, so the
    // actual parts directory is resolved in-box first. The glob remains
    // lexicographic either way, matching the zero-padded upload order.
    const reassemble = await exec(
      [
        `parts_src=${shellQuote(partsDir)}`,
        `if test -d ${shellQuote(`${partsDir}/extracted`)}; then parts_src=${shellQuote(`${partsDir}/extracted`)}; fi`,
        `cat "$parts_src"/* > ${shellQuote(assembled)}`,
        `rm -rf -- ${shellQuote(partsDir)}`,
      ].join(' && '),
    );
    if (reassemble.exitCode !== 0) {
      throw new BoxLiteArchivePartsError(
        'reassembly_failed',
        `exit_code ${reassemble.exitCode}${
          reassemble.output.trim() ? ` - ${reassemble.output.trim()}` : ''
        }`,
      );
    }

    const verify = await exec(
      [
        `actual_bytes=$(wc -c < ${shellQuote(assembled)})`,
        `actual_sha=$(sha256sum ${shellQuote(assembled)} | cut -d' ' -f1)`,
        `test "$actual_bytes" -eq ${uploadedBytes}`,
        `test "$actual_sha" = ${shellQuote(sha256Hex)}`,
      ].join(' && '),
    );
    if (verify.exitCode !== 0) {
      throw new BoxLiteArchivePartsError(
        'integrity_mismatch',
        `expected ${uploadedBytes} bytes sha256 ${sha256Hex}${
          verify.output.trim() ? ` - ${verify.output.trim()}` : ''
        }`,
      );
    }

    const extract = await exec(
      [
        `tar -xf ${shellQuote(assembled)} -C ${shellQuote(args.path)}`,
        `rm -f -- ${shellQuote(assembled)}`,
      ].join(' && '),
    );
    if (extract.exitCode !== 0) {
      throw new BoxLiteArchivePartsError(
        'extract_failed',
        `exit_code ${extract.exitCode}${
          extract.output.trim() ? ` - ${extract.output.trim()}` : ''
        }`,
      );
    }
  } catch (error) {
    await wipeTarget();
    throw error;
  }
}
