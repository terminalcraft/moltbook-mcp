#!/usr/bin/env python3
"""Extract a structured summary from a stream-json session log."""
import json, sys, re
from datetime import datetime

log_file = sys.argv[1]
texts = []
tools = []
timestamps = []
upvotes = 0
comments_posted = 0
posts_read = 0
threads_diffed = 0
scan_mode = "?"
session_id = "?"
digest_scanned = 0
digest_signal = 0
commits = []
files_edited = set()
vote_targets = []
comment_targets = []
post_titles = []

with open(log_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        if not line.startswith('{'):
            m = re.search(r'Moltbook heartbeat (\S+)', line)
            if m:
                timestamps.append(m.group(1))
            m = re.search(r'Done (\S+)', line)
            if m:
                timestamps.append(m.group(1))
            continue
        try:
            obj = json.loads(line)
            # Check tool results for session ID and digest stats
            msg_content = obj.get('message', {}).get('content', [])
            if isinstance(msg_content, list):
                for item in msg_content:
                    if item.get('type') == 'tool_result':
                        content = item.get('content', '')
                        texts_to_check = []
                        if isinstance(content, str):
                            texts_to_check.append(content)
                        elif isinstance(content, list):
                            for sub in content:
                                texts_to_check.append(sub.get('text', ''))
                        for txt in texts_to_check:
                            if session_id == "?":
                                sm = re.search(r'session (\d+)', txt)
                                if sm:
                                    session_id = sm.group(1)
                            dm = re.search(r'(\d+) signal posts? from (\d+) scanned', txt)
                            if dm:
                                digest_signal = int(dm.group(1))
                                digest_scanned = int(dm.group(2))
            msg = obj.get('message', {})
            for c in msg.get('content', []):
                if c.get('type') == 'text' and c.get('text', '').strip():
                    texts.append(c['text'])
                elif c.get('type') == 'tool_use':
                    name = c.get('name', '?')
                    inp = c.get('input', {})
                    tools.append(name)

                    if 'moltbook_vote' in name:
                        upvotes += 1
                    elif 'moltbook_comment' in name:
                        comments_posted += 1
                        body = inp.get('content', '')[:60]
                        comment_targets.append(body)
                    elif 'moltbook_post' in name and 'submolt' not in str(inp):
                        posts_read += 1
                    elif 'moltbook_thread_diff' in name:
                        threads_diffed += 1
                    elif 'moltbook_digest' in name:
                        mode = inp.get('mode', 'signal')
                        scan_mode = mode
                    elif name == 'Edit':
                        fp = inp.get('file_path', '')
                        if fp:
                            files_edited.add(fp.split('/')[-1])
                    elif name == 'Write':
                        fp = inp.get('file_path', '')
                        if fp:
                            files_edited.add(fp.split('/')[-1])
                    elif name == 'Bash':
                        cmd = inp.get('command', '')
                        if 'git commit' in cmd:
                            # Try heredoc first, then simple quoted message, then fallback
                            m = re.search(r'cat <<.?EOF.?\n(.+?)(?:\n\n|\nCo-Authored|\nEOF)', cmd, re.DOTALL)
                            if m:
                                commits.append(m.group(1).split('\n')[0].strip())
                            else:
                                m = re.search(r'git commit -m ["\']([^"\'\n]{1,80})', cmd)
                                if m:
                                    commits.append(m.group(1).strip())
                                else:
                                    commits.append('(commit)')
        except (json.JSONDecodeError, KeyError):
            continue

# Duration
duration = "?"
if len(timestamps) >= 2:
    try:
        t0 = datetime.strptime(timestamps[0].split('+')[0], "%Y-%m-%dT%H:%M:%S")
        t1 = datetime.strptime(timestamps[-1].split('+')[0], "%Y-%m-%dT%H:%M:%S")
        secs = int((t1 - t0).total_seconds())
        duration = f"{secs // 60}m{secs % 60:02d}s"
    except:
        pass

# Extract build and feed info from agent text
all_text = '\n'.join(texts)
build_lines = []
feed_lines = []
notes = []
for t in texts:
    for sentence in re.split(r'(?<=[.!])\s+', t):
        s = sentence.strip()
        sl = s.lower()
        if any(kw in sl for kw in ['shipped', 'committed and pushed', 'built:', 'added', 'created']):
            if len(s) > 10 and s not in build_lines:
                build_lines.append(s)
        if any(kw in sl for kw in ['post', 'thread', 'comment from', 'replied', 'engagement']):
            if len(s) > 15 and len(feed_lines) < 5 and s not in feed_lines:
                feed_lines.append(s)

# Write summary
summary_file = log_file.rsplit('.', 1)[0] + '.summary'
with open(summary_file, 'w') as f:
    start = timestamps[0].split('+')[0].split('T')[1] if timestamps else "?"
    f.write(f"Session: {session_id}\n")
    f.write(f"Start: {start} UTC\n")
    f.write(f"Duration: {duration}\n")
    f.write(f"Scan: {scan_mode}\n")
    if digest_scanned:
        f.write(f"Digest: {digest_signal}/{digest_scanned} signal\n")
    f.write(f"Tools: {len(tools)}\n")
    f.write(f"Posts read: {posts_read}\n")
    f.write(f"Threads diffed: {threads_diffed}\n")
    f.write(f"Upvotes: {upvotes}\n")
    f.write(f"Comments: {comments_posted}\n")

    # Build
    if commits:
        f.write(f"Build: {len(commits)} commit(s)\n")
        for c in commits:
            f.write(f"  - {c}\n")
    else:
        f.write("Build: (none)\n")

    # Files
    if files_edited:
        f.write(f"Files changed: {', '.join(sorted(files_edited))}\n")
    else:
        f.write("Files changed: (none)\n")

    # Feed
    if feed_lines:
        f.write("Feed:\n")
        for fl in feed_lines[:5]:
            f.write(f"  - {fl}\n")

    f.write("\n--- Agent thinking ---\n\n")
    f.write('\n\n'.join(texts) + '\n')
