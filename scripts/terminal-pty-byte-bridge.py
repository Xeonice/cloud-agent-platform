#!/usr/bin/env python3
"""ASCII-framed byte bridge for one provider outer terminal.

Some provider terminal APIs decode each outer PTY chunk as UTF-8 before CAP can
read it.  That destroys a multibyte code point when the provider happens to
split the code point between chunks.  This bridge keeps the outer PTY strictly
ASCII and base64-encodes the bytes from a child PTY, so provider chunking can no
longer change the child byte stream.

The bridge can run a login shell for a direct provider execution, or attach a
fresh child PTY to one exact tmux session.  It owns only that child process; tmux
mode never launches, kills, or otherwise owns the target session.

Protocol (one ASCII line per frame):

    R <generation> <protocol-version> <child-pid> <mode> <cols> <rows>
    O <generation> <sequence> <base64-child-output>
    E <generation> <reason>
    X <generation> <reason> <exit-code>

    I <generation> <base64-child-input>
    S <generation> <cols> <rows>
    C <generation>

Any malformed, oversized, or stale-generation input fails closed and tears
down only this bridge child.  In tmux mode the exact target session remains
detached.  Tmux may still interpret input bytes before they reach a target pane;
shell mode writes them directly to the login-shell PTY.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import errno
import fcntl
import os
import re
import select
import signal
import struct
import sys
import termios
import time
import tty
from dataclasses import dataclass
from typing import NoReturn


PROTOCOL_VERSION = 1
OUTPUT_CHUNK_BYTES = 3_072
MAX_INPUT_BYTES = 16_384
MAX_FRAME_BYTES = 24_000
MAX_GEOMETRY = 1_000
MAX_CELLS = 1_000_000
WRITE_TIMEOUT_SECONDS = 5.0
CHILD_HUP_SECONDS = 0.75
CHILD_TERM_SECONDS = 0.75

GENERATION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
TARGET_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
DECIMAL_PATTERN = re.compile(r"^[1-9][0-9]{0,3}$")


class ProtocolError(Exception):
    """A fail-closed client protocol violation with a safe public reason."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Options:
    mode: str
    target: str | None
    generation: str
    cols: int
    rows: int
    term: str


def _parse_args() -> Options:
    parser = argparse.ArgumentParser(
        description="Bridge one ASCII provider terminal to one byte-faithful child PTY."
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--shell",
        action="store_true",
        help="run bash -l in a fresh child PTY and inherit the current directory",
    )
    mode.add_argument("--target", help="attach one exact tmux session name without '='")
    parser.add_argument("--generation", required=True)
    parser.add_argument("--cols", required=True, type=int)
    parser.add_argument("--rows", required=True, type=int)
    parser.add_argument("--term", default="xterm-256color")
    values = parser.parse_args()

    if values.target is not None and (
        not TARGET_PATTERN.fullmatch(values.target) or values.target.startswith("=")
    ):
        parser.error("target must be a safe tmux session name without '='")
    if not GENERATION_PATTERN.fullmatch(values.generation):
        parser.error("generation must be a safe non-empty identifier")
    _validate_geometry(values.cols, values.rows, parser.error)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9+_.-]{0,63}", values.term):
        parser.error("term must be a safe terminal name")
    return Options(
        mode="shell" if values.shell else "tmux",
        target=values.target,
        generation=values.generation,
        cols=values.cols,
        rows=values.rows,
        term=values.term,
    )


def _validate_geometry(cols: int, rows: int, fail) -> None:
    if not (1 <= cols <= MAX_GEOMETRY and 1 <= rows <= MAX_GEOMETRY):
        fail("geometry_out_of_range")
    if cols * rows > MAX_CELLS:
        fail("geometry_too_large")


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    _validate_geometry(cols, rows, lambda reason: (_raise_protocol(reason)))
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def _raise_protocol(reason: str) -> NoReturn:
    raise ProtocolError(reason)


def _write_all(fd: int, payload: bytes, timeout: float = WRITE_TIMEOUT_SECONDS) -> None:
    deadline = time.monotonic() + timeout
    offset = 0
    while offset < len(payload):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("pty_write_timeout")
        _, writable, _ = select.select([], [fd], [], min(remaining, 0.25))
        if not writable:
            continue
        try:
            written = os.write(fd, payload[offset:])
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError(errno.EIO, "zero-length PTY write")
        offset += written


