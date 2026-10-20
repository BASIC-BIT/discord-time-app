#!/usr/bin/env python3
"""Native Tauri/X11 smoke test. Standard library only; run serially on Linux."""
from __future__ import annotations

import argparse
import ctypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
from typing import Mapping
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
READINESS = 30
REQUEST = 5
FAILURE_CAPTURE = 3
TEARDOWN = 5


class Blocked(RuntimeError):
    pass


def build_environment(inherited: Mapping[str, str], run_dir: Path, mode: str) -> dict[str, str]:
    """Preserve system/transport settings, discard application overrides."""
    env = dict(inherited)
    for key in list(env):
        if key in ('NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA'):
            continue
        if key.startswith(('HAMMEROVERLAY_', 'VITE_', 'TAURI_', 'DOTENV_', 'NODE_', 'DB_', 'STATIC_API_', 'TELEMETRY_', 'LANGFUSE_')):
            del env[key]
        elif mode == 'offline' and key.startswith(('OPENAI_', 'TEMPORAL_', 'ANTHROPIC_', 'AZURE_OPENAI_', 'GOOGLE_API_', 'GEMINI_', 'HF_', 'HUGGING_FACE_')):
            del env[key]
    state = run_dir / 'state'
    env.update({f'XDG_{name.upper()}_HOME': str(state / name) for name in ('config', 'data', 'cache', 'state')})
    env.update(XDG_RUNTIME_DIR=str(state / 'runtime'), DOTENV_CONFIG_PATH='/dev/null',
               LANGFUSE_ENABLED='false', HAMMEROVERLAY_API_KEY=secrets.token_hex(32), TZ='UTC')
    if mode == 'offline':
        env.update(TEMPORAL_FEATURE_PLAN_IR='false')
    return env


def make_launch_cwd() -> Path:
    # Rust debug dotenv candidates are cwd/api, ../api and ../../../api.
    # Keep all three beneath a private temporary tree, away from the checkout.
    cwd = Path(tempfile.mkdtemp(prefix='hammer-desktop-cwd-')) / 'isolated' / 'launch' / 'here'
    cwd.mkdir(parents=True)
    return cwd


def check_ports(ports=(8857, 4444, 4445)):
    for port in ports:
        with socket.socket() as probe:
            # Match server socket reuse: TIME_WAIT is not a surviving resource.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', port))
            except OSError as error:
                raise Blocked(f'Required TCP port {port} is occupied; run serially') from error


def http_json(method: str, url: str, payload: object = None, *, timeout: float = REQUEST) -> object:
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json'})
    # Local WebDriver/API traffic must never traverse an inherited HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}: {error.read(8192).decode(errors="replace")}') from error
    if isinstance(result, dict) and isinstance(result.get('value'), dict) and result['value'].get('error'):
        raise RuntimeError(str(result['value']))
    return result


def wait_for(description, condition, timeout=REQUEST):
    deadline = time.monotonic() + timeout
    while True:
        value = condition()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(f'Timed out waiting for {description}')
        time.sleep(.1)


def validate_recording(path: Path, recorder_returncode: int | None) -> dict:
    if recorder_returncode != 0 or not path.exists() or path.stat().st_size == 0:
        raise RuntimeError(f'recording failed, recorder exit={recorder_returncode}')
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
                           capture_output=True, text=True, timeout=FAILURE_CAPTURE)
    if probe.returncode:
        raise RuntimeError('recording is unreadable')
    details = json.loads(probe.stdout)
    if not any(row.get('codec_type') == 'video' for row in details.get('streams', [])) or float(details.get('format', {}).get('duration', 0)) <= 0:
        raise RuntimeError('recording has no video frames')
    # Decode too: a parseable MP4 container alone is insufficient evidence.
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-frames:v', '1', '-f', 'null', '-'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=FAILURE_CAPTURE)
    return {'durationSeconds': float(details['format']['duration']), 'readable': True}


def processes() -> dict[int, tuple[int, int, str]]:
    result = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            tail = path.read_text().rsplit(')', 1)[1].split()
            result[int(path.parent.name)] = (int(tail[1]), int(tail[19]), tail[0])
        except (OSError, ValueError, IndexError):
            pass
    return result


