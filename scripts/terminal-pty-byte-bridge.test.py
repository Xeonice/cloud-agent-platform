#!/usr/bin/env python3
"""Deterministic contract tests for the provider-owned child-PTY bridge."""

from __future__ import annotations

import base64
import errno
import importlib.util
import os
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("terminal-pty-byte-bridge.py")
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("cap_terminal_pty_byte_bridge", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load terminal PTY byte bridge")
BRIDGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BRIDGE
SPEC.loader.exec_module(BRIDGE)


def write_all(fd: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        offset += os.write(fd, payload[offset:])


class TerminalPtyByteBridgeTest(unittest.TestCase):
    def options(self):
        return BRIDGE.Options(
            mode="shell",
            target=None,
            generation="test-generation",
            cols=80,
            rows=24,
            term="xterm-256color",
        )

    def test_input_frame_restores_every_byte_exactly(self) -> None:
        expected = bytes(range(256))
        read_fd, write_fd = os.pipe()
        try:
            line = (
                b"I test-generation " + base64.b64encode(expected)
            )
            self.assertIsNone(BRIDGE._handle_frame(line, self.options(), write_fd))
            os.close(write_fd)
            write_fd = -1
            self.assertEqual(os.read(read_fd, 512), expected)
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)

    def test_stale_and_noncanonical_input_fail_closed(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            with self.assertRaisesRegex(BRIDGE.ProtocolError, "stale_generation"):
                BRIDGE._handle_frame(b"I stale YQ==", self.options(), write_fd)
            with self.assertRaisesRegex(
                BRIDGE.ProtocolError, "input_base64_noncanonical"
            ):
                BRIDGE._handle_frame(
                    b"I test-generation Zh==", self.options(), write_fd
                )
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_shell_mode_uses_a_real_child_pty_and_ascii_outer_wire(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cap-pty-bridge-") as cwd:
            master_fd, slave_fd = pty.openpty()
            env = {
                **os.environ,
                "HOME": cwd,
                "PS1": "",
                "BASH_SILENCE_DEPRECATION_WARNING": "1",
            }
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--shell",
                    "--generation",
                    "shell-generation",
                    "--cols",
                    "80",
                    "--rows",
                    "24",
                    "--term",
                    "xterm-256color",
                ],
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=subprocess.PIPE,
                cwd=cwd,
                env=env,
                close_fds=True,
            )
            os.close(slave_fd)
            buffer = bytearray()
            child_output = bytearray()
            sequences: list[int] = []
            ready_seen = False
            exit_seen = False
            command_sent = False
            deadline = time.monotonic() + 8.0
            try:
                while time.monotonic() < deadline and not exit_seen:
                    readable, _, _ = select.select([master_fd], [], [], 0.1)
                    if master_fd not in readable:
                        continue
                    try:
                        chunk = os.read(master_fd, 4_096)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        break
                    self.assertTrue(all(byte < 0x80 for byte in chunk))
                    buffer.extend(chunk)
                    while b"\n" in buffer:
                        line, _, remainder = buffer.partition(b"\n")
                        buffer = bytearray(remainder)
                        fields = line.decode("ascii").split(" ")
                        if fields[0] == "R":
                            self.assertEqual(fields[1], "shell-generation")
                            self.assertEqual(fields[2], "1")
                            self.assertEqual(fields[4:], ["shell", "80", "24"])
                            ready_seen = True
                        elif fields[0] == "O":
                            self.assertEqual(fields[1], "shell-generation")
                            sequences.append(int(fields[2]))
                            encoded = fields[3].encode("ascii")
                            decoded = base64.b64decode(encoded, validate=True)
                            self.assertEqual(base64.b64encode(decoded), encoded)
                            child_output.extend(decoded)
                        elif fields[0] == "X":
                            self.assertEqual(fields[1], "shell-generation")
                            self.assertEqual(fields[2:], ["child_exit", "0"])
                            exit_seen = True
                        else:
                            self.fail(f"unexpected bridge frame: {fields[0]}")
                    if ready_seen and not command_sent:
                        command = (
                            b"printf 'CAP_CWD=%s\\n' \"$PWD\"; "
                            b"printf '\\342\\224\\200\\n'; exit\n"
                        )
                        write_all(
                            master_fd,
                            b"I shell-generation "
                            + base64.b64encode(command)
                            + b"\n",
                        )
                        command_sent = True

                self.assertTrue(ready_seen)
                self.assertTrue(exit_seen)
                self.assertEqual(sequences, list(range(1, len(sequences) + 1)))
                self.assertIn(f"CAP_CWD={cwd}".encode(), child_output)
                self.assertIn("─".encode(), child_output)
                self.assertNotIn("�".encode(), child_output)
                self.assertEqual(process.wait(timeout=2), 0)
                self.assertEqual(process.stderr.read(), b"")
                process.stderr.close()
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=2)
                if not process.stderr.closed:
                    process.stderr.close()
                os.close(master_fd)


if __name__ == "__main__":
    unittest.main()
