"""malo_client 的离线用例：假 broker/lease 服务 + 标准库 unittest。运行：npm run test:client"""

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

CLIENT = Path(__file__).resolve().parents[2] / "clients" / "python" / "malo_client.py"
spec = importlib.util.spec_from_file_location("malo_client_under_test", CLIENT)
malo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(malo)
# 用例基类会把 _spawn_daemon 换成「禁止真拉起」的哨兵；观察真实拉起参数的那条用例用原件
REAL_SPAWN = malo._spawn_daemon

BROKER_TOKEN = "broker-token-for-tests"
LEASE_TOKEN = "lease-token-for-tests"
SESSION_TOKEN = "session-token-for-tests"


class FakeDaemon:
    """一个进程内的假 daemon：broker 路由 + lease 路由，记录收到的请求。"""

    def __init__(self, version="0.2.0"):
        self.version = version
        self.token = BROKER_TOKEN
        self.leases: dict[str, dict] = {}
        self.heartbeats: list[str] = []
        self.tool_calls: list[tuple[str, dict]] = []
        self.state_leases: list[dict] = []
        self.requests: list[tuple[str, str]] = []
        self.slow_tool_seconds = 0.0
        self.log_lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _body(self):
                length = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(length) or b"{}")

            def _authorized(self, expected):
                given = self.headers.get("x-malo-broker-token") or self.headers.get("x-malo-lease-token")
                if given != expected:
                    self._send(401, {"ok": False, "error": {"code": "E_CONTROL_UNAUTHORIZED"}})
                    return False
                return True

            def do_GET(self):
                with outer.log_lock:
                    outer.requests.append(("GET", self.path))
                if self.path == "/health":
                    return self._send(200, {"status": "ok", "version": outer.version})
                if self.path == "/v1/leases":
                    if not self._authorized(BROKER_TOKEN):
                        return
                    return self._send(200, {"leases": list(outer.leases.values())})
                if self.path == "/v1/state":
                    if not self._authorized(BROKER_TOKEN):
                        return
                    return self._send(200, {"leases": outer.state_leases})
                if self.path == "/v1/tools":
                    if not self._authorized(LEASE_TOKEN):
                        return
                    return self._send(200, {"tools": [{"name": name} for name in malo.BASE_REQUIRED_TOOLS]})
                return self._send(404, {"ok": False})

            def do_POST(self):
                body = self._body()
                with outer.log_lock:
                    outer.requests.append(("POST", self.path))
                if self.path == "/v1/leases":
                    if not self._authorized(BROKER_TOKEN):
                        return
                    # 同 agent 名 + 同持有者复用，与 daemon 的规则一致
                    for existing in outer.leases.values():
                        if existing["agent_id"] == body.get("agent_id") and \
                                existing.get("holder") == body.get("holder"):
                            return self._send(201, existing)
                    lease_id = f"lease-{len(outer.leases) + 1}"
                    port = self.server.server_address[1]
                    record = {
                        "lease_id": lease_id, "agent_id": body.get("agent_id"),
                        "endpoint": f"http://127.0.0.1:{port}", "token": LEASE_TOKEN,
                        "version": outer.version, "features": ["lease.holder"], "ttl_seconds": 6,
                        "holder": body.get("holder"),
                    }
                    outer.leases[lease_id] = record
                    return self._send(201, record)
                if self.path == "/v1/sessions":
                    if not self._authorized(LEASE_TOKEN):
                        return
                    return self._send(201, {"session_id": "session-1", "session_token": SESSION_TOKEN})
                if self.path.endswith("/heartbeat"):
                    if not self._authorized(BROKER_TOKEN):
                        return
                    lease_id = self.path.split("/")[3]
                    if lease_id not in outer.leases:
                        return self._send(404, {"ok": False, "error": {"code": "E_LEASE_NOT_FOUND"}})
                    outer.heartbeats.append(lease_id)
                    return self._send(200, outer.leases[lease_id])
                if "/tools/" in self.path:
                    headers_ok = (self.headers.get("x-malo-lease-token") == LEASE_TOKEN
                                  and self.headers.get("x-malo-session-token") == SESSION_TOKEN)
                    if not headers_ok:
                        return self._send(401, {"ok": False})
                    tool = self.path.rsplit("/", 1)[1]
                    outer.tool_calls.append((tool, body))
                    if tool == "slow":
                        time.sleep(outer.slow_tool_seconds)
                    return self._send(200, {"tool": tool, "result": {"echo": body}})
                return self._send(404, {"ok": False})

            def do_DELETE(self):
                with outer.log_lock:
                    outer.requests.append(("DELETE", self.path))
                if not self._authorized(BROKER_TOKEN):
                    return
                lease_id = self.path.split("/")[3]
                removed = outer.leases.pop(lease_id, None)
                if removed is None:
                    return self._send(404, {"ok": False, "error": {"code": "E_LEASE_NOT_FOUND"}})
                return self._send(200, {"ok": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}"

    def broker_file(self, path: Path) -> Path:
        path.write_text(json.dumps({
            "endpoint": self.endpoint, "token": self.token, "pid": os.getpid(),
            "version": self.version, "features": ["lease.holder"],
        }))
        return path

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class ClientCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.broker_file = Path(self.tmp.name) / "broker.json"
        self.daemon = FakeDaemon()
        self.daemon.broker_file(self.broker_file)
        # 心跳间隔压到 0.05s，才能在用例里观察到续租
        patcher = mock.patch.object(malo, "HEARTBEAT_MIN_INTERVAL_S", 0.05)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.stderr = tempfile.TemporaryFile(mode="w+")
        stderr_patch = mock.patch("sys.stderr", self.stderr)
        stderr_patch.start()
        self.addCleanup(stderr_patch.stop)
        # 保险：用例永远不许真拉起 daemon（会占住默认端口）。需要观察拉起的用例自己再 patch 一次。
        guard = mock.patch.object(
            malo, "_spawn_daemon",
            side_effect=AssertionError("用例不得真拉起 malo daemon；需要时请 patch malo._spawn_daemon"))
        guard.start()
        self.addCleanup(guard.stop)

    def tearDown(self):
        self.daemon.stop()
        self.stderr.close()
        self.tmp.cleanup()

    def acquire(self, **kwargs) -> "malo.MaloLease":
        return malo.acquire_lease("agent-under-test", broker_file=self.broker_file, **kwargs)


class LeaseTests(ClientCase):
    def test_heartbeat_keeps_the_lease_alive_in_the_background_and_release_stops_it(self):
        lease = self.acquire()
        try:
            self.assertIsNotNone(lease._hb_thread)
            deadline = time.time() + 3
            while time.time() < deadline and not self.daemon.heartbeats:
                time.sleep(0.02)
            self.assertIn(lease.lease_id, self.daemon.heartbeats)
            thread = lease._hb_thread
        finally:
            lease.release()
        self.assertIsNone(lease._hb_thread)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.daemon.leases, {})
        beats = len(self.daemon.heartbeats)
        time.sleep(0.3)
        self.assertEqual(len(self.daemon.heartbeats), beats, "release 之后不该再有心跳")

    def test_same_process_reuses_one_lease(self):
        first = self.acquire()
        second = self.acquire()
        try:
            self.assertEqual(first.lease_id, second.lease_id)
            self.assertEqual(len(self.daemon.leases), 1)
        finally:
            first.release()
            second.release()

    def test_a_failed_heartbeat_stops_renewing_and_explains_the_next_call(self):
        lease = self.acquire()
        self.daemon.leases.clear()  # daemon 侧把租约回收了
        deadline = time.time() + 3
        while time.time() < deadline and lease.heartbeat_error is None:
            time.sleep(0.02)
        self.assertIsNotNone(lease.heartbeat_error)
        with self.assertRaisesRegex(malo.MaloError, "租约 .* 已失效"):
            lease.new_session("x")
        lease.release()  # 幂等，且不抛

    def test_capability_check_failure_releases_the_lease(self):
        with self.assertRaisesRegex(malo.MaloError, "缺工具"):
            self.acquire(required_tools=("teleport",))
        self.assertEqual(self.daemon.leases, {})

    def test_lease_is_a_context_manager_and_sessions_scope_their_calls(self):
        with self.acquire() as lease, lease.new_session("work", profile="p") as session:
            result = session.call("click", {"selector": "#ok"})
        self.assertEqual(result, {"echo": {"selector": "#ok"}})
        self.assertEqual([tool for tool, _ in self.daemon.tool_calls], ["click", "close"])
        self.assertEqual(self.daemon.leases, {})

    def test_manual_heartbeat_still_works(self):
        lease = self.acquire(heartbeat=False)
        try:
            self.assertIsNone(lease._hb_thread)
            lease.heartbeat()
            self.assertEqual(self.daemon.heartbeats, [lease.lease_id])
        finally:
            lease.release()