def _emit(fd: int, *fields: object) -> None:
    line = " ".join(str(field) for field in fields).encode("ascii") + b"\n"
    if len(line) > MAX_FRAME_BYTES:
        raise RuntimeError("internal_frame_too_large")
    _write_all(fd, line)


def _decode_payload(token: str) -> bytes:
    if not token or len(token) > ((MAX_INPUT_BYTES + 2) // 3) * 4:
        raise ProtocolError("input_size_invalid")
    try:
        encoded = token.encode("ascii")
    except UnicodeEncodeError as error:
        raise ProtocolError("input_not_ascii") from error
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ProtocolError("input_base64_invalid") from error
    if not payload or len(payload) > MAX_INPUT_BYTES:
        raise ProtocolError("input_size_invalid")
    if base64.b64encode(payload) != encoded:
        raise ProtocolError("input_base64_noncanonical")
    return payload


def _parse_decimal(token: str) -> int:
    if not DECIMAL_PATTERN.fullmatch(token):
        raise ProtocolError("geometry_invalid")
    return int(token, 10)


def _handle_frame(line: bytes, options: Options, master_fd: int) -> str | None:
    if not line:
        raise ProtocolError("empty_frame")
    try:
        text = line.decode("ascii")
    except UnicodeDecodeError as error:
        raise ProtocolError("frame_not_ascii") from error
    fields = text.split(" ")
    frame_type = fields[0]

    if frame_type == "I" and len(fields) == 3:
        if fields[1] != options.generation:
            raise ProtocolError("stale_generation")
        _write_all(master_fd, _decode_payload(fields[2]))
        return None

    if frame_type == "S" and len(fields) == 4:
        if fields[1] != options.generation:
            raise ProtocolError("stale_generation")
        cols = _parse_decimal(fields[2])
        rows = _parse_decimal(fields[3])
        _validate_geometry(cols, rows, _raise_protocol)
        _set_winsize(master_fd, cols, rows)
        return None

    if frame_type == "C" and len(fields) == 2:
        if fields[1] != options.generation:
            raise ProtocolError("stale_generation")
        return "client_close"

    raise ProtocolError("frame_invalid")


def _spawn_child(options: Options) -> tuple[int, int]:
    child_pid, master_fd = os.forkpty()
    if child_pid == 0:
        try:
            tty.setraw(0, termios.TCSANOW)
            _set_winsize(0, options.cols, options.rows)
            os.environ["TERM"] = options.term
            os.environ.setdefault("LANG", "C.UTF-8")
            os.environ.setdefault("LC_ALL", "C.UTF-8")
            if options.mode == "shell":
                os.execvp("bash", ["bash", "-l"])
            else:
                os.execvp(
                    "tmux",
                    [
                        "tmux",
                        "-u",
                        "attach-session",
                        "-f",
                        "ignore-size",
                        "-t",
                        f"={options.target}",
                    ],
                )
        except BaseException:
            os._exit(127)
    _set_winsize(master_fd, options.cols, options.rows)
    return child_pid, master_fd


def _wait_child(child_pid: int, timeout: float) -> int | None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            waited, status = os.waitpid(child_pid, os.WNOHANG)
        except ChildProcessError:
            return 0
        if waited == child_pid:
            return os.waitstatus_to_exitcode(status)
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.025)


def _signal_child(child_pid: int, sig: signal.Signals) -> None:
    try:
        if os.getpgid(child_pid) == child_pid:
            os.killpg(child_pid, sig)
        else:
            os.kill(child_pid, sig)
    except (ChildProcessError, ProcessLookupError):
        pass


def _cleanup_child(child_pid: int, master_fd: int) -> int:
    _signal_child(child_pid, signal.SIGHUP)
    status = _wait_child(child_pid, CHILD_HUP_SECONDS)
    if status is None:
        _signal_child(child_pid, signal.SIGTERM)
        status = _wait_child(child_pid, CHILD_TERM_SECONDS)
    if status is None:
        _signal_child(child_pid, signal.SIGKILL)
        status = _wait_child(child_pid, CHILD_TERM_SECONDS)
    try:
        os.close(master_fd)
    except OSError:
        pass
    return status if status is not None else 255


