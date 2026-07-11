#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmod,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const REDACTED = '[REDACTED]';

const ZIP_SIGNATURE = {
  localFile: 0x04034b50,
  centralFile: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
};
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_UTF8_FLAG = 0x0800;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const CRC_TABLE = createCrcTable();

export default async function sanitizePlaywrightArtifacts() {
  const artifactRoot = process.env.E2E_ARTIFACT_DIR?.trim();
  if (!artifactRoot) {
    throw new Error('E2E_ARTIFACT_DIR is required to sanitize Playwright artifacts');
  }
  await sanitizeArtifacts(artifactRoot);
}

export async function sanitizeArtifacts(artifactRoot) {
  await walk(resolve(artifactRoot));
}

export function sanitizeStructured(value, context = {}) {
  if (typeof value === 'string') return sanitizePlainText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructured(item, context));
  }

  const source = value;
  const inputOperation = context.forceInput === true || isInputOperation(source);
  const passwordInput = normalizeKey(source.type) === 'password';
  const sensitiveHeaderEntry =
    typeof source.name === 'string' && isSensitiveHeaderName(source.name);
  const sanitized = {};

  for (const [key, child] of Object.entries(source)) {
    const normalized = normalizeKey(key);
    if (normalized === 'cookies') {
      sanitized[key] = sanitizeCookies(child);
    } else if (context.forceInput === true && isInputEvidenceKey(normalized)) {
      sanitized[key] = REDACTED;
    } else if (isSensitiveKey(normalized)) {
      sanitized[key] = REDACTED;
    } else if (sensitiveHeaderEntry && normalized === 'value') {
      sanitized[key] = REDACTED;
    } else if (
      passwordInput &&
      (normalized === 'value' || normalized === 'playwrightvalue')
    ) {
      sanitized[key] = REDACTED;
    } else if (inputOperation && normalized === 'params') {
      sanitized[key] = sanitizeInputParameters(child);
    } else if (inputOperation && isInputTextKey(normalized)) {
      sanitized[key] = REDACTED;
    } else {
      sanitized[key] = sanitizeStructured(child, context);
    }
  }

  return sanitized;
}

export function sanitizePlainText(text) {
  return text
    .replace(
      /^(\s*(?:Fill|Type)\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/i,
      (_match, prefix) => `${prefix}"${REDACTED}"`,
    )
    .replace(
      /\b(fill|type)\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/gi,
      (_match, operation) => `${operation}("${REDACTED}")`,
    )
    .replace(
      /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*).*$/gim,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:"|')?(?:currentPassword|newPassword|password|token|secret|credential|authorization|proxy-authorization|cookie|set-cookie|postData)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      (_match, prefix, quotedValue) =>
        `${prefix}${quotedValue[0]}${REDACTED}${quotedValue[0]}`,
    )
    .replace(
      /((?:currentPassword|newPassword|password|token|secret|credential|authorization|proxy-authorization|cookie|set-cookie|postData)\s*[:=]\s*)(?!\[REDACTED\])[^,\s}\]\r\n;]+/gi,
      `$1${REDACTED}`,
    );
}

export function sanitizeTraceZipBuffer(archive) {
  const entries = decodeZipArchive(archive).map((entry) => {
    if (!isUtf8Text(entry.data)) return entry;
    const source = entry.data.toString('utf8');
    const sanitized = sanitizeTextDocument(source);
    return sanitized === source
      ? entry
      : { ...entry, data: Buffer.from(sanitized, 'utf8') };
  });
  return encodeZipArchive(entries);
}