class TransportTests(ClientCase):
    def test_connect_refused_and_timeout_are_reported_differently(self):
        with self.assertRaisesRegex(malo.MaloError, "连不上"):
            malo._http("GET", "http://127.0.0.1:1/health", timeout=1)
        self.daemon.slow_tool_seconds = 1.2
        with self.assertRaisesRegex(malo.MaloError, "请求超时"):
            malo._http("POST", f"{self.daemon.endpoint}/v1/sessions/s/tools/slow",
                       {"a": 1}, {"x-malo-lease-token": LEASE_TOKEN,
                                  "x-malo-session-token": SESSION_TOKEN}, timeout=0.3)

    def test_http_errors_carry_the_status_and_body(self):
        with self.assertRaisesRegex(malo.MaloError, "malo HTTP 401.*E_CONTROL_UNAUTHORIZED"):
            malo._http("GET", f"{self.daemon.endpoint}/v1/state", headers={"x-malo-broker-token": "wrong"})

    def test_call_timeout_follows_the_daemon_side_wait_for_long_tools(self):
        lease = self.acquire(heartbeat=False)
        try:
            with lease.new_session("s") as session:
                session.call("slow", {"timeout_ms": 800})
        finally:
            lease.release()
        self.assertEqual(malo._default_call_timeout("login", {"mode": "watch"}), 210)
        self.assertEqual(malo._default_call_timeout("login", {"timeout_ms": 600_000}), 630)
        self.assertEqual(
            malo._default_call_timeout("run_steps", {"steps": [
                {"type": "click"}, {"type": "sleep", "ms": 2000},
                {"type": "wait_for", "timeout_ms": 3000}, {"type": "assert"}]}),
            15 + 2 + 3 + 5 + 30)
        self.assertEqual(malo._default_call_timeout("snapshot", {}), 120)


