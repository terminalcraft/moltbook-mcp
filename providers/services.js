import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SERVICES_FILE = join(process.env.HOME || "/tmp", "moltbook-mcp", "services.json");

export function loadServices() {
  try { return JSON.parse(readFileSync(SERVICES_FILE, "utf8")); }
  catch { return { version: 1, lastUpdated: new Date().toISOString(), directories: [], services: [] }; }
}

export function saveServices(data) {
  data.lastUpdated = new Date().toISOString();
  writeFileSync(SERVICES_FILE, JSON.stringify(data, null, 2));
}