class DesktopSession:
    def __init__(self, *, run_dir: Path, mode: str, time_zone: str = 'UTC',
                 screen_size: tuple[int, int] = (1280, 900), disable_api: bool = False):
        self.run_dir = run_dir
        run_dir.mkdir(parents=True, exist_ok=True)
        self.mode, self.time_zone, self.screen_size, self.disable_api = mode, time_zone, screen_size, disable_api
        self.env = build_environment(os.environ, run_dir, mode)
        self.env['TZ'] = time_zone
        self.secrets = {v for k, v in self.env.items() if any(word in k for word in ('KEY', 'SECRET', 'TOKEN', 'PASSWORD')) and len(v) >= 6}
        self.owned: list[subprocess.Popen] = []
        self.descendants: dict[int, int] = {}
        self.existing_children = {(pid, started) for pid, (parent, started, _state) in processes().items() if parent == os.getpid()}
        self.logs = []
        self.checks = []
        self.metadata = {'modelCoverage': 'offline' if mode == 'offline' else 'pending', 'visualReview': 'pending'}
        self.phase = 'created'
        self.last_command = None
        self.session_id = None
        self.recorder = None
        self.base_url = None
        self.cleanup_errors = []
        self.finalized = False
        # Adopt orphaned helpers so they can be reaped, even when container PID 1
        # does not reap. This affects only descendants of this runner.
        ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER

    def sanitize(self, content: str) -> str:
        for value in sorted(self.secrets, key=len, reverse=True):
            content = content.replace(value, '[redacted]')
            for prefix_length in (6, 7):
                content = content.replace(value[:prefix_length] + '...', '[redacted]')
        return re.sub(r'(?i)(x-api-key|authorization)(["\s:=]+)[^\s,"}]+', r'\1\2[redacted]', content)

    def track(self):
        snapshot = processes()
        # Subreaper-adopted children also belong to this runner, including
        # helpers orphaned between snapshots. Preserve children that predate it.
        parents = {os.getpid()} | {p.pid for p in self.owned} | set(self.descendants)
        changed = True
        while changed:
            changed = False
            for pid, (ppid, started, _state) in snapshot.items():
                if ppid in parents and pid not in parents and (pid, started) not in self.existing_children:
                    parents.add(pid)
                    self.descendants[pid] = started
                    changed = True

    def spawn(self, name: str, args: list[str], *, env=None, cwd=None, stdin=None):
        output = open(self.run_dir / f'{name}.log', 'ab', buffering=0)
        self.logs.append(output)
        process = subprocess.Popen(args, cwd=cwd, env=env or self.env, stdin=stdin or subprocess.DEVNULL,
                                   stdout=output, stderr=output, start_new_session=True)
        self.owned.append(process)
        self.track()
        return process

    def command(self, *args, timeout=REQUEST, input=None, check=True):
        self.last_command = ' '.join(args[:3])
        result = subprocess.run(args, env=self.env, input=input, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f'{args[0]} exited {result.returncode}: {result.stderr[:2000]}')
        return result.stdout.strip()

    def wd(self, method, path, payload=None, *, timeout=REQUEST):
        self.last_command = f'{method} {path}'
        self.track()
        result = http_json(method, self.base_url + (f'/session/{self.session_id}' if self.session_id else '') + path, payload, timeout=timeout)
        return result['value']

    def evaluate(self, script: str, *args: object) -> object:
        return self.wd('POST', '/execute/sync', {'script': script, 'args': list(args)})

    def invoke(self, command: str, args: dict[str, object] | None = None) -> object:
        return self._invoke(command, args, REQUEST)

    def _invoke(self, command, args, timeout):
        result = self.wd('POST', '/execute/async', {'script': '''
          const done = arguments[arguments.length - 1];
          window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
            .then(value => done({ok:true,value})).catch(error => done({ok:false,error:String(error)}));
        ''', 'args': [command, args or {}]}, timeout=timeout)
        if not result['ok']:
            raise RuntimeError(str(result['error']))
        return result['value']

    def keys(self, *keys: str) -> None:
        self.command('xdotool', 'key', '--clearmodifiers', *keys)

    def set_clipboard(self, text):
        # -quiet keeps xclip in the owned foreground group; no pipe is inherited
        # from the runner. It remains alive to serve clipboard selection requests.
        source = self.run_dir / 'clipboard-input'
        source.write_text(text)
        with source.open('rb') as content:
            self.spawn('clipboard', ['xclip', '-quiet', '-selection', 'clipboard', '-i'], stdin=content)
        wait_for('clipboard owner', lambda: self.clipboard() == text)
        source.unlink()

    def paste(self, text: str) -> None:
        self.set_clipboard(text)
        self.keys('ctrl+v')

    def clipboard(self) -> str | None:
        value = self.command('xclip', '-selection', 'clipboard', '-o', check=False)
        return value or None

    def window_visible(self):
        return self.command('xdotool', 'search', '--onlyvisible', '--name', '^HammerOverlay$', check=False) != ''

    def settled_geometry(self):
        previous, count = None, 0
        def settled():
            nonlocal previous, count
            current = self.command('xdotool', 'search', '--onlyvisible', '--name', '^HammerOverlay$', check=False)
            if not current:
                return True
            geometry = self.command('xdotool', 'getwindowgeometry', '--shell', current.splitlines()[0])
            count = count + 1 if geometry == previous else 0
            previous = geometry
            return count >= 3
        wait_for('settled native geometry', settled)

    def capture(self, name: str) -> None:
        self.settled_geometry()
        self.desktop_capture(name)

    def desktop_capture(self, name: str):
        # Capture X11 directly; this works even if WebDriver is stalled/hidden.
        self.command('ffmpeg', '-v', 'error', '-y', '-f', 'x11grab', '-video_size',
                     f'{self.screen_size[0]}x{self.screen_size[1]}', '-i', self.env['DISPLAY'],
                     '-frames:v', '1', '-threads', '1', str(self.run_dir / f'{name}.png'), timeout=FAILURE_CAPTURE)

    def passed(self, name, **details):
        self.checks.append({'check': name, 'passed': True, **details})
        print('PASS ' + name, flush=True)

    def __enter__(self):
        try:
            self.start()
            return self
        except BaseException:
            self.__exit__(*__import__('sys').exc_info())
            raise

    def start(self):
        self.phase = 'startup'
        if not hasattr(self, 'executable'):
            self.executable = build_executable(self)
        startup_deadline = time.monotonic() + READINESS
        def remaining():
            budget = startup_deadline - time.monotonic()
            if budget <= 0:
                raise TimeoutError('Desktop startup exceeded 30-second readiness budget')
            return budget
        for key in ('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'):
            Path(self.env[key]).mkdir(parents=True, mode=0o700, exist_ok=True)
        if self.disable_api:
            self.env['HAMMEROVERLAY_DISABLE_SUPERVISED_API'] = 'true'
        check_ports()
        with socket.socket(socket.AF_UNIX) as instance:
            try:
                instance.bind('\0hammer-overlay-app')
            except OSError as error:
                raise Blocked('HammerOverlay single-instance resource is occupied; run serially') from error
        display = next((n for n in range(90, 200) if not Path(f'/tmp/.X{n}-lock').exists() and not Path(f'/tmp/.X11-unix/X{n}').exists()), None)
        if display is None:
            raise Blocked('No free X11 display')
        self.env['DISPLAY'] = f':{display}'
        self.display = display
        self.spawn('xvfb', ['Xvfb', self.env['DISPLAY'], '-screen', '0', f'{self.screen_size[0]}x{self.screen_size[1]}x24', '-nolisten', 'tcp'])
        wait_for('X11 readiness', lambda: self.command('xdpyinfo', check=False, timeout=min(REQUEST, remaining())) != '', remaining())
        # Each desktop gets a private bus. Never borrow the user's session bus.
        self.spawn('dbus', ['dbus-daemon', '--session', '--nofork', '--print-address=1'])
        wait_for('D-Bus address', lambda: (self.run_dir / 'dbus.log').stat().st_size > 0, remaining())
        self.env['DBUS_SESSION_BUS_ADDRESS'] = (self.run_dir / 'dbus.log').read_text().splitlines()[0]
        self.spawn('openbox', ['openbox'])
        wait_for('window manager readiness', lambda: '_NET_SUPPORTING_WM_CHECK(WINDOW)' in self.command('xprop', '-root', '_NET_SUPPORTING_WM_CHECK', check=False, timeout=min(REQUEST, remaining())), remaining())
        self.command('xdotool', 'mousemove', '0', '0')
        self.recorder = self.spawn('recording', ['ffmpeg', '-v', 'error', '-y', '-f', 'x11grab', '-video_size',
            f'{self.screen_size[0]}x{self.screen_size[1]}', '-framerate', '12', '-i', self.env['DISPLAY'],
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(self.run_dir / 'desktop.mp4')], stdin=subprocess.PIPE)
        # App cwd is a separate /tmp tree, several levels away from any checkout
        # .env candidates read by debug Rust. Sidecar uses the bundled API tree.
        self.launch_cwd = make_launch_cwd()
        self.metadata['environmentIsolation'] = {'dotenvPath': '/dev/null', 'launchCwd': str(self.launch_cwd), 'freshXdgState': True}
        wrapper = self.launch_cwd / 'application.sh'
        wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(str(self.executable)) + '\n')
        wrapper.chmod(0o700)
        self.spawn('driver', ['tauri-driver', '--port', '4444', '--native-port', '4445'], cwd=self.launch_cwd)
        self.base_url = 'http://127.0.0.1:4444'
        def driver_ready():
            try:
                return http_json('GET', self.base_url + '/status', timeout=1)
            except (OSError, RuntimeError):
                return False
        wait_for('Tauri driver readiness', driver_ready, remaining())
        result = self.wd('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': str(wrapper)}}}}, timeout=remaining())
        self.session_id = result['sessionId']
        self.wd('POST', '/timeouts', {'script': 30000, 'implicit': 0, 'pageLoad': 30000})
        self.phase = 'ready'

    def cleanup(self):
        self.track()
        for process in reversed(self.owned):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

        signalled = set()
        direct = {process.pid for process in self.owned}

        def remaining(signal_number):
            # Shutdown can fork or orphan helpers. Discover them throughout
            # convergence, and retain zombies until their parent releases them
            # and this subreaper can waitpid them.
            self.track()
            snapshot = processes()
            for pid, started in self.descendants.items():
                if pid not in snapshot or snapshot[pid][1] != started:
                    continue
                if snapshot[pid][2] != 'Z' and (pid, started, signal_number) not in signalled:
                    try:
                        os.kill(pid, signal_number)
                        signalled.add((pid, started, signal_number))
                    except ProcessLookupError:
                        pass
                if pid not in direct:
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
            for process in self.owned:
                if process.poll() is None and signal_number == signal.SIGKILL:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            snapshot = processes()
            return ([(pid, snapshot[pid][2]) for pid, started in self.descendants.items()
                     if pid in snapshot and snapshot[pid][1] == started]
                    + [(process.pid, 'running') for process in self.owned if process.poll() is None])

        def resources_released():
            if not hasattr(self, 'display'):
                return True
            try:
                check_ports()
                with socket.socket(socket.AF_UNIX) as instance:
                    instance.bind('\0hammer-overlay-app')
                return True
            except (OSError, Blocked):
                return False

        deadline = time.monotonic() + TEARDOWN
        pending = []
        while True:
            pending = remaining(signal.SIGTERM)
            if not pending and resources_released():
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(.02)
        if pending:
            self.cleanup_errors.append('owned processes exceeded the 5-second graceful teardown budget; forced termination required')
        # Keep the existing one-second forced-stop budget. Never signal an
        # untracked owner merely because a fixed port/socket remains occupied.
        kill_deadline = time.monotonic() + 1
        while True:
            pending = remaining(signal.SIGKILL)
            if not pending and resources_released():
                break
            if time.monotonic() >= kill_deadline:
                break
            time.sleep(.02)
        for pid, state in pending:
            self.cleanup_errors.append(f'owned descendant {pid} survived' + (' unreaped' if state == 'Z' else ''))
        if not resources_released():
            self.cleanup_errors.append('desktop API/driver port or single-instance resource remained occupied after teardown')
        for output in self.logs:
            output.close()
        self.logs.clear()

    def __exit__(self, exc_type, exc, tb):
        self.finalize(exc)
        if not exc and (self.metadata.get('captureError') or self.cleanup_errors):
            raise RuntimeError(self.metadata.get('captureError') or '; '.join(self.cleanup_errors))

    def finalize(self, exc=None):
        # Both context exit and main's finally use this path, including failures
        # in prerequisites or builds before a desktop was started.
        if self.finalized:
            return
        self.finalized = True
        if exc:
            self.metadata['failurePhase'] = self.phase
            self.metadata['lastCommand'] = self.last_command
            self.metadata['error'] = self.sanitize(str(exc))
            if 'DISPLAY' in self.env and hasattr(self, 'display'):
                try:
                    self.desktop_capture('failure')
                except Exception as capture_error:
                    self.metadata['failureCaptureError'] = self.sanitize(str(capture_error))
        if self.recorder:
            try:
                if self.recorder.stdin:
                    self.recorder.stdin.write(b'q\n')
                    self.recorder.stdin.close()
                self.recorder.wait(timeout=TEARDOWN)
                self.metadata['recording'] = validate_recording(self.run_dir / 'desktop.mp4', self.recorder.returncode)
            except Exception as recording_error:
                self.metadata['captureError'] = self.sanitize(str(recording_error))
        try:
            self.cleanup()
        except Exception as cleanup_error:
            self.cleanup_errors.append(self.sanitize(str(cleanup_error)))
        if hasattr(self, 'display'):
            for resource in (Path(f'/tmp/.X{self.display}-lock'), Path(f'/tmp/.X11-unix/X{self.display}')):
                if resource.exists():
                    self.cleanup_errors.append(f'owned X11 resource survived: {resource}')
        # Archive only sanitized logs, never state/settings/key files or database.
        for path in (self.run_dir / 'state').rglob('*.log'):
            (self.run_dir / ('api-' + path.name)).write_text(self.sanitize(path.read_text(errors='replace')))
        for path in self.run_dir.glob('*.log'):
            path.write_text(self.sanitize(path.read_text(errors='replace')))
        shutil.rmtree(self.run_dir / 'state', ignore_errors=True)
        if hasattr(self, 'launch_cwd'):
            shutil.rmtree(self.launch_cwd.parents[2], ignore_errors=True)
        self.metadata['cleanupErrors'] = self.cleanup_errors