class DaemonStartupTests(ClientCase):
    def test_reuses_a_healthy_daemon_and_passes_through_its_broker_info(self):
        info = malo.ensure_daemon(broker_file=self.broker_file)
        self.assertEqual((info["endpoint"], info["token"]), (self.daemon.endpoint, BROKER_TOKEN))

    def test_refuses_when_the_running_daemon_does_not_own_the_token(self):
        self.broker_file.write_text(json.dumps({"endpoint": self.daemon.endpoint, "token": "stale"}))
        with self.assertRaisesRegex(malo.MaloError, "不认.*token"):
            malo.ensure_daemon(broker_file=self.broker_file)

    def test_a_requested_debug_port_that_is_closed_fails_loud_without_killing(self):
        with mock.patch.object(malo, "_spawn_daemon") as spawn, mock.patch("os.kill") as kill:
            with self.assertRaisesRegex(malo.MaloError, "CDP 调试口 .* 未开"):
                malo.ensure_daemon(broker_file=self.broker_file, debug_port=1)
            # 端口被别的进程占着、又没有 broker token：同样不拉起
            self.broker_file.write_text("{}")
            with self.assertRaisesRegex(malo.MaloError, "没有 broker token"):
                malo.ensure_daemon(broker_file=self.broker_file)
        spawn.assert_not_called()
        kill.assert_not_called()

    def test_stale_daemon_with_no_leases_is_restarted_so_new_code_takes_effect(self):
        self.daemon.version = "0.1.9"
        self.daemon.broker_file(self.broker_file)
        with mock.patch.object(malo, "_repo_version", return_value="0.2.0"), \
                mock.patch.object(malo.os, "kill") as kill, \
                mock.patch.object(malo, "_spawn_daemon") as spawn, \
                mock.patch.object(malo, "_pid_alive", return_value=False):
            # 停掉旧进程后端口应当关闭；这里假 daemon 还在监听，_wait_ready 会立刻认为新 daemon 就绪
            info = malo.ensure_daemon(broker_file=self.broker_file)
        kill.assert_called_once_with(os.getpid(), malo.signal.SIGTERM)
        spawn.assert_called_once()
        self.assertEqual(info["version"], "0.1.9")

    def test_stale_daemon_that_still_serves_leases_is_left_alone(self):
        self.daemon.version = "0.1.9"
        self.daemon.broker_file(self.broker_file)
        self.daemon.state_leases = [{"agent_id": "busy-agent"}]
        with mock.patch.object(malo, "_repo_version", return_value="0.2.0"), \
                mock.patch("os.kill") as kill, mock.patch.object(malo, "_spawn_daemon") as spawn:
            with self.assertRaisesRegex(malo.MaloError, "落后于本仓 0.2.0.*busy-agent"):
                malo.ensure_daemon(broker_file=self.broker_file)
        kill.assert_not_called()
        spawn.assert_not_called()

    def test_a_newer_running_daemon_is_kept_and_restart_can_be_opted_out(self):
        self.daemon.version = "0.3.0"
        self.daemon.broker_file(self.broker_file)
        with mock.patch.object(malo, "_repo_version", return_value="0.2.0"), mock.patch("os.kill") as kill:
            info = malo.ensure_daemon(broker_file=self.broker_file)
            self.assertEqual(info["version"], "0.3.0")
            self.daemon.version = "0.1.0"
            self.daemon.broker_file(self.broker_file)
            kept = malo.ensure_daemon(broker_file=self.broker_file, restart_stale=False)
            self.assertEqual(kept["version"], "0.1.0")
        kill.assert_not_called()

    def test_version_tuples_compare_numerically(self):
        self.assertLess(malo._version_tuple("0.1.9"), malo._version_tuple("0.1.18"))
        self.assertLess(malo._version_tuple("0.1.18"), malo._version_tuple("0.2.0"))
        self.assertEqual(malo._version_tuple("0.2.0-rc1"), (0, 2, 0))

    def test_reserved_daemon_flags_are_rejected_and_env_args_are_parsed(self):
        with self.assertRaisesRegex(ValueError, "--data-dir"):
            malo._daemon_args(["--data-dir=/tmp/x"])
        with mock.patch.dict(os.environ, {"MALO_DAEMON_ARGS": "--proxy-server=http://127.0.0.1:7890"}):
            self.assertEqual(malo._daemon_args(["--max-sessions-total=8"]),
                             ["--proxy-server=http://127.0.0.1:7890", "--max-sessions-total=8"])

    def test_spawning_passes_data_dir_and_the_remembered_port(self):
        tmp = Path(self.tmp.name)
        (tmp / "broker.json").write_text(json.dumps({"endpoint": "http://127.0.0.1:7530"}))
        captured = {}

        def fake_popen(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["env"] = dict(kwargs)

        fake_bin = tmp / "node_modules" / ".bin" / "electron"
        fake_bin.parent.mkdir(parents=True)
        fake_bin.write_text("")
        fake_out = tmp / "out" / "main" / "index.js"
        fake_out.parent.mkdir(parents=True)
        fake_out.write_text("")
        with mock.patch.object(malo, "MALO_REPO", tmp), mock.patch.object(malo.subprocess, "Popen", side_effect=fake_popen):
            REAL_SPAWN(tmp / "broker.json", tmp / "daemon.log", debug_port=9450,
                       extra_args=["--proxy-server=http://127.0.0.1:7890"])
        self.assertEqual(captured["cmd"][2:], [
            "--mode=daemon", f"--data-dir={tmp}", "--daemon-port=7530",
            "--remote-debugging-port=9450", "--proxy-server=http://127.0.0.1:7890"])
        self.assertEqual(captured["env"]["cwd"], tmp)
        self.assertTrue(captured["env"]["start_new_session"])


class ImportGuardTests(unittest.TestCase):
    def test_import_requires_an_explicit_domain_list(self):
        lease = mock.Mock()
        lease._post.return_value = {"ok": True}
        malo.import_profile_login(lease, "work", "http://127.0.0.1:9223", [" example.com "], 30)
        lease._post.assert_called_once_with("/v1/profiles/work/import", {
            "cdp_url": "http://127.0.0.1:9223", "domains": ["example.com"],
            "session_cookie_ttl_days": 30})
        for bad in (None, [], [""]):
            with self.assertRaises(ValueError):
                malo.import_profile_login(lease, "work", "http://127.0.0.1:9223", bad)


if __name__ == "__main__":
    sys.exit(unittest.main())
