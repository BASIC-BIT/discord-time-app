"""Real OS/HTTP boundaries; no native application fixtures."""
import contextlib
import http.server
import io
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from desktop_smoke import DesktopSession, build_environment, http_json, validate_recording, check_ports, Blocked, make_launch_cwd


class RunnerBoundaries(unittest.TestCase):
    def test_offline_env_removes_provider_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            env = build_environment({"OPENAI_API_KEY": "sentinel-provider-key", "HTTPS_PROXY": "http://proxy:8080", "NODE_EXTRA_CA_CERTS": "/transport/ca.pem",
                                     "TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL": "http://model.invalid",
                                     "HAMMEROVERLAY_API_ENV": "/checkout/api/.env", "VITE_API_URL": "http://remote.invalid",
                                     "NODE_OPTIONS": "--require=/checkout/inject.js", "TAURI_CONFIG": "inherited-override", "LANGFUSE_SECRET_KEY": "secret"}, run_dir, "offline")
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertEqual(env["HTTPS_PROXY"], "http://proxy:8080")
            self.assertEqual(env["DOTENV_CONFIG_PATH"], "/dev/null")
            self.assertEqual(env["NODE_EXTRA_CA_CERTS"], "/transport/ca.pem")
            for key in ["TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL", "HAMMEROVERLAY_API_ENV", "VITE_API_URL", "NODE_OPTIONS", "TAURI_CONFIG", "LANGFUSE_SECRET_KEY"]:
                self.assertNotIn(key, env)
            self.assertNotEqual(Path(env['XDG_DATA_HOME']), Path.home())

    def test_model_env_preserves_configured_identity_without_logging_secrets(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()) as output:
            env = build_environment({'OPENAI_API_KEY': 'sk-sentinel-secret', 'OPENAI_MODEL': 'configured-model'}, Path(tmp), 'model')
            self.assertEqual(env['OPENAI_API_KEY'], 'sk-sentinel-secret')
            self.assertEqual(env['OPENAI_MODEL'], 'configured-model')
            session = DesktopSession(run_dir=Path(tmp), mode='model')
            session.secrets.add(env['OPENAI_API_KEY'])
            self.assertNotIn('sk-sentinel-secret', session.sanitize('key=sk-sentinel-secret'))
            self.assertNotIn('sk-sen...', session.sanitize('key=sk-sen...'))
        self.assertNotIn('sk-sentinel-secret', output.getvalue())

    def test_stalled_webdriver_times_out(self):
        class Hung(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                time.sleep(.7)
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Hung)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        started = time.monotonic()
        try:
            with self.assertRaises((TimeoutError, OSError)):
                http_json('GET', f'http://127.0.0.1:{server.server_port}/status', timeout=.1)
            self.assertLess(time.monotonic() - started, .5)
        finally:
            server.shutdown()
            server.server_close()

    def test_failed_recording_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            recording = Path(tmp) / 'desktop.mp4'
            recording.write_bytes(b'not an mp4')
            with self.assertRaisesRegex(RuntimeError, 'recording'):
                validate_recording(recording, recorder_returncode=1)
            with self.assertRaisesRegex(RuntimeError, 'recording'):
                validate_recording(recording, recorder_returncode=0)
            session = DesktopSession(run_dir=Path(tmp), mode='offline')
            session.recorder = session.spawn('failed-recorder', [sys.executable, '-c', 'raise SystemExit(1)'])
            session.recorder.wait(timeout=2)
            with self.assertRaisesRegex(RuntimeError, 'recording'):
                session.__exit__(None, None, None)

    def test_launch_cwd_cannot_find_checkout_dotenv_candidates(self):
        cwd = make_launch_cwd()
        try:
            checkout = Path(__file__).resolve().parents[1]
            self.assertFalse(cwd.is_relative_to(checkout))
            for parent in (cwd, cwd.parent, cwd.parents[2]):
                self.assertFalse((parent / 'api' / '.env').exists())
                self.assertFalse((parent / 'api').resolve().is_relative_to(checkout))
        finally:
            import shutil
            shutil.rmtree(cwd.parents[2])

    def test_port_gate_rejects_live_listener_but_allows_tcp_time_wait(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaises(Blocked):
                check_ports((port,))
            with socket.create_connection(('127.0.0.1', port)) as client:
                accepted, _ = listener.accept()
                accepted.close()
                self.assertEqual(client.recv(1), b'')
        check_ports((port,))

    def test_cleanup_only_terminates_owned_process_groups(self):
        # The grandchild ignores TERM and holds a listening socket. Killing just
        # its immediate parent would leave both the descendant and resource live.
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            pid_file = run_dir / 'descendant'
            code = '''import os,signal,socket,time
s=socket.socket();s.bind(('127.0.0.1',0));s.listen()
pid=os.fork()
if pid==0:
 os.setsid()
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 open(%r,'w').write(str(os.getpid())+' '+str(s.getsockname()[1]))
 while True: time.sleep(1)
os._exit(0)
''' % str(pid_file)
            unrelated = subprocess.Popen(['sleep', '60'], start_new_session=True)
            session = DesktopSession(run_dir=run_dir, mode='offline')
            try:
                session.spawn('fixture', [sys.executable, '-c', code])
                deadline = time.monotonic() + 3
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                child_pid, port = map(int, pid_file.read_text().split())
                session.cleanup()
                self.assertIsNone(unrelated.poll())
                stat = Path(f'/proc/{child_pid}/stat')
                self.assertFalse(stat.exists() and stat.read_text().split()[2] != 'Z', 'live grandchild survived')
                with socket.socket() as released:
                    released.bind(('127.0.0.1', port))
                self.assertTrue(any('forced termination' in error for error in session.cleanup_errors))
            finally:
                session.cleanup()
                if pid_file.exists():
                    orphan_pid = int(pid_file.read_text().split()[0])
                    try:
                        os.kill(orphan_pid, signal.SIGKILL)
                        os.waitpid(orphan_pid, 0)
                    except (ProcessLookupError, ChildProcessError):
                        pass
                unrelated.terminate()
                unrelated.wait(timeout=2)


if __name__ == '__main__':
    unittest.main()