def fill_fixture(session: DesktopSession, text: str):
    # Explicit clearing is fixture setup. clipboard_replacement separately
    # exercises direct replacement of imported text without clearing first.
    session.evaluate('document.querySelector("textarea").focus(); return true')
    session.command('xdotool', 'mousemove', '0', '0')
    session.keys('ctrl+a', 'BackSpace')
    wait_for('empty fixture input', lambda: session.evaluate('return document.querySelector("textarea")?.value') == '')
    session.paste(text)
    wait_for('fixture paste', lambda: session.evaluate('return document.querySelector("textarea")?.value') == text)


def database_rows(session):
    path = Path(session.env['XDG_DATA_HOME']) / 'com.hammer-overlay.app' / 'temporal-api-usage.db'
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as database:
        database.row_factory = sqlite3.Row
        generations = [dict(row) for row in database.execute('SELECT * FROM temporal_generations')]
        outcomes = [dict(row) for row in database.execute('SELECT * FROM temporal_generation_outcomes')]
        usage = [dict(row) for row in database.execute('SELECT epoch, tz FROM usage')]
    return generations, outcomes, usage


def run_baseline(session: DesktopSession) -> None:
    s = session
    s.phase = 'global hotkey'
    s.keys('ctrl+shift+h')
    wait_for('visible overlay', s.window_visible, READINESS)
    wait_for('overlay textarea', lambda: s.evaluate('return !!document.querySelector("textarea")'), READINESS)
    assert s.evaluate('return Intl.DateTimeFormat().resolvedOptions().timeZone') == 'UTC', 'Test device timezone is not UTC'
    s.capture('00-open')
    s.passed('global hotkey opens actual Tauri overlay')

    s.phase = 'supervised API readiness'
    def ready_sidecar():
        config = s.invoke('get_time_parser_config')
        return config if config['available'] and config['supervised'] else None
    wait_for('supervised API', ready_sidecar, READINESS)
    health = http_json('GET', 'http://127.0.0.1:8857/health')
    config = health['config']
    if s.mode == 'offline':
        assert config['OPENAI_API_KEY'] == 'not configured', 'Offline API unexpectedly has an OpenAI provider'
        assert not config.get('TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL'), 'Offline API unexpectedly has an endpoint provider'
        assert not config['LANGFUSE_ENABLED'], 'Offline observability is enabled'
    s.metadata['providerConfiguration'] = {
        'openaiConfigured': config['OPENAI_API_KEY'] != 'not configured',
        'endpointConfigured': bool(config.get('TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL')),
        'observabilityEnabled': config['LANGFUSE_ENABLED'],
    }
    s.passed('Rust supervises real Node API', available=True, supervised=True)

    s.phase = 'authenticated native parse'
    parsed = s.invoke('parse_time_with_local_service', {'request': {
        'requestId': 'desktop-' + secrets.token_hex(8), 'text': '<t:1780000000:f>', 'tz': 'UTC',
        'now': '2026-05-27T16:00:00Z',
    }})
    assert parsed['ok'] and parsed['status'] == 200 and parsed['body']['epoch'] == 1780000000, parsed
    api_generation = parsed['body']['generationId']
    s.passed('WebKit to Rust IPC to authenticated Node parse', epoch=parsed['body']['epoch'], generationId=api_generation)

    s.phase = 'seven formats'
    before = {r['generation_id'] for r in database_rows(s)[0]}
    fill_fixture(s, '<t:1780000000:f>')
    wait_for('seven previews', lambda: s.evaluate('return document.querySelectorAll(".row").length') == 7)
    codes = s.evaluate('return Array.from(document.querySelectorAll(".row .format-code"), e => e.textContent)')
    assert set(codes) == {f'<t:1780000000:{code}>' for code in ('t', 'T', 'd', 'D', 'f', 'F', 'R')}, codes
    wait_for('format f selected', lambda: s.evaluate('return document.querySelector(".row.selected .format-code")?.textContent') == '<t:1780000000:f>')
    s.capture('01-timestamp')
    def token_generation():
        return next((r['generation_id'] for r in database_rows(s)[0] if r['generation_id'] not in before and r['final_epoch'] == 1780000000 and r['route'] == 'direct_instant'), None)
    copied_generation = wait_for('token generation persisted', token_generation)
    s.passed('pasted timestamp renders all seven formats', rows=7, generationId=copied_generation)

    s.phase = 'Down Enter clipboard and hide'
    s.keys('Down')
    wait_for('F selected', lambda: s.evaluate('return document.querySelector(".row.selected .format-code")?.textContent') == '<t:1780000000:F>')
    s.capture('02-keyboard-selection')
    s.keys('Return')
    wait_for('exact native clipboard', lambda: s.clipboard() == '<t:1780000000:F>')
    # Observe actual X11 unmapping before sending the reopen shortcut. A DOM
    # unmount can precede the asynchronous native hide.
    wait_for('native hide completion after Enter', lambda: not s.window_visible())
    s.capture('03-hidden')
    s.passed('OS Down Enter copies exact F output and dismisses overlay')

    s.phase = 'hide reopen clipboard import'
    s.keys('ctrl+shift+h')
    wait_for('native reopen', s.window_visible)
    wait_for('clipboard import on reopen', lambda: s.evaluate('return document.querySelector("textarea")?.value') == '<t:1780000000:F>')
    s.capture('04-clipboard-reopen')
    s.passed('global hotkey reopens and imports native clipboard')

    s.phase = 'clipboard_replacement'
    replacement = '<t:1780000000:t> - <t:1780003600:t>'
    s.keys('ctrl+a')
    s.paste(replacement)
    wait_for('complete clipboard replacement', lambda: s.evaluate('return document.querySelector("textarea")?.value') == replacement)
    wait_for('replacement five range previews', lambda: s.evaluate('return document.querySelectorAll(".range-row, .row").length') == 5)
    s.capture('04-clipboard-replacement')

    imported = '<t:1780000000:F>'
    for variant, selection, typed, expected in (
        ('selected all typing', [0, 16], 'May', 'May'),
        ('selected format typing', [14, 15], 'T', '<t:1780000000:T>'),
        ('caret insertion', [1, 1], 'x', '<xt:1780000000:F>'),
        ('caret deletion', [16, 16], None, '<t:1780000000:F'),
    ):
        s.keys('Escape')
        wait_for('hide before imported edit', lambda: not s.window_visible())
        s.set_clipboard(imported)
        s.keys('ctrl+shift+h')
        wait_for('reopen before imported edit', s.window_visible)
        wait_for('fresh imported edit text', lambda: s.evaluate('return document.querySelector("textarea")?.value') == imported)
        s.settled_geometry()
        wait_for('import focus and selection', lambda: s.evaluate('''
            const input = document.querySelector("textarea");
            return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
        '''))
        # Set only the selection fixture. Native typing/deletion must still
        # deliver the browser's real input event to React.
        s.evaluate('document.querySelector("textarea").setSelectionRange(...arguments[0]); return true', selection)
        wait_for(variant + ' selection', lambda: s.evaluate('''
            const input = document.querySelector("textarea");
            return [input.selectionStart, input.selectionEnd];
        ''') == selection)
        if typed is None:
            s.keys('BackSpace')
        else:
            s.command('xdotool', 'type', '--clearmodifiers', '--', typed)
        wait_for(variant, lambda: s.evaluate('return document.querySelector("textarea")?.value') == expected)
    s.passed('clipboard_replacement', rows=5, editVariants=['selected all typing', 'selected format typing', 'caret insertion', 'caret deletion'])

    s.phase = 'range previews'
    fill_fixture(s, '<t:1780000000:t> - <t:1780003600:t>')
    wait_for('five range previews', lambda: s.evaluate('return document.querySelectorAll(".range-row, .row").length') == 5)
    s.capture('05-range')
    s.passed('range input renders five range formats', rows=5)

    s.phase = 'malformed rejection'
    fill_fixture(s, '<t:99999999999999999999999999999:f>')
    wait_for('malformed rejection', lambda: s.evaluate('return document.querySelector(".status-line")?.textContent?.includes("malformed")'))
    assert s.evaluate('return document.querySelectorAll(".row").length') == 0
    s.capture('06-invalid')
    s.passed('malformed timestamp shows an error and no copyable result')

    s.phase = 'offline natural language'
    fill_fixture(s, 'May 28, 2026 at 2 PM')
    wait_for('fixed UTC natural language', lambda: s.evaluate('return document.querySelector(".row .format-code")?.textContent?.startsWith("<t:1779976800:")'), READINESS)
    s.capture('07-natural-language')
    s.passed('UTC natural language resolves May 28 2026 at 2 PM', epoch=1779976800)

    s.phase = 'Escape hide'
    s.keys('Escape')
    wait_for('native hide completion after Escape', lambda: not s.window_visible())
    s.passed('OS Escape dismisses overlay')

    s.phase = 'SQLite run correlation'
    def persisted():
        generations, outcomes, usage = database_rows(s)
        ids = {r['generation_id'] for r in generations}
        copy = next((r for r in outcomes if r['generation_id'] == copied_generation and r['action'] == 'copied'), None)
        return (generations, outcomes, usage, copy) if api_generation in ids and copy and any(r['epoch'] == 1780000000 for r in usage) else None
    generations, outcomes, usage, copy = wait_for('correlated SQLite records', persisted)
    assert copy['selected_format_index'] == 5, copy
    if s.mode == 'offline':
        assert sum(r['model_calls'] or 0 for r in generations) == 0, 'Offline run made model calls'
    s.metadata['generationIds'] = [r['generation_id'] for r in generations]
    s.passed('real SQLite persists this run parse and copy outcome', apiGenerationId=api_generation,
             copiedGenerationId=copied_generation, modelCalls=sum(r['model_calls'] or 0 for r in generations))


