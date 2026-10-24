#!/usr/bin/env python3
"""Runs a command in a pseudo-terminal and drives it like a person at a terminal.

Reads a JSON spec on stdin:
  {"cmd": [...], "env": {...}, "cwd": "...", "cols": 100, "rows": 30, "timeout": 30,
   "steps": [{"wait": "text"}, {"absent": "text", "within": 1}, {"send": "keys"},
             {"resize": [50, 14]}, {"signal": "TERM"}, {"sleep": 0.5}]}
and prints JSON: {"code": exit code or null, "signal": name or null, "output": everything the
program wrote, "failed": the step that timed out, or null}.

A "wait" looks for its text in what was written since the previous wait matched, with escape
sequences taken out, so text left on screen from before doesn't count; an "absent" fails if its
text shows up within that many seconds. Only the standard
library: CI machines have python3, and node-pty would be a native dependency.
"""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ESCAPES = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])")


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    spec = json.load(sys.stdin)
    pid, fd = pty.fork()
    if pid == 0:
        set_size(0, spec.get("cols", 100), spec.get("rows", 30))
        if spec.get("cwd"):
            os.chdir(spec["cwd"])
        os.execve(spec["cmd"][0], spec["cmd"], spec.get("env", {}))

    output = bytearray()
    mark = 0
    deadline = time.monotonic() + spec.get("timeout", 30)
    status = None

    def pump(seconds):
        """Reads whatever arrives within `seconds`; notes the exit status once there is one."""
        nonlocal status
        end = time.monotonic() + seconds
        while True:
            left = end - time.monotonic()
            ready, _, _ = select.select([fd], [], [], max(0, min(left, 0.05)))
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    output.extend(chunk)
            if status is None:
                done, st = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = st
            if left <= 0 or (status is not None and not ready):
                return

    def text_since(start):
        return ESCAPES.sub("", output[start:].decode("utf-8", "replace"))

    failed = None
    for step in spec.get("steps", []):
        if "wait" in step:
            limit = time.monotonic() + step.get("timeout", 15)
            while True:
                plain = text_since(mark)
                at = plain.find(step["wait"])
                if at >= 0:
                    mark = len(output)
                    break
                if time.monotonic() > min(limit, deadline) or status is not None:
                    failed = {"step": step, "seen": plain[-2000:]}
                    break
                pump(0.1)
            if failed:
                break
        elif "absent" in step:
            pump(step.get("within", 1))
            if step["absent"] in text_since(mark):
                failed = {"step": step, "seen": text_since(mark)[-2000:]}
                break
        elif "send" in step:
            os.write(fd, step["send"].encode("utf-8"))
            pump(0.05)
        elif "resize" in step:
            cols, rows = step["resize"]
            set_size(fd, cols, rows)
            os.kill(pid, signal.SIGWINCH)
            pump(0.05)
        elif "signal" in step:
            os.kill(pid, getattr(signal, "SIG" + step["signal"]))
            pump(0.05)
        elif "sleep" in step:
            pump(step["sleep"])

    # Let it finish on its own, then make sure it's gone.
    while status is None and time.monotonic() < deadline:
        pump(0.2)
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    pump(0.1)

    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
    sig = signal.Signals(os.WTERMSIG(status)).name if os.WIFSIGNALED(status) else None
    json.dump(
        {"code": code, "signal": sig, "output": output.decode("utf-8", "replace"), "failed": failed},
        sys.stdout,
    )


main()
