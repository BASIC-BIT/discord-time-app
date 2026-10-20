"""Real OS/HTTP boundaries; no native application fixtures."""
import contextlib
import http.server
import io
import itertools
import json
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
from unittest.mock import patch

import desktop_smoke

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

    def exercise_failed_build(self, root, *, fail_step='build', orphan=False):
        tools = root / 'tools'
        tools.mkdir()
        (root / 'scripts').mkdir()
        fixture = root / 'fixture.py'
        fixture.write_text("""import json,os,signal,socket,sys,time
from pathlib import Path
root=Path(__file__).parent
step=sys.argv[1]
if step=='git':
 if sys.argv[2]=='rev-parse': print('a'*40)
 sys.exit(0)
if step=='cargo' and os.environ['FIXTURE_FAIL_STEP']!='cargo':
 print(json.dumps({'target_directory':str(root/'target'),'packages':[{'manifest_path':str(root/'src-tauri/Cargo.toml'),'targets':[{'name':'fixture-app','kind':['bin']}]}]}))
 sys.exit(0)
credentials=[os.environ['OPENAI_API_KEY'],os.environ['HAMMEROVERLAY_API_KEY']]
for value in credentials:
 print(value,value[:6]+'...',value[:7]+'...',flush=True)
(root/('credentials-'+step+'.json')).write_text(json.dumps(credentials))
if os.environ['FIXTURE_FAIL_STEP']==step:
 if os.environ['FIXTURE_ORPHAN']=='1':
  listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen()
  pid=os.fork()
  if pid==0:
   os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)
   (root/'orphan').write_text(str(os.getpid())+' '+str(listener.getsockname()[1]))
   while True: time.sleep(1)
  while not (root/'orphan').exists():time.sleep(.01)
 sys.exit(1)
""")
        for name, step in [('git', 'git'), ('cargo', 'cargo'), ('npm', 'build')]:
            command = tools / name
            command.write_text(f'#!{sys.executable}\nimport os,sys\nos.execv(sys.executable,[sys.executable,{str(fixture)!r},{step!r},*sys.argv[1:]])\n')
            command.chmod(0o700)
        (root / 'scripts/setup-linux-desktop.sh').write_text(f'exec {sys.executable} {fixture} prerequisites\n')
        env = {'PATH': str(tools) + os.pathsep + os.environ['PATH'],
               'OPENAI_API_KEY': 'sk-failed-build-secret-sentinel', 'FIXTURE_FAIL_STEP': fail_step,
               'FIXTURE_ORPHAN': '1' if orphan else '0'}
        generated = itertools.count(1)
        def token_hex(size):
            return f'generated-{next(generated)}-auth-sentinel' if size == 32 else 'fixture'
        with patch.object(desktop_smoke, 'ROOT', root), patch.object(sys, 'argv', ['desktop_smoke.py', '--mode', 'model']), patch.dict(os.environ, env), patch.object(desktop_smoke.secrets, 'token_hex', side_effect=token_hex), contextlib.redirect_stdout(io.StringIO()):
            status = desktop_smoke.main()
        return status, next((root / 'artifacts/desktop').iterdir())

    def test_failed_build_finalizes_owned_orphan_without_killing_unrelated_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            unrelated = subprocess.Popen(['sleep', '60'], start_new_session=True)
            try:
                status, artifacts = self.exercise_failed_build(root, orphan=True)
                pid, port = map(int, (root / 'orphan').read_text().split())
                self.assertEqual(status, 1)
                self.assertIsNone(unrelated.poll())
                stat = Path(f'/proc/{pid}/stat')
                self.assertFalse(stat.exists() and stat.read_text().split()[2] != 'Z', 'failed build left its detached helper alive')
                with socket.socket() as released:
                    released.bind(('127.0.0.1', port))
                result = json.loads((artifacts / 'results.json').read_text())
                self.assertEqual(result['error'], 'Native build failed; see build.log')
                self.assertEqual(result['failurePhase'], 'build')
                self.assertTrue(any('forced termination' in error for error in result['cleanupErrors']))
            finally:
                if (root / 'orphan').exists():
                    pid = int((root / 'orphan').read_text().split()[0])
                    try:
                        os.kill(pid, signal.SIGKILL)
                        os.waitpid(pid, 0)
                    except (ProcessLookupError, ChildProcessError):
                        pass
                unrelated.terminate()
                unrelated.wait(timeout=2)

    def test_pre_session_failures_sanitize_inherited_and_generated_credentials(self):
        for step, expected_status in [('prerequisites', 2), ('cargo', 1), ('build', 1)]:
            with self.subTest(step=step), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                status, artifacts = self.exercise_failed_build(root, fail_step=step)
                self.assertEqual(status, expected_status)
                credentials = json.loads((root / ('credentials-' + step + '.json')).read_text())
                evidence = '\n'.join(p.read_text() for p in artifacts.iterdir() if p.is_file())
                for value in credentials:
                    for emitted in (value, value[:6] + '...', value[:7] + '...'):
                        self.assertNotIn(emitted, evidence)
                result = json.loads((artifacts / 'results.json').read_text())
                self.assertIn('cleanupErrors', result)
                self.assertFalse((artifacts / 'state').exists())

    def test_serial_finalize_reaps_helpers_forked_during_shutdown(self):
        # A real detached helper forks while its parent handles TERM, retaining
        # the app-like single-instance socket. Finalize must discover it, signal
        # it gracefully, reap it, then let the next fresh session bind the socket.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            address = '\0desktop-serial-' + str(os.getpid())
            code = r"""import os,signal,socket,sys
from pathlib import Path
root=Path(sys.argv[1]); listener=socket.socket(socket.AF_UNIX)
listener.bind('\0'+sys.argv[2]); listener.listen()
def terminate(signum, frame):
 pid=os.fork()
 if pid==0:
  os.setsid();signal.signal(signal.SIGTERM,signal.SIG_DFL)
  (root/'child').write_text(str(os.getpid()))
  while True: signal.pause()
 os._exit(0)
signal.signal(signal.SIGTERM,terminate)
(root/'ready').write_text('ready')
while True: signal.pause()
"""
            class SocketSession(DesktopSession):
                def start(self):
                    self.spawn('holder', [sys.executable, '-c', code, str(self.run_dir), address[1:]])
                    desktop_smoke.wait_for('owned socket holder', lambda: (self.run_dir / 'ready').exists())

            unrelated = subprocess.Popen(['sleep', '60'], start_new_session=True)
            sessions = []
            try:
                for index in range(2):
                    session = SocketSession(run_dir=root / str(index), mode='offline')
                    sessions.append(session)
                    with session:
                        pass
                    self.assertEqual(session.cleanup_errors, [])
                    pid = int((session.run_dir / 'child').read_text())
                    self.assertFalse(Path(f'/proc/{pid}').exists(), 'owned shutdown helper was not reaped')
                    with socket.socket(socket.AF_UNIX) as released:
                        released.bind(address)
                self.assertIsNone(unrelated.poll())
            finally:
                for session in sessions:
                    session.cleanup()
                unrelated.terminate()
                unrelated.wait(timeout=2)

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
