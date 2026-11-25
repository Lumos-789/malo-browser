#!/usr/bin/env python3
"""malo-browser daemon 的 Python 传输层客户端（零第三方依赖）。

malo daemon = 后台 Electron broker：127.0.0.1:7410 分发端口租约（7411-7499），
session 工具走 HTTP（POST /v1/sessions/:id/tools/<tool>，双 token：lease+session）。
本模块只管传输与生命周期：按需拉起 daemon、租约（心跳/释放）、session
（profile 持久化登录态）、工具调用、capabilities 校验、profile 登录态导入。
页面语义由调用方负责。

用法：
    from malo_client import acquire_lease
    lease = acquire_lease("my-agent")
    try:
        with lease.new_session("work", profile="work") as s:
            s.call("navigate", {"url": "https://example.com"})
            print(s.call("snapshot", {"max_chars": 5000}))
    finally:
        lease.release()
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# 仓内自指：clients/python/ 的上上级即仓根（electron 与 out/main 都在这里）。
MALO_REPO = Path(__file__).resolve().parent.parent.parent
BROKER_JSON = Path.home() / ".malo-browser" / "broker.json"
DEFAULT_BROKER_ENDPOINT = "http://127.0.0.1:7410"
DEFAULT_LOG = Path.home() / ".malo-browser" / "daemon.log"
# daemon 的 CDP 调试口：带上后 session 页即普通 CDP target，
# Playwright connect_over_cdp 可直连（登录链等存量脚本的迁移通道）。
DEFAULT_CDP_PORT = 9450

# 每个客户端按需声明必需工具；缺失 = daemon 版本过旧，fail-loud 不降级。
BASE_REQUIRED_TOOLS = ("navigate", "click", "fill", "snapshot", "assert", "close")
# 必需能力：没有 lease.holder 的 daemon 会忽略持有者、退回「同 agent 名共用租约」，
# 并行进程又会互踩——所以不当没事，直接失败提示重启。
BASE_REQUIRED_FEATURES = ("lease.holder",)

_PROCESS_HOLDER: str | None = None


def _holder() -> str:
    """本进程的持有者标识（进程级唯一）。"""
    global _PROCESS_HOLDER
    if _PROCESS_HOLDER is None:
        _PROCESS_HOLDER = uuid.uuid4().hex
    return _PROCESS_HOLDER


class MaloError(RuntimeError):
    """malo 链路失败（拉起/租约/工具），message 自带证据，不兜底。"""


def _http(method: str, url: str, payload: dict | None = None,
          headers: dict | None = None, timeout: float = 30) -> dict:
    """一次 JSON HTTP 调用 → 解析后的 body；非 2xx 抛 MaloError（带响应体）。"""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise MaloError(f"malo HTTP {e.code} {url}: {detail}") from e
    except (urllib.error.URLError, socket.timeout, ConnectionError) as e:
        raise MaloError(f"malo 连不上 {url}: {type(e).__name__} {e}") from e
    try:
        return json.loads(body) if body else {}
    except json.JSONDecodeError as e:
        raise MaloError(f"malo 响应非 JSON {url}: {body[:200]}") from e


def _port_open(endpoint: str, timeout: float = 2.0) -> bool:
    try:
        host = urllib.parse.urlsplit(endpoint).hostname or "127.0.0.1"
        port = urllib.parse.urlsplit(endpoint).port or 80
    except ValueError:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _read_broker_json() -> dict:
    try:
        return json.loads(BROKER_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _broker_port(endpoint: str) -> int:
    try:
        return urllib.parse.urlsplit(endpoint).port or 80
    except ValueError:
        return 0


def _token_accepted(info: dict) -> bool:
    """broker.json 里的 token 是否正是运行中 daemon 认的那一个。

    端口开着不等于文件是新鲜的：daemon 先监听后写文件，旧文件残留的 token 会被拒。
    """
    token, endpoint = info.get("token"), info.get("endpoint")
    if not token or not endpoint:
        return False
    try:
        _http("GET", f"{endpoint}/v1/leases", None, {"x-malo-broker-token": token}, timeout=5)
        return True
    except MaloError:
        return False


@contextlib.contextmanager
def _start_lock():
    """同一次冷启动只让一个进程拉起 daemon，其余在锁上等它起来，拿到锁后直接复用。"""
    lock_path = BROKER_JSON.parent / "daemon.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _spawn_daemon(started_by: str, log_path: Path, debug_port: int | None = None) -> None:
    """后台拉起 daemon（detached，不抢焦点；日志追加到 log_path）。"""
    electron = MALO_REPO / "node_modules" / ".bin" / "electron"
    entry = MALO_REPO / "out" / "main" / "index.js"
    for p, hint in ((electron, f"malo 仓未装依赖: {MALO_REPO}"),
                    (entry, f"malo 未构建（out/main 缺失）: cd {MALO_REPO} && npm run build")):
        if not p.exists():
            raise MaloError(f"无法拉起 malo daemon——{hint}")
    cmd = [str(electron), ".", "--mode=daemon"]
    if debug_port:
        cmd.append(f"--remote-debugging-port={debug_port}")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a") as log:
        log.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} spawn by {started_by} =====\n")
        log.flush()
        subprocess.Popen(
            cmd, cwd=MALO_REPO,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True)


def ensure_daemon(wait_s: float = 60.0, log_path: Path | None = None,
                  debug_port: int | None = None) -> dict:
    """broker 就绪（健康复用/死了拉起）→ 返回 broker.json 内容（endpoint/token）。

    多个进程同时发现 daemon 不在时，只由拿到启动锁的那个拉起，其余等它就绪后复用。
    就绪的判据是「broker.json 的 token 被运行中的 daemon 认」，不是端口开着。
    debug_port：要求 daemon 带 CDP 调试口跑。daemon 活着但没带口时 fail-loud
    （登录态在运行中的进程里，不静默杀进程重启——由调用方处置）。
    """
    log = log_path or DEFAULT_LOG
    with _start_lock():
        info = _read_broker_json()
        endpoint = info.get("endpoint") or DEFAULT_BROKER_ENDPOINT
        if info.get("token") and _port_open(endpoint):
            if not _token_accepted(info):
                raise MaloError(
                    f"{endpoint} 上的进程不认 {BROKER_JSON} 里的 token（文件与运行中的 daemon 不一致），"
                    f"不拉起也不复用。确认端口上是谁：lsof -nP -iTCP:{_broker_port(endpoint)} -sTCP:LISTEN")
            if debug_port is not None and not _port_open(f"http://127.0.0.1:{debug_port}"):
                raise MaloError(
                    f"malo daemon 在跑（{endpoint}）但 CDP 调试口 {debug_port} 未开。"
                    f"该进程内可能挂着带登录态的 session，不自动杀；确认无需保留后执行："
                    f"pkill -f 'malo.*--mode=daemon' 再重跑（本次会带调试口拉起）。")
            return info
        if not info.get("token") and _port_open(endpoint):
            raise MaloError(
                f"{endpoint} 有进程在监听，但 {BROKER_JSON} 里没有 broker token"
                f"（不是 malo daemon，或文件损坏），不拉起也不复用。"
                f"确认端口上是谁：lsof -nP -iTCP:{_broker_port(endpoint)} -sTCP:LISTEN")
        print(f"[malo] daemon 不在（{endpoint}），后台拉起（{MALO_REPO}）")
        _spawn_daemon(started_by="python-client", log_path=log, debug_port=debug_port)
        deadline = time.time() + wait_s
        while time.time() < deadline:
            fresh = _read_broker_json()
            if fresh.get("endpoint") and fresh.get("token") and _token_accepted(fresh):
                if debug_port is None or _port_open(f"http://127.0.0.1:{debug_port}", timeout=1.0):
                    return fresh
            time.sleep(1.5)
    tail = ""
    try:
        tail = log.read_text(encoding="utf-8")[-600:] if log.is_file() else "(无日志)"
    except OSError:
        tail = "(日志读失败)"
    raise MaloError(f"malo daemon {wait_s:.0f}s 未就绪（{endpoint}）；启动日志尾:\n{tail}")


def acquire_lease(agent_id: str, required_tools: tuple[str, ...] = BASE_REQUIRED_TOOLS,
                  log_path: Path | None = None,
                  required_features: tuple[str, ...] = BASE_REQUIRED_FEATURES) -> "MaloLease":
    """ensure daemon → 租约 → capabilities 校验。

    租约按「agent_id + 本进程持有者」发：同一进程里重复申请复用同一租约；不同进程
    即使同名也各拿各的，谁的 close/release 都不会放掉并行兄弟的会话。
    """
    broker = ensure_daemon(log_path=log_path)
    endpoint = broker.get("endpoint") or DEFAULT_BROKER_ENDPOINT
    token = broker.get("token")
    if not token:
        raise MaloError(f"{BROKER_JSON} 缺 token（daemon 端点 {endpoint}），无法租约")
    lease = _http("POST", f"{endpoint}/v1/leases",
                  {"agent_id": agent_id, "holder": _holder()},
                  {"x-malo-broker-token": token})
    ml = MaloLease(endpoint=lease["endpoint"], token=lease["token"],
                   lease_id=lease["lease_id"], agent_id=agent_id,
                   broker_endpoint=endpoint, broker_token=token,
                   features=tuple(lease.get("features") or ()))
    ml.check_capabilities(required_tools, required_features)
    return ml


def import_profile_login(lease: "MaloLease", profile: str, cdp_url: str,
                         domains: list[str] | None = None,
                         session_cookie_ttl_days: int = 180) -> dict:
    """把源 Chromium（回环 CDP 端点）的 cookies 热导入 malo profile。

    返回 {cookies_total/cookies_matched/cookies_written/cookies_failed/...}；
    源连不上抛 MaloError(502 E_IMPORT_SOURCE_UNREACHABLE)，0 条命中抛 400。
    """
    body: dict = {"cdp_url": cdp_url, "session_cookie_ttl_days": session_cookie_ttl_days}
    if domains:
        body["domains"] = domains
    return lease._post(f"/v1/profiles/{profile}/import", body)


def open_session(agent_id: str, url: str, profile: str | None = None,
                 debug_port: int | None = DEFAULT_CDP_PORT,
                 required_tools: tuple[str, ...] = BASE_REQUIRED_TOOLS,
                 log_path: Path | None = None,
                 settle_ms: int = 3000,
                 width: int = 1440, height: int = 900) -> tuple["MaloLease", "MaloSession"]:
    """一步到位：拉起带 CDP 调试口的 daemon → 租约 → profile 会话 → 导航到 url。

    返回 (lease, session)；调用方 finally 里 session.close() + lease.release()
    （登录态已沉淀 profile，收尾失败不影响）。导航结果 ok:false 时抛 MaloError。
    Playwright 直连调试口（http://127.0.0.1:<debug_port>）可继续驱动该会话页。
    width/height 是会话视口（CSS 内容区，录制场景按 16:9 给）。
    """
    ensure_daemon(log_path=log_path, debug_port=debug_port)
    lease = acquire_lease(agent_id, required_tools=required_tools, log_path=log_path)
    try:
        session = lease.new_session(f"{profile or 'anon'}-session", profile=profile,
                                    width=width, height=height)
        r = session.call("navigate", {"url": url, "timeout_ms": 45_000,
                                      "settle_ms": settle_ms})
        if isinstance(r, dict) and r.get("ok") is False:
            raise MaloError(f"malo 会话导航失败（{url}）：{str(r)[:300]}")
        return lease, session
    except Exception:
        lease.release()
        raise


class MaloLease:
    """一个端口租约：心跳续租、session 生命周期、工具调用入口。"""

    def __init__(self, endpoint: str, token: str, lease_id: str, agent_id: str,
                 broker_endpoint: str, broker_token: str,
                 features: tuple[str, ...] = ()):
        self.endpoint = endpoint          # lease 端口，如 http://127.0.0.1:7411
        self.token = token                # lease token
        self.lease_id = lease_id
        self.agent_id = agent_id
        self.features = features          # daemon 握手带的能力清单
        self._headers = {"x-malo-lease-token": token}
        self._broker = (broker_endpoint, broker_token)

    def check_capabilities(self, required: tuple[str, ...] = BASE_REQUIRED_TOOLS,
                           required_features: tuple[str, ...] = BASE_REQUIRED_FEATURES) -> None:
        names = {t.get("name") for t in self._get("/v1/tools").get("tools", [])}
        missing = [t for t in required if t not in names]
        if missing:
            raise MaloError(f"运行中的 malo daemon 缺工具 {missing}（版本过旧），"
                            f"需升级 {MALO_REPO} 并重启 daemon")
        lacking = [f for f in required_features if f not in self.features]
        if lacking:
            raise MaloError(f"运行中的 malo daemon 缺能力 {lacking}（版本过旧），"
                            f"需升级 {MALO_REPO} 并重启 daemon")

    def heartbeat(self) -> None:
        # 心跳/释放都是 broker 路由（lease 端口只挂 session 工具）
        be, bt = self._broker
        _http("POST", f"{be}/v1/leases/{self.lease_id}/heartbeat",
              None, {"x-malo-broker-token": bt})

    def release(self) -> None:
        # 释放是 broker 路由（lease 端口没有 DELETE /v1/leases/:id）
        be, bt = self._broker
        try:
            _http("DELETE", f"{be}/v1/leases/{self.lease_id}",
                  None, {"x-malo-broker-token": bt})
        except MaloError as e:  # 收尾清理性失败不掩盖主流程结果
            print(f"[malo] ⚠️ 租约释放失败（不影响本次产出）：{e}")

    def new_session(self, name: str, profile: str | None = None,
                    width: int = 1440, height: int = 900) -> "MaloSession":
        body = {"name": name, "width": width, "height": height}
        if profile:
            body["profile"] = profile
        r = self._post("/v1/sessions", body)
        return MaloSession(self, r["session_id"], r["session_token"])

    def _get(self, path: str) -> dict:
        return _http("GET", f"{self.endpoint}{path}", None, self._headers)

    def _post(self, path: str, payload: dict) -> dict:
        return _http("POST", f"{self.endpoint}{path}", payload, self._headers)


class MaloSession:
    """一个浏览 session（同名 profile 跨 session 复用 cookies/登录态）。"""

    def __init__(self, lease: MaloLease, session_id: str, session_token: str):
        self.lease = lease
        self.id = session_id
        self._headers = {**lease._headers, "x-malo-session-token": session_token}

    def call(self, tool: str, payload: dict | None = None,
             timeout: float = 120) -> dict:
        """调 session 工具 → result 字段；HTTP 层失败抛 MaloError。

        注意：业务失败（如 assert 不成立）是 HTTP 200 + result.ok=false，
        由调用方读语义，本层不吞不判。
        """
        r = _http("POST", f"{self.lease.endpoint}/v1/sessions/{self.id}/tools/{tool}",
                  payload or {}, self._headers, timeout=timeout)
        return r.get("result", r)

    def close(self) -> None:
        try:
            self.call("close")
        except MaloError as e:
            print(f"[malo] ⚠️ session 关闭失败（登录态已在 profile，不影响）：{e}")

    def __enter__(self) -> "MaloSession":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