def _run(options: Options) -> int:
    outer_fd = sys.stdin.fileno()
    output_fd = sys.stdout.fileno()
    if not os.isatty(outer_fd) or not os.isatty(output_fd):
        print("terminal-pty-byte-bridge requires one outer TTY", file=sys.stderr)
        return 64

    original_termios = termios.tcgetattr(outer_fd)
    child_pid = -1
    master_fd = -1
    child_status: int | None = None
    reason = "internal_error"
    protocol_reason: str | None = None
    stop_signal: int | None = None
    input_buffer = bytearray()
    output_sequence = 0

    def request_stop(signum, _frame) -> None:
        nonlocal stop_signal
        stop_signal = signum

    previous_handlers = {
        sig: signal.signal(sig, request_stop)
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }

    try:
        tty.setraw(outer_fd, termios.TCSAFLUSH)
        child_pid, master_fd = _spawn_child(options)
        _emit(
            output_fd,
            "R",
            options.generation,
            PROTOCOL_VERSION,
            child_pid,
            options.mode,
            options.cols,
            options.rows,
        )

        master_eof = False
        while True:
            if stop_signal is not None:
                reason = f"signal_{stop_signal}"
                break

            readable, _, _ = select.select(
                [outer_fd] + ([] if master_eof else [master_fd]), [], [], 0.1
            )
            if outer_fd in readable:
                outer_chunk = os.read(outer_fd, 4_096)
                if not outer_chunk:
                    reason = "outer_eof"
                    break
                input_buffer.extend(outer_chunk)
                if len(input_buffer) > MAX_FRAME_BYTES and b"\n" not in input_buffer:
                    raise ProtocolError("frame_too_large")
                while True:
                    newline = input_buffer.find(b"\n")
                    if newline < 0:
                        break
                    if newline > MAX_FRAME_BYTES:
                        raise ProtocolError("frame_too_large")
                    line = bytes(input_buffer[:newline])
                    del input_buffer[: newline + 1]
                    if line.endswith(b"\r"):
                        line = line[:-1]
                    frame_reason = _handle_frame(line, options, master_fd)
                    if frame_reason:
                        reason = frame_reason
                        break
                if len(input_buffer) > MAX_FRAME_BYTES:
                    raise ProtocolError("frame_too_large")
                if reason == "client_close":
                    break

            if not master_eof and master_fd in readable:
                try:
                    chunk = os.read(master_fd, OUTPUT_CHUNK_BYTES)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if chunk:
                    output_sequence += 1
                    _emit(
                        output_fd,
                        "O",
                        options.generation,
                        output_sequence,
                        base64.b64encode(chunk).decode("ascii"),
                    )
                else:
                    master_eof = True

            if child_status is None:
                try:
                    waited, status = os.waitpid(child_pid, os.WNOHANG)
                except ChildProcessError:
                    waited, status = child_pid, 0
                if waited == child_pid:
                    child_status = os.waitstatus_to_exitcode(status)
            if child_status is not None and master_eof:
                reason = "child_exit"
                break
    except ProtocolError as error:
        reason = "protocol_error"
        protocol_reason = error.reason
        try:
            _emit(output_fd, "E", options.generation, error.reason)
        except Exception:
            pass
    except (BrokenPipeError, ConnectionError, OSError, TimeoutError) as error:
        reason = "transport_error"
        protocol_reason = type(error).__name__
    finally:
        if child_pid > 0 and master_fd >= 0:
            if child_status is None:
                cleanup_status = _cleanup_child(child_pid, master_fd)
                child_status = cleanup_status
            else:
                try:
                    os.close(master_fd)
                except OSError:
                    pass
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)

    exit_code = child_status if child_status is not None else 255
    try:
        _emit(output_fd, "X", options.generation, reason, exit_code)
    except Exception:
        pass
    finally:
        # Keep the outer TTY raw/noecho until the final protocol line is fully
        # written. Restoring OPOST first would rewrite its LF to CRLF.
        try:
            termios.tcsetattr(outer_fd, termios.TCSANOW, original_termios)
        except termios.error:
            pass
    if protocol_reason is not None:
        return 2
    return 0 if reason in ("client_close", "child_exit") else 1


def main() -> int:
    return _run(_parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
