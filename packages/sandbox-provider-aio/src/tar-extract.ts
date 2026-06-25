export interface TarEntry {
  readonly name: string;
  readonly content: Buffer;
}

const BLOCK = 512;

function readString(block: Buffer, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end += 1;
  return block.toString('utf8', offset, end);
}

function readSize(block: Buffer, offset: number, length: number): number {
  const first = block[offset]!;
  if (first & 0x80) {
    let value = first & 0x7f;
    for (let i = offset + 1; i < offset + length; i += 1) {
      value = value * 256 + block[i]!;
    }
    return value;
  }
  const octal = readString(block, offset, length).trim();
  if (octal === '') return 0;
  const parsed = parseInt(octal, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function padToBlock(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

export function extractFilesFromTar(
  buffer: Buffer,
  predicate: (name: string) => boolean,
): TarEntry[] {
  const out: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;

    const rawName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readSize(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);

    offset += BLOCK;
    const dataStart = offset;
    offset += padToBlock(size);
    if (dataStart + size > buffer.length) break;

    if (typeflag === 'L') {
      pendingLongName = buffer
        .toString('utf8', dataStart, dataStart + size)
        .replace(/\0+$/, '');
      continue;
    }

    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    const isRegular = typeflag === '0' || typeflag === '\0' || header[156] === 0;
    if (isRegular && predicate(name)) {
      out.push({ name, content: buffer.subarray(dataStart, dataStart + size) });
    }
  }

  return out;
}