export function decodeZipArchive(archive) {
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('multi-disk ZIP archives are not supported');
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 trace archives are not supported');
  }
  assertRange(archive, centralOffset, centralSize, 'central directory');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(archive, cursor, 46, 'central directory entry');
    if (archive.readUInt32LE(cursor) !== ZIP_SIGNATURE.centralFile) {
      throw new Error(`invalid central directory signature at entry ${index}`);
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const modifiedTime = archive.readUInt16LE(cursor + 12);
    const modifiedDate = archive.readUInt16LE(cursor + 14);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const internalAttributes = archive.readUInt16LE(cursor + 36);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const centralEntrySize = 46 + nameLength + extraLength + commentLength;
    assertRange(archive, cursor, centralEntrySize, 'central directory entry payload');

    if ((flags & 0x0001) !== 0) throw new Error('encrypted ZIP entries are not supported');
    if (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE) {
      throw new Error(`unsupported ZIP compression method ${method}`);
    }

    const name = archive
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');
    if (!name || name.includes('\0')) throw new Error('invalid ZIP entry name');

    assertRange(archive, localOffset, 30, `local header for ${name}`);
    if (archive.readUInt32LE(localOffset) !== ZIP_SIGNATURE.localFile) {
      throw new Error(`invalid local header signature for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assertRange(archive, dataOffset, compressedSize, `compressed data for ${name}`);
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const data =
      method === ZIP_METHOD_STORE
        ? Buffer.from(compressed)
        : inflateRawSync(compressed);

    if (data.length !== uncompressedSize) {
      throw new Error(`uncompressed size mismatch for ${name}`);
    }
    if (crc32(data) !== expectedCrc) throw new Error(`CRC mismatch for ${name}`);

    entries.push({
      name,
      data,
      method,
      modifiedTime,
      modifiedDate,
      internalAttributes,
      externalAttributes,
    });
    cursor += centralEntrySize;
  }

  if (cursor !== centralOffset + centralSize) {
    throw new Error('central directory size does not match its entries');
  }
  return entries;
}

export function encodeZipArchive(entries) {
  if (entries.length > 0xffff) throw new Error('too many ZIP entries');

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const method =
      entry.method === ZIP_METHOD_STORE ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE;
    const compressed =
      method === ZIP_METHOD_STORE ? data : deflateRawSync(data);
    const checksum = crc32(data);
    const modifiedTime = entry.modifiedTime ?? dosTimestamp().time;
    const modifiedDate = entry.modifiedDate ?? dosTimestamp().date;
    const externalAttributes = entry.externalAttributes ?? 0;
    const internalAttributes = entry.internalAttributes ?? 0;

    assertClassicZipSize(name.length, 'ZIP entry name');
    assertClassicZipSize(data.length, `uncompressed data for ${entry.name}`);
    assertClassicZipSize(compressed.length, `compressed data for ${entry.name}`);
    assertClassicZipSize(localOffset, 'local ZIP offset');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_SIGNATURE.localFile, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(modifiedTime, 10);
    localHeader.writeUInt16LE(modifiedDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_SIGNATURE.centralFile, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(modifiedTime, 12);
    centralHeader.writeUInt16LE(modifiedDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(internalAttributes, 36);
    centralHeader.writeUInt32LE(externalAttributes >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  assertClassicZipSize(localOffset, 'central ZIP offset');
  assertClassicZipSize(centralDirectory.length, 'central ZIP directory');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_SIGNATURE.endOfCentralDirectory, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function walk(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(child);
    else if (entry.isFile()) await sanitizeFile(child);
  }
}

async function sanitizeFile(path) {
  const source = await readFile(path);
  if (basename(path).toLowerCase() === 'trace.zip') {
    try {
      await atomicWrite(path, sanitizeTraceZipBuffer(source));
    } catch (error) {
      // Fail closed: a trace that could not be parsed must not be uploaded with
      // live cookies or typed credentials still inside it.
      await rm(path, { force: true });
      throw error;
    }
    return;
  }
  if (!isUtf8Text(source)) return;

  const text = source.toString('utf8');
  const sanitized = sanitizeTextDocument(text);
  if (sanitized !== text) await atomicWrite(path, Buffer.from(sanitized, 'utf8'));
}

function sanitizeTextDocument(text) {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      return JSON.stringify(sanitizeStructured(JSON.parse(trimmed)), null, 2) +
        (text.endsWith('\n') ? '\n' : '');
    } catch {
      // Playwright trace and network files are JSONL, not one JSON document.
    }
  }

  const lines = text.split(/\r?\n/);
  const parsedLines = lines.map((line) => {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });
  const sensitiveCallIds = new Set(
    parsedLines.flatMap((line) => {
      if (
        line &&
        typeof line === 'object' &&
        typeof line.callId === 'string' &&
        isInputOperation(line)
      ) {
        return [line.callId];
      }
      return [];
    }),
  );

  return lines
    .map((line, index) => {
      const parsed = parsedLines[index];
      if (parsed === null) return sanitizePlainText(line);
      const forceInput =
        typeof parsed === 'object' &&
        typeof parsed.callId === 'string' &&
        sensitiveCallIds.has(parsed.callId);
      return JSON.stringify(sanitizeStructured(parsed, { forceInput }));
    })
    .join('\n');
}

function sanitizeInputParameters(value) {
  return sanitizeStructured(value, { forceInput: true });
}

function sanitizeCookies(value) {
  if (!Array.isArray(value)) return REDACTED;
  return value.map((cookie) => {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
      return REDACTED;
    }
    return Object.fromEntries(
      Object.entries(cookie).map(([key, child]) => [
        key,
        normalizeKey(key) === 'value' ? REDACTED : sanitizeStructured(child),
      ]),
    );
  });
}

function isInputOperation(value) {
  const methodIdentifiesInput = ['method', 'action', 'apiName'].some((key) => {
    const candidate = value[key];
    return (
      typeof candidate === 'string' &&
      /(?:^|[.:])(?:fill|type)$/i.test(candidate.trim())
    );
  });
  const titleIdentifiesInput =
    typeof value.title === 'string' &&
    (/^\s*(?:Fill|Type)\s+(?:"|')/i.test(value.title) ||
      /^\s*Expect\s+"toHaveValue"/i.test(value.title));
  return methodIdentifiesInput || titleIdentifiesInput;
}

function isInputTextKey(key) {
  return key === 'value' || key === 'text' || key === 'characters';
}

function isInputEvidenceKey(key) {
  return (
    isInputTextKey(key) ||
    key === 'expected' ||
    key === 'expectedtext' ||
    key === 'expectedvalue' ||
    key === 'received' ||
    key === 'ariasnapshot'
  );
}

function isSensitiveKey(key) {
  return (
    key.includes('password') ||
    key.includes('token') ||
    key.includes('secret') ||
    key.includes('credential') ||
    key === 'authorization' ||
    key === 'proxyauthorization' ||
    key === 'cookie' ||
    key === 'setcookie' ||
    key.startsWith('postdata') ||
    key === 'playwrightvalue'
  );
}

function isSensitiveHeaderName(name) {
  const normalized = normalizeKey(name);
  return (
    normalized === 'authorization' ||
    normalized === 'proxyauthorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie'
  );
}

function normalizeKey(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';
}

function isUtf8Text(data) {
  if (data.length === 0) return true;
  const text = data.toString('utf8');
  if (text.includes('\ufffd') || text.includes('\0')) return false;
  if (!Buffer.from(text, 'utf8').equals(data)) return false;

  const sample = text.slice(0, 8_192);
  let controls = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code < 32 && character !== '\n' && character !== '\r' && character !== '\t') {
      controls += 1;
    }
  }
  return controls / Math.max(sample.length, 1) < 0.02;
}

async function atomicWrite(path, data) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.sanitize-${process.pid}-${randomUUID()}`,
  );
  const mode = (await stat(path)).mode;
  try {
    await writeFile(temporary, data);
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function findEndOfCentralDirectory(archive) {
  const firstCandidate = archive.length - 22;
  const earliest = Math.max(0, firstCandidate - MAX_ZIP_COMMENT_BYTES);
  for (let offset = firstCandidate; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_SIGNATURE.endOfCentralDirectory) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error('ZIP end-of-central-directory record was not found');
}

function assertRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`${label} is outside the ZIP archive`);
  }
}

function assertClassicZipSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} requires ZIP64`);
  }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function dosTimestamp(now = new Date()) {
  const year = Math.max(1980, now.getFullYear());
  return {
    time:
      (now.getHours() << 11) |
      (now.getMinutes() << 5) |
      Math.floor(now.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const artifactRoot = process.argv[2] ?? process.env.E2E_ARTIFACT_DIR;
  if (!artifactRoot?.trim()) {
    process.stderr.write(
      'usage: node scripts/sanitize-scheduled-tasks-e2e-artifacts.mjs <artifact-dir>\n',
    );
    process.exitCode = 2;
  } else {
    sanitizeArtifacts(artifactRoot).catch((error) => {
      process.stderr.write(
        `scheduled-task artifact sanitization failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    });
  }
}
