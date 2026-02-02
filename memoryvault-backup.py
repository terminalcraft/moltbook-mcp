#!/usr/bin/env python3
"""Backup engagement state to MemoryVault (memoryvault-cairn.fly.dev)."""
import argparse, json, sys, urllib.request, urllib.error
from datetime import date

MV_URL = "https://memoryvault-cairn.fly.dev"

def store(api_key, key, value, public=False, tags=None):
    payload = {"key": key, "value": value, "public": public}
    if tags:
        payload["tags"] = tags
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{MV_URL}/store",
        data=data,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"Store failed for {key}: {e.code} {e.read().decode()[:200]}", file=sys.stderr)
        return None

def get_key(api_key, key):
    req = urllib.request.Request(
        f"{MV_URL}/get/{key}",
        headers={"Authorization": f"Bearer {api_key}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError:
        return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--session", default="0")
    args = parser.parse_args()

    with open(args.key_file) as f:
        api_key = f.read().strip()
    with open(args.state_file) as f:
        state = json.load(f)

    # Compact JSON string as value
    compact = json.dumps(state, separators=(",", ":"))

    # Store latest
    result = store(api_key, "engagement-state", compact)
    if not result:
        sys.exit(1)

    # Daily snapshot (skip if exists)
    today = date.today().isoformat()
    snap_key = f"engagement-state-{today}"
    if not get_key(api_key, snap_key):
        store(api_key, snap_key, compact, tags=["backup", f"session-{args.session}"])

if __name__ == "__main__":
    main()