def run_model(session):
    s = session
    s.phase = 'explicit model-required parse'
    started = time.monotonic()
    # Exact model-required row/reference from api/scripts/temporal-live-smoke.ts.
    result = s._invoke('parse_time_with_local_service', {'request': {
        'requestId': 'desktop-model-' + secrets.token_hex(8),
        'text': 'day after next saturday at l33t time', 'tz': 'America/New_York',
        'now': '2026-05-24T12:00:00Z',
    }}, READINESS)
    latency = round((time.monotonic() - started) * 1000)
    assert result['ok'] and result['body']['epoch'] == 1780249020, result
    assert re.search('agent|tool', result['body']['method'], re.I), 'Fallback is not model coverage'
    generation_id = result['body']['generationId']
    row = next(r for r in database_rows(s)[0] if r['generation_id'] == generation_id)
    assert row['model_calls'] and row['model_calls'] > 0 and row['model_name'] and row['total_duration_ms'] is not None, 'Missing persisted model identity/duration'
    s.metadata.update(modelCoverage='passed', modelIdentity=row['model_name'], modelParseLatencyMs=latency, parsingSloMs=5000, withinParsingSlo=latency <= 5000)
    s.passed('explicit model-required row and persisted identity', generationId=generation_id, latencyMs=latency)


