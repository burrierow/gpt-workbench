import runpy
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

watchdog = runpy.run_path(str(Path(__file__).resolve().parents[1] / "Start-Workbench.pyw"))


class WatchdogTest(unittest.TestCase):
    def test_detects_listener_exit(self):
        listener = Mock()
        listener.wait.return_value = 17
        self.assertIn("exited with code 17", watchdog["supervise"](listener, Path("unused"), "test"))

    def test_detects_stale_health(self):
        listener = Mock()
        listener.wait.side_effect = subprocess.TimeoutExpired("listener", 0)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "health.json"
            path.write_text('{"watchdogId":"previous", "checkedAt":"old"}', encoding="utf-8")
            self.assertIn("health stopped updating", watchdog["supervise"](listener, path, "current", 0, 0))

    def test_terminates_listener_after_grace_timeout(self):
        listener = Mock()
        listener.poll.return_value = None
        listener.wait.side_effect = [subprocess.TimeoutExpired("listener", 5), 0]
        watchdog["stop_listener"](listener)
        listener.terminate.assert_called_once()
        listener.kill.assert_called_once()


if __name__ == "__main__":
    unittest.main()
