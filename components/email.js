import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";

const CREDS_PATH = "/home/moltbot/.agentmail-creds.json";

// AgentMail API configuration
const API_BASE = "https://api.agentmail.to/v0";

/**
 * Load AgentMail credentials.
 * Returns { api_key, inbox_id, email_address } or null if not configured.
 */
function loadCreds() {
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Save credentials to disk.
 */
function saveCreds(creds) {
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
}

/**
 * Make an authenticated request to AgentMail API.
 */
async function apiRequest(endpoint, opts = {}) {
  const creds = loadCreds();
  if (!creds?.api_key) {
    throw new Error("AgentMail not configured. Run email_setup first.");
  }

  const { method = "GET", body = null, timeout = 15000 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const headers = {
      "Authorization": `Bearer ${creds.api_key}`,
      "Content-Type": "application/json",
    };

    const fetchOpts = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body) {
      fetchOpts.body = JSON.stringify(body);
    }

    const resp = await fetch(`${API_BASE}${endpoint}`, fetchOpts);
    clearTimeout(timer);

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }

    return data;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      throw new Error("Request timeout");
    }
    throw e;
  }
}

export function register(server) {
  /**
   * Check email configuration status.
   */
  server.tool(
    "email_status",
    "Check AgentMail configuration status — shows if API key is configured and inbox details.",
    {},
    async () => {
      const creds = loadCreds();
      if (!creds?.api_key) {
        return {
          content: [{
            type: "text",
            text: "❌ AgentMail not configured.\n\nTo set up:\n1. Create account at https://console.agentmail.to\n2. Create API key\n3. Run email_setup with the API key"
          }]
        };
      }

      const lines = [
        "**AgentMail Status**",
        `API Key: configured (${creds.api_key.slice(0, 8)}...)`,
      ];

      if (creds.inbox_id) {
        lines.push(`Inbox ID: ${creds.inbox_id}`);
        lines.push(`Email: ${creds.email_address || "unknown"}`);
      } else {
        lines.push("Inbox: not created yet — run email_create_inbox");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  /**
   * Configure AgentMail API key.
   */
  server.tool(
    "email_setup",
    "Configure AgentMail API key. Get key from https://console.agentmail.to",
    { api_key: z.string().describe("AgentMail API key") },
    async ({ api_key }) => {
      // Validate key by listing inboxes
      const creds = { api_key };
      saveCreds(creds);

      try {
        const resp = await apiRequest("/inboxes");
        const inboxes = resp.inboxes || [];

        if (inboxes.length > 0) {
          // Use existing inbox
          const inbox = inboxes[0];
          creds.inbox_id = inbox.id;
          creds.email_address = inbox.email || `${inbox.username}@agentmail.to`;
          saveCreds(creds);
          return {
            content: [{
              type: "text",
              text: `✅ API key validated. Found existing inbox:\n- ID: ${inbox.id}\n- Email: ${creds.email_address}\n\nReady to check emails with email_list`
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: `✅ API key validated. No inboxes found — run email_create_inbox to create one.`
          }]
        };
      } catch (e) {
        // Remove invalid key
        saveCreds({});
        return {
          content: [{
            type: "text",
            text: `❌ API key validation failed: ${e.message}`
          }]
        };
      }
    }
  );

  /**
   * Create a new inbox.
   */
  server.tool(
    "email_create_inbox",
    "Create a new AgentMail inbox. Optionally specify username (defaults to 'moltbook').",
    { username: z.string().optional().describe("Inbox username (without @agentmail.to)") },
    async ({ username = "moltbook" }) => {
      try {
        const resp = await apiRequest("/inboxes", {
          method: "POST",
          body: { username },
        });

        const creds = loadCreds();
        creds.inbox_id = resp.id;
        creds.email_address = resp.email || `${username}@agentmail.to`;
        saveCreds(creds);

        return {
          content: [{
            type: "text",
            text: `✅ Inbox created!\n- ID: ${resp.id}\n- Email: ${creds.email_address}\n\nReady to receive emails.`
          }]
        };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to create inbox: ${e.message}`
          }]
        };
      }
    }
  );

  /**
   * List recent emails.
   */
  server.tool(
    "email_list",
    "List recent emails in the inbox. Returns subject, sender, date, and ID for each message.",
    { limit: z.number().optional().describe("Max messages to return (default 10, max 50)") },
    async ({ limit = 10 }) => {
      const creds = loadCreds();
      if (!creds?.inbox_id) {
        return {
          content: [{
            type: "text",
            text: "❌ No inbox configured. Run email_setup and email_create_inbox first."
          }]
        };
      }

      try {
        const resp = await apiRequest(`/inboxes/${creds.inbox_id}/messages?limit=${Math.min(limit, 50)}`);
        const messages = resp.messages || resp.data || [];

        if (messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `📭 No emails in inbox (${creds.email_address})`
            }]
          };
        }

        const lines = [`📬 ${messages.length} email(s) in ${creds.email_address}:`, ""];

        for (const msg of messages) {
          const date = msg.created_at ? new Date(msg.created_at).toISOString().split("T")[0] : "unknown";
          const from = msg.from?.email || msg.from || "unknown";
          lines.push(`**${msg.subject || "(no subject)"}**`);
          lines.push(`  From: ${from}`);
          lines.push(`  Date: ${date}`);
          lines.push(`  ID: ${msg.id}`);
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to list emails: ${e.message}`
          }]
        };
      }
    }
  );

  /**
   * Read a specific email.
   */
  server.tool(
    "email_read",
    "Read the full content of a specific email by ID.",
    { message_id: z.string().describe("Message ID from email_list") },
    async ({ message_id }) => {
      const creds = loadCreds();
      if (!creds?.inbox_id) {
        return {
          content: [{
            type: "text",
            text: "❌ No inbox configured."
          }]
        };
      }

      try {
        const msg = await apiRequest(`/inboxes/${creds.inbox_id}/messages/${message_id}`);

        const lines = [
          `**Subject:** ${msg.subject || "(no subject)"}`,
          `**From:** ${msg.from?.email || msg.from || "unknown"}`,
          `**To:** ${msg.to?.[0]?.email || creds.email_address}`,
          `**Date:** ${msg.created_at || "unknown"}`,
          "",
          "---",
          "",
          msg.text || msg.body || "(no body)",
        ];

        if (msg.attachments?.length > 0) {
          lines.push("");
          lines.push(`**Attachments (${msg.attachments.length}):**`);
          for (const att of msg.attachments) {
            lines.push(`  - ${att.filename || att.name} (${att.content_type || "unknown type"})`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to read email: ${e.message}`
          }]
        };
      }
    }
  );

  /**
   * Send an email.
   */
  server.tool(
    "email_send",
    "Send an email from the configured inbox.",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      text: z.string().describe("Email body (plain text)"),
    },
    async ({ to, subject, text }) => {
      const creds = loadCreds();
      if (!creds?.inbox_id) {
        return {
          content: [{
            type: "text",
            text: "❌ No inbox configured."
          }]
        };
      }

      try {
        const resp = await apiRequest(`/inboxes/${creds.inbox_id}/messages/send`, {
          method: "POST",
          body: { to, subject, text },
        });

        return {
          content: [{
            type: "text",
            text: `✅ Email sent!\n- To: ${to}\n- Subject: ${subject}\n- Message ID: ${resp.id || "unknown"}`
          }]
        };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to send email: ${e.message}`
          }]
        };
      }
    }
  );

  /**
   * Reply to an email.
   */
  server.tool(
    "email_reply",
    "Reply to an existing email thread.",
    {
      message_id: z.string().describe("Original message ID to reply to"),
      text: z.string().describe("Reply body (plain text)"),
    },
    async ({ message_id, text }) => {
      const creds = loadCreds();
      if (!creds?.inbox_id) {
        return {
          content: [{
            type: "text",
            text: "❌ No inbox configured."
          }]
        };
      }

      try {
        const resp = await apiRequest(`/inboxes/${creds.inbox_id}/messages/reply`, {
          method: "POST",
          body: { message_id, text },
        });

        return {
          content: [{
            type: "text",
            text: `✅ Reply sent!\n- In reply to: ${message_id}\n- Message ID: ${resp.id || "unknown"}`
          }]
        };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to send reply: ${e.message}`
          }]
        };
      }
    }
  );
}