def build_executable(session: DesktopSession):
    # The same environment and secret inventory follow setup, compilation and
    # desktop execution. Every child belongs to the session even before entry.
    run_dir = session.run_dir
    session.last_command = 'Linux prerequisite check'
    prerequisite = session.spawn('prerequisites', ['bash', 'scripts/setup-linux-desktop.sh', '--check'], cwd=ROOT)
    if prerequisite.wait(timeout=60):
        raise Blocked('Linux prerequisites are unavailable; see prerequisites.log')
    session.last_command = 'Cargo metadata'
    metadata = session.spawn('cargo-metadata', ['cargo', 'metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], cwd=ROOT)
    if metadata.wait(timeout=30):
        raise RuntimeError('Cargo metadata failed; see cargo-metadata.log')
    cargo = json.loads((run_dir / 'cargo-metadata.log').read_text())
    package = next(p for p in cargo['packages'] if Path(p['manifest_path']).resolve() == ROOT / 'src-tauri/Cargo.toml')
    binary = next(target['name'] for target in package['targets'] if 'bin' in target['kind'])
    executable = Path(cargo['target_directory']) / 'debug' / binary
    # Force Cargo to produce this invocation's executable; never run a stale one
    # after a failing frontend/API or native build.
    executable.unlink(missing_ok=True)
    session.last_command = 'Tauri native build'
    build = session.spawn('build', ['npm', 'run', 'tauri', '--', 'build', '--debug', '--no-bundle', '--config', 'src-tauri/tauri.linux-test.conf.json'], cwd=ROOT)
    if build.wait() or not executable.is_file():
        raise RuntimeError('Native build failed; see build.log')
    return executable


def write_results(session, exit_code):
    result = {'exitCode': exit_code, 'status': {0: 'passed', 1: 'failed', 2: 'blocked'}[exit_code],
              'mode': session.mode, 'checks': session.checks, **session.metadata}
    encoded = session.sanitize(json.dumps(result, indent=2)) + '\n'
    (session.run_dir / 'results.json').write_text(encoded)
    lines = [f'# Desktop smoke {result["status"]}', '', f'Mode: {session.mode}. Checks completed: {len(session.checks)}.',
             'Visual review: ' + session.metadata['visualReview'] + '.', '',
             f'Phase: {session.metadata.get("failurePhase", session.phase)}.',
             f'Commit: {session.metadata.get("commit", "unknown")}; dirty: {session.metadata.get("dirty", "unknown")}.',
             f'Model coverage: {session.metadata["modelCoverage"]}.', '',
             *['- PASS ' + check['check'] for check in session.checks]]
    if 'error' in session.metadata:
        lines += ['', 'Failure: ' + session.metadata['error'], 'Last command: ' + str(session.metadata.get('lastCommand'))]
    if session.metadata.get('captureError'):
        lines += ['', 'Capture failure: ' + session.metadata['captureError']]
    if session.cleanup_errors:
        lines += ['', 'Cleanup failure: ' + '; '.join(session.cleanup_errors)]
    (session.run_dir / 'summary.md').write_text(session.sanitize('\n'.join(lines)) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('offline', 'model'), default='offline')
    parser.add_argument('--suite', choices=('baseline', 'picker', 'all'), default='baseline')
    parser.add_argument('--repeat', type=int, default=1)
    args = parser.parse_args()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(3)
    executable = None
    for iteration in range(max(1, args.repeat)):
        run_dir = ROOT / 'artifacts' / 'desktop' / f'{stamp}-{iteration + 1:02d}'
        session = DesktopSession(run_dir=run_dir, mode=args.mode)
        exit_code = 1
        failure = None
        try:
            session.metadata.update(commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                                    dirty=bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True)), suite=args.suite)
            if args.repeat < 1 or (args.repeat > 1 and args.mode != 'offline'):
                raise Blocked('Repeat must be positive and is offline-only')
            if args.suite != 'baseline':
                raise Blocked('Only the baseline suite is implemented; picker/all arrive with the picker')
            if args.mode == 'model' and not (session.env.get('OPENAI_API_KEY') or (session.env.get('TEMPORAL_FEATURE_PLAN_IR', '').lower() in ('true', '1') and session.env.get('TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL') and session.env.get('TEMPORAL_PLAN_IR_ENDPOINT_MODEL'))):
                session.metadata['modelCoverage'] = 'blocked: missing provider configuration'
                raise Blocked('Explicit model mode requires configured OpenAI credentials or an enabled Plan-IR endpoint and model identity')
            session.phase = 'build'
            if executable is None:
                executable = build_executable(session)
            session.executable = executable
            session.metadata.update(executable=str(executable), executableSha256=hashlib.sha256(executable.read_bytes()).hexdigest())
            if iteration:
                shutil.copyfile(ROOT / 'artifacts' / 'desktop' / f'{stamp}-01' / 'prerequisites.log', run_dir / 'prerequisites.log')
            session.metadata['toolVersions'] = (run_dir / 'prerequisites.log').read_text()
            with session:
                run_baseline(session)
                if args.mode == 'model':
                    run_model(session)
            exit_code = 0
        except Exception as error:
            failure = error
            exit_code = 2 if isinstance(error, Blocked) else 1
            session.metadata.setdefault('error', session.sanitize(str(error)))
            session.metadata.setdefault('failurePhase', session.phase)
        finally:
            session.finalize(failure)
            if exit_code == 0 and (session.metadata.get('captureError') or session.cleanup_errors):
                exit_code = 1
                session.metadata.setdefault('error', session.metadata.get('captureError') or '; '.join(session.cleanup_errors))
            write_results(session, exit_code)
            print(f'{session.run_dir}: {"PASS" if exit_code == 0 else "BLOCKED" if exit_code == 2 else "FAIL"}', flush=True)
        if exit_code:
            return exit_code
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
