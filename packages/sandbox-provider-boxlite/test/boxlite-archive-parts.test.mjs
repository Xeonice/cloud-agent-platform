// chunk-archive-injection-with-progress task 1.3: the part splitter and the
// parts-upload transfer against the modeled 2MB daemon body limit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let assertions = 0;
function check(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

async function* streamOf(...chunks) {
  for (const chunk of chunks) yield chunk;
}

function bytes(length, fill) {
  return new Uint8Array(length).fill(fill);
}

async function collect(iterable) {
  const out = [];
  for (const item of iterable) out.push(item);
  return out;
}

// ------------------------------------------------------------ splitIntoParts
{
  const parts = [];
  for await (const part of mod.splitIntoParts(
    streamOf(bytes(5, 1), bytes(7, 2), bytes(2, 3)),
    4,
  )) {
    parts.push(Buffer.from(part));
  }
  check(
    parts.map((part) => part.length).join(',') === '4,4,4,2',
    'parts are exactly partBytes with a smaller final remainder',
  );
  const joined = Buffer.concat(parts);
  const source = Buffer.concat([bytes(5, 1), bytes(7, 2), bytes(2, 3)]);
  check(joined.equals(source), 'reassembled parts are byte-identical to the source');
}
{
  let failed = null;
  try {
    for await (const part of mod.splitIntoParts(streamOf(bytes(1, 1)), 0)) {
      void part;
    }
  } catch (error) {
    failed = error;
  }
  check(
    failed?.name === 'BoxLiteArchivePartsError',
    'a non-positive part size fails closed',
  );
}

// -------------------------------------------- parts upload against the limit
// The daemon EXTRACTS each uploaded body at `path`, so every part arrives as a
// single-entry tar envelope. Unwrap it the same way the daemon would.
function unwrapEnvelope(envelope) {
  const header = envelope.subarray(0, 512);
  const magic = header.subarray(257, 262).toString('utf8');
  assert.equal(magic, 'ustar', 'each part travels as a ustar envelope');
  const name = header.subarray(0, 100).toString('utf8').replace(/\0+$/u, '');
  const size = parseInt(
    header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim(),
    8,
  );
  return { name, content: envelope.subarray(512, 512 + size) };
}

function fakePartsClient({ execHandler } = {}) {
  const uploads = [];
  const execs = [];
  return {
    uploads,
    execs,
    client: {
      async uploadArchive(request) {
        if (request.archive.byteLength > mod.FAKE_BOXLITE_UPLOAD_BODY_LIMIT_BYTES) {
          throw new Error(
            'HTTP 413 Failed to buffer the request body: length limit exceeded',
          );
        }
        const entry = unwrapEnvelope(Buffer.from(request.archive));
        uploads.push({
          path: request.path,
          envelopeBytes: request.archive.byteLength,
          name: entry.name,
          bytes: Buffer.from(entry.content),
        });
      },
      async exec(request) {
        execs.push(request.command);
        if (execHandler) return execHandler(request);
        return { exitCode: 0, output: '' };
      },
    },
  };
}

{
  // A payload far above the daemon limit transfers as ordered safe parts.
  const payload = bytes(5 * 1024 * 1024, 7);
  const { uploads, execs, client } = fakePartsClient();
  const reported = [];
  await mod.uploadBoxLiteArchiveInParts({
    client,
    sandboxId: 'box-1',
    path: '/home/gem/.cap-repo-source',
    archive: streamOf(payload),
    partBytes: 1_572_864,
    onBytesUploaded: (uploaded) => reported.push(uploaded),
  });
  check(uploads.length === 4, 'a 5MB payload splits into four ordered parts');
  check(
    uploads.every(
      (upload) => upload.envelopeBytes <= mod.FAKE_BOXLITE_UPLOAD_BODY_LIMIT_BYTES,
    ),
    'every uploaded envelope stays under the modeled daemon body limit',
  );
  check(
    uploads.every((upload) => upload.path === '/home/gem/.cap-repo-source/.parts'),
    'every envelope extracts at the parts directory',
  );
  check(
    uploads
      .map((upload) => upload.name)
      .every((name, index) => name === String(index).padStart(6, '0')),
    'extracted parts carry zero-padded lexicographic names',
  );
  check(
    Buffer.concat(uploads.map((upload) => upload.bytes)).equals(
      Buffer.from(payload),
    ),
    'concatenated parts reproduce the archive byte stream',
  );
  check(
    reported.length === uploads.length &&
      reported[reported.length - 1] === payload.length &&
      reported.every((value, index) => index === 0 || value > reported[index - 1]),
    'per-part progress reports monotonically increasing uploaded bytes',
  );

  const expectedSha = createHash('sha256').update(payload).digest('hex');
  const joined = execs.join('\n');
  check(
    joined.includes(
      `if test -d '/home/gem/.cap-repo-source/.parts/extracted'; then parts_src='/home/gem/.cap-repo-source/.parts/extracted'; fi`,
    ) &&
      joined.includes(
        `cat "$parts_src"/* > '/home/gem/.cap-repo-source/.cap-archive.tar'`,
      ) &&
      joined.includes(`rm -rf -- '/home/gem/.cap-repo-source/.parts'`),
    'the box resolves the daemon extraction layout, cats lexicographically, and drops the parts first',
  );
  check(
    joined.includes(`test "$actual_bytes" -eq ${payload.length}`) &&
      joined.includes(`test "$actual_sha" = '${expectedSha}'`) &&
      joined.includes('sha256sum'),
    'byte count and SHA-256 are verified in-box before extraction',
  );
  const verifyIndex = execs.findIndex((command) => command.includes('sha256sum'));
  const extractIndex = execs.findIndex((command) => command.includes('tar -xf'));
  check(
    verifyIndex !== -1 && extractIndex !== -1 && verifyIndex < extractIndex,
    'extraction only happens after the integrity verification',
  );
}

{
  // Guarded regression: a part size above the daemon limit must fail the
  // upload (the old single streamed PUT was exactly this failure).
  const { client } = fakePartsClient();
  let failed = null;
  try {
    await mod.uploadBoxLiteArchiveInParts({
      client,
      sandboxId: 'box-2',
      path: '/home/gem/.cap-repo-source',
      archive: streamOf(bytes(3 * 1024 * 1024, 1)),
      partBytes: 3 * 1024 * 1024,
    });
  } catch (error) {
    failed = error;
  }
  check(
    failed?.name === 'BoxLiteArchivePartsError' &&
      failed.reason === 'part_upload_failed' &&
      /length limit exceeded/u.test(failed.message),
    'oversized single uploads fail typed against the modeled daemon limit',
  );
}

{
  // Integrity mismatch: the box-side verification fails -> typed error + wipe.
  const { execs, client } = fakePartsClient({
    execHandler: (request) =>
      request.command.includes('sha256sum')
        ? { exitCode: 1, output: 'sha mismatch' }
        : { exitCode: 0, output: '' },
  });
  let failed = null;
  try {
    await mod.uploadBoxLiteArchiveInParts({
      client,
      sandboxId: 'box-3',
      path: '/home/gem/.cap-repo-source',
      archive: streamOf(bytes(64, 9)),
      partBytes: 32,
    });
  } catch (error) {
    failed = error;
  }
  check(
    failed?.name === 'BoxLiteArchivePartsError' &&
      failed.reason === 'integrity_mismatch',
    'a failed in-box verification settles as an integrity mismatch',
  );
  check(
    execs
      .slice(execs.findIndex((command) => command.includes('sha256sum')) + 1)
      .some(
        (command) =>
          command.includes(`rm -rf -- '/home/gem/.cap-repo-source/.parts'`) &&
          command.includes(`'/home/gem/.cap-repo-source/.cap-archive.tar'`),
      ),
    'the target is wiped after a failed verification (no half-assembled archive)',
  );
  const extractRan = execs.some(
    (command) => command.includes('tar -xf') && !command.includes('rm -rf'),
  );
  check(!extractRan, 'no extraction runs after a failed verification');
}

console.log(`boxlite-archive-parts: ${assertions} assertions passed`);
