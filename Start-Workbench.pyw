import json
import os
import subprocess
import sys
from pathlib import Path


def main(powershell):
    root = Path(__file__).resolve().parent
    config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    data_dir = Path(os.environ.get("GPT_WORKBENCH_DATA") or config.get("dataDir") or root / "data")
    data_dir.mkdir(parents=True, exist_ok=True)

    try:
        listener = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-File", str(root / "Start-Workbench.ps1")],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        output, exit_code = listener.stdout, listener.returncode
    except OSError as error:
        output, exit_code = f"Cannot start GPT Workbench: {error}\n".encode("utf-8"), 1

    if output:
        with (data_dir / "listener.log").open("ab") as log:
            log.write(output)
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
