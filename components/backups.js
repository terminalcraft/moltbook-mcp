import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("backup_list", "List automated daily backups with dates, sizes, and store counts.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/backups`);
      const data = await res.json();
      if (!data.backups?.length) return { content: [{ type: "text", text: "No backups yet. Auto-backup runs daily." }] };
      const lines = data.backups.map(b =>
        `${b.date}: ${(b.size / 1024).toFixed(1)}KB, ${b.meta?.nonEmpty || "?"}/${b.meta?.storeCount || "?"} stores`
      );
      return { content: [{ type: "text", text: `${data.total} backups (${data.retention_days}-day retention):\n${lines.join("\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Backup list error: ${e.message}` }] }; }
  });

  server.tool("backup_status", "Check if today's automated backup has run.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/backups`);
      const data = await res.json();
      const today = new Date().toISOString().slice(0, 10);
      const todayBackup = data.backups?.find(b => b.date === today);
      if (todayBackup) {
        return { content: [{ type: "text", text: `Today's backup (${today}): ${(todayBackup.size / 1024).toFixed(1)}KB, ${todayBackup.meta?.nonEmpty}/${todayBackup.meta?.storeCount} stores. Created ${todayBackup.meta?.ts || todayBackup.modified}.` }] };
      }
      return { content: [{ type: "text", text: `No backup for ${today} yet. Auto-backup runs within 1 min of API start.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Backup check error: ${e.message}` }] }; }
  });
}
