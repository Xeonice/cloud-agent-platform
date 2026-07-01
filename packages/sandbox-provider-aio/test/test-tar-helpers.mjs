const BLOCK = 512;

function octal(value, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  return `${text}\0`;
}

function writeString(buffer, offset, length, value) {
  buffer.write(value.slice(0, length), offset, length, 'utf8');
}

function header(name, content, type = '0', prefix = '') {
  const block = Buffer.alloc(BLOCK);
  writeString(block, 0, 100, name);
  writeString(block, 100, 8, '0000644\0');
  writeString(block, 108, 8, '0000000\0');
  writeString(block, 116, 8, '0000000\0');
  writeString(block, 124, 12, octal(content.length, 12));
  writeString(block, 136, 12, '00000000000\0');
  block.fill(0x20, 148, 156);
  writeString(block, 156, 1, type);
  writeString(block, 257, 6, 'ustar\0');
  writeString(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, octal(sum, 8));
  return block;
}

function entry(name, content, type = '0', prefix = '') {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const pad = Buffer.alloc(Math.ceil(bytes.length / BLOCK) * BLOCK - bytes.length);
  return Buffer.concat([header(name, bytes, type, prefix), bytes, pad]);
}

export function tar(entries) {
  return Buffer.concat([
    ...entries.map((item) =>
      entry(item.name, item.content ?? '', item.type ?? '0', item.prefix ?? ''),
    ),
    Buffer.alloc(BLOCK * 2),
  ]);
}

export function longNameTar(longName, content) {
  return tar([
    { name: '././@LongLink', type: 'L', content: `${longName}\0` },
    { name: longName.slice(0, 100), content },
  ]);
}

export function base256SizeTar(name, content) {
  const bytes = Buffer.from(content);
  const block = header(name, bytes, '0');
  block.fill(0, 124, 136);
  block[124] = 0x80;
  block[135] = bytes.length;
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, octal(sum, 8));
  const pad = Buffer.alloc(Math.ceil(bytes.length / BLOCK) * BLOCK - bytes.length);
  return Buffer.concat([block, bytes, pad, Buffer.alloc(BLOCK * 2)]);
}
