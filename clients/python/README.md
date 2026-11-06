# Python client

`malo_client.py` — zero-dependency (stdlib only) transport client for the malo
daemon: on-demand daemon spawn, lease acquire/heartbeat/release, profile-backed
sessions, tool calls, capability checks, and the profile login import
(`import_profile_login`). Drop the file into any project, or add this directory
to `sys.path`:

```python
from malo_client import acquire_lease, import_profile_login

lease = acquire_lease("my-agent")
import_profile_login(lease, "work", "http://127.0.0.1:9223", domains=["example.com"])
with lease.new_session("work", profile="work") as s:
    s.call("navigate", {"url": "https://example.com"})
    print(s.call("snapshot", {"max_chars": 4000}))
lease.release()
```
