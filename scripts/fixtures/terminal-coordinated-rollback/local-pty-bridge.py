#!/usr/bin/env python3
"""Pipe-to-PTY relay owned only by the local rollback fixture.

Unlike BSD `script`, this helper does not require its own stdin to be a TTY.
It creates a real child PTY with forkpty, relays opaque bytes between Node pipes
and that PTY, and fences cleanup to the child it created.
"""

from __future__ import annotations

import errno
import fcntl
import os
import select
import signal
import struct
import sys
import termios
import time
import tty


def set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        try:
            offset += os.write(fd, data[offset:])
        except InterruptedError:
            continue


def wait_child(pid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            waited, _status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if waited == pid:
            return True
        time.sleep(0.02)
    return False


def cleanup_child(pid: int) -> None:
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return
        if wait_child(pid, 0.35):
            return


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: local-pty-bridge.py <shell> <cols> <rows>", file=sys.stderr)
        return 64
    shell = sys.argv[1]
    cols = int(sys.argv[2])
    rows = int(sys.argv[3])
    if not os.path.isabs(shell) or not (1 <= cols <= 1_000 and 1 <= rows <= 1_000):
        print("invalid local PTY bridge arguments", file=sys.stderr)
        return 64

    child_pid, master_fd = os.forkpty()
    if child_pid == 0:
        try:
            tty.setraw(0, termios.TCSANOW)
            set_winsize(0, cols, rows)
            os.environ["TERM"] = "xterm-256color"
            os.execv(shell, [shell])
        except BaseException:
            os._exit(127)

    set_winsize(master_fd, cols, rows)
    stopped = False

    def request_stop(_signum, _frame) -> None:
        nonlocal stopped
        stopped = True

    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, request_stop)

    try:
        while not stopped:
            readable, _, _ = select.select([sys.stdin.fileno(), master_fd], [], [], 0.1)
            if sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 16_384)
                if not data:
                    break
                write_all(master_fd, data)
            if master_fd in readable:
                try:
                    data = os.read(master_fd, 16_384)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    break
                write_all(sys.stdout.fileno(), data)
            try:
                waited, _status = os.waitpid(child_pid, os.WNOHANG)
            except ChildProcessError:
                waited = child_pid
            if waited == child_pid:
                child_pid = -1
                break
    finally:
        if child_pid > 0:
            cleanup_child(child_pid)
        try:
            os.close(master_fd)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
