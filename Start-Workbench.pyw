import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def supervise(listener, health_path, watchdog_id, health_timeout=60, poll_interval=5):
    last_seen = time.monotonic()
    last_pulse = None
    while True:
        try:
            return f"listener exited with code {listener.wait(timeout=poll_interval)}"
        except subprocess.TimeoutExpired:
            pass
        try:
            health = json.loads(health_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            health = {}
        if not isinstance(health, dict):
            health = {}
        pulse = health.get("checkedAt")
        if health.get("watchdogId") == watchdog_id and pulse and pulse != last_pulse:
            last_seen = time.monotonic()
            last_pulse = pulse
        if time.monotonic() - last_seen >= health_timeout:
            return f"listener health stopped updating for {health_timeout} seconds"


def stop_listener(listener):
    if listener.poll() is not None:
        return
    listener.terminate()
    try:
        listener.wait(timeout=5)
    except subprocess.TimeoutExpired:
        listener.kill()
        listener.wait(timeout=5)


def main(powershell):
    root = Path(__file__).resolve().parent
    config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    data_dir = Path(os.environ.get("GPT_WORKBENCH_DATA") or config.get("dataDir") or root / "data")
    data_dir.mkdir(parents=True, exist_ok=True)

    restart_delay = 2
    with (data_dir / "watchdog.log").open("a", encoding="utf-8", buffering=1) as log:
        while True:
            watchdog_id = uuid.uuid4().hex
            env = {**os.environ, "GPT_WORKBENCH_WATCHDOG_ID": watchdog_id}
            started = time.monotonic()
            try:
                resolved = subprocess.run(
                    [powershell, "-NoProfile", "-NonInteractive", "-File", str(root / "Start-Workbench.ps1"), "-ResolveExecutables"],
                    cwd=root,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=log,
                    timeout=15,
                    check=True,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                executables = json.loads(resolved.stdout.decode("utf-8-sig"))
                env["GPT_WORKBENCH_CODEX"] = executables["codex"]
                with (data_dir / "listener.log").open("ab", buffering=0) as output:
                    listener = subprocess.Popen(
                        [executables["node"], str(root / "workbench.mjs"), "serve"],
                        cwd=root,
                        env=env,
                        stdin=subprocess.PIPE,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
            except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
                reason = f"cannot start listener: {error}"
            else:
                print(f"{datetime.now(timezone.utc).isoformat()} started listener PID {listener.pid}", file=log)
                try:
                    reason = supervise(listener, data_dir / "listener-health.json", watchdog_id)
                finally:
                    try:
                        stop_listener(listener)
                    except (OSError, subprocess.SubprocessError) as error:
                        reason = f"listener termination failed: {error}"
                    finally:
                        listener.stdin.close()
            if time.monotonic() - started >= 60:
                restart_delay = 2
            print(f"{datetime.now(timezone.utc).isoformat()} {reason}; restarting in {restart_delay}s", file=log)
            time.sleep(restart_delay)
            restart_delay = min(30, restart_delay * 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
