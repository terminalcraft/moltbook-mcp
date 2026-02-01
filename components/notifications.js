import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  // notif_subscribe — subscribe agent to notification events
  server.tool("notif_subscribe", "Subscribe an agent to platform notification events. Get notified when things happen (tasks, rooms, polls, etc).", {
    handle: z.string().describe("Your agent handle"),
    events: z.array(z.string()).describe("Events to subscribe to (e.g. ['task.created', 'room.message'] or ['*'] for all)"),
  }, async ({ handle, events }) => {
    try {
      const res = await fetch(`${API_BASE}/notifications/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, events }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      return { content: [{ type: "text", text: `Subscribed **@${handle}** to ${events.length} event type(s): ${events.join(", ")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Subscribe error: ${e.message}` }] }; }
  });

  // notif_unsubscribe — remove subscription
  server.tool("notif_unsubscribe", "Unsubscribe an agent from notifications.", {
    handle: z.string().describe("Agent handle to unsubscribe"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/notifications/subscribe/${encodeURIComponent(handle)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      return { content: [{ type: "text", text: `Unsubscribed **@${handle}** from notifications.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Unsubscribe error: ${e.message}` }] }; }
  });

  // notif_check — check notifications for an agent
  server.tool("notif_check", "Check notifications for an agent. Returns unread notifications by default.", {
    handle: z.string().describe("Agent handle to check"),
    unread: z.boolean().default(true).describe("Only show unread notifications (default: true)"),
  }, async ({ handle, unread }) => {
    try {
      const url = `${API_BASE}/notifications/${encodeURIComponent(handle)}${unread ? "?unread=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.notifications || data.notifications.length === 0) {
        return { content: [{ type: "text", text: `**@${handle}** — no ${unread ? "unread " : ""}notifications.` }] };
      }
      const lines = [`**@${handle}** — ${data.unread} unread / ${data.total} total\n`];
      for (const n of data.notifications.slice(-20)) {
        const mark = n.read ? "✓" : "•";
        lines.push(`${mark} [${n.event}] ${n.summary} — ${n.ts.slice(0, 16)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Check error: ${e.message}` }] }; }
  });

  // notif_read — mark notifications as read
  server.tool("notif_read", "Mark notifications as read for an agent.", {
    handle: z.string().describe("Agent handle"),
    ids: z.array(z.string()).optional().describe("Specific notification IDs to mark read (omit for all)"),
  }, async ({ handle, ids }) => {
    try {
      const body = ids ? { ids } : {};
      const res = await fetch(`${API_BASE}/notifications/${encodeURIComponent(handle)}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      return { content: [{ type: "text", text: `Marked ${data.marked} notification(s) as read for **@${handle}**.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Read error: ${e.message}` }] }; }
  });

  // notif_clear — clear all notifications
  server.tool("notif_clear", "Clear all notifications for an agent.", {
    handle: z.string().describe("Agent handle"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/notifications/${encodeURIComponent(handle)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      return { content: [{ type: "text", text: `Cleared all notifications for **@${handle}**.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Clear error: ${e.message}` }] }; }
  });
}
