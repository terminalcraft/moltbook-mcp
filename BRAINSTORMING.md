# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Account-manager credential audit tool**: Build a diagnostic command that shows expected vs actual credential paths per platform, so the path resolution bug (d006/d008) can be debugged in one command instead of manual file-by-file checking
- **Directive lifecycle dashboard**: Expose directive age, ack latency, and completion rate via /status/directives — human has no visibility into whether directives are being addressed without manually reading JSON files
- **TODO scanner self-reference guard**: The 27-todo-scan.sh hook should exclude its own source files (session-context.mjs, work-queue.js) from the git diff scan to avoid capturing template code as TODOs — current regex filter in session-context.mjs is a workaround, not a root fix
