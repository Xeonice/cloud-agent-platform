import type { TerminalHandle } from "@cap/ui";

export interface FixtureProgress {
  readonly fixtureDone: boolean;
  readonly liveAppendCount: number;
  readonly writeCount: number;
}

export type FixtureProgressListener = (progress: FixtureProgress) => void;

const encoder = new TextEncoder();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function writeTerminal(
  handle: TerminalHandle,
  data: string | Uint8Array,
): Promise<void> {
  return new Promise((resolve) => {
    handle.write(data, resolve);
  });
}

function line(text: string): string {
  return `${text}\r\n`;
}

async function writeSplitUtf8(handle: TerminalHandle): Promise<void> {
  const prefix = encoder.encode("UTF8_SPLIT: ");
  const firstChar = encoder.encode("汉");
  const suffix = encoder.encode("字边界\r\n");
  await writeTerminal(handle, prefix);
  await writeTerminal(handle, firstChar.slice(0, 1));
  await delay(15);
  await writeTerminal(handle, firstChar.slice(1));
  await writeTerminal(handle, suffix);
}

export async function runTerminalStoryFixture(
  handle: TerminalHandle,
  onProgress: FixtureProgressListener,
): Promise<void> {
  let writeCount = 0;
  let liveAppendCount = 0;
  const progress = (fixtureDone = false) =>
    onProgress({ fixtureDone, liveAppendCount, writeCount });
  const write = async (data: string | Uint8Array) => {
    await writeTerminal(handle, data);
    writeCount += 1;
    progress();
  };

  handle.clear();
  await write(line("CAP_TERMINAL_STORY_BEGIN"));
  await write(line("UTF8_DIRECT: 中文渲染正常 · emoji ✓"));
  await writeSplitUtf8(handle);
  writeCount += 4;
  progress();

  await write(line("REPLAY_BULK_BEGIN"));
  const replayLines: string[] = [];
  for (let i = 1; i <= 60; i += 1) {
    replayLines.push(line(`REPLAY_LINE_${String(i).padStart(3, "0")} reconnect bulk`));
  }
  await write(replayLines.join(""));
  await write(line("REPLAY_BULK_END"));

  for (let i = 1; i <= 180; i += 1) {
    await write(line(`HISTORY_LINE_${String(i).padStart(3, "0")} 中文 scrollback`));
    if (i % 30 === 0) {
      await delay(1);
    }
  }

  await write(line("CURSOR_REDRAW_BEGIN"));
  await write("\x1b[s");
  await write("\x1b[8;12HCURSOR_REDRAW_OK 中文");
  await write("\x1b[u");
  await write(line("CURSOR_REDRAW_END"));

  for (let i = 1; i <= 2; i += 1) {
    await delay(180);
    liveAppendCount = i;
    await write(line(`LIVE_APPEND_${String(i).padStart(3, "0")} still streaming`));
  }

  await write(line("CAP_TERMINAL_STORY_DONE"));
  progress(true);
}
