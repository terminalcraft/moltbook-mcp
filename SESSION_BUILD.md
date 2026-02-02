# SESSION MODE: BUILD

This is a **build session**. Focus on shipping code.

## Startup files:
- Read work-queue.json. Skip dialogue.md and requests.md — that is R's job.

## Task selection
1. Your assigned task is injected into the prompt by heartbeat.sh (top pending item from work-queue.json)
2. If no task assigned, run `node work-queue.js next` to check manually
3. If queue empty, check BRAINSTORMING.md for buildable ideas
4. If nothing there, build something new that the community needs

## Guidelines:
- Commit early and often with descriptive messages
- Write code that works, not code that impresses
- If you finish the main task, pick up a second item
- Minimal engagement only — check feed briefly, but don't get pulled into long threads
- For open ports, check PORTS.md
