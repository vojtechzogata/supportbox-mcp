#!/usr/bin/env node
/**
 * SupportBox MCP Server — HTTP version for cloud deployment (Railway)
 *
 * Environment variables:
 *   SUPPORTBOX_TOKEN   — Supportbox Bearer token (required)
 *   MCP_AUTH_TOKEN     — Token to secure this MCP server (recommended)
 *   PORT               — Port to listen on (Railway sets this automatically)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { randomUUID } from "crypto";

const SUPPORTBOX_API = "https://app.supportbox.cz/api/rest/v2";
const PORT = process.env.PORT || 3000;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function getToken() {
  const token = process.env.SUPPORTBOX_TOKEN;
  if (!token) throw new Error("SUPPORTBOX_TOKEN environment variable is not set");
  return token;
}

function sbHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const url = `${SUPPORTBOX_API}${path}`;
  const res = await fetch(url, { ...options, headers: sbHeaders(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SupportBox API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── MCP Server factory ───────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({ name: "supportbox", version: "1.1.0" });

  // Tool: list_mailboxes
  server.tool(
    "list_mailboxes",
    "List all available SupportBox mailboxes with their IDs, names and email addresses.",
    {},
    async () => {
      const data = await apiFetch("/mailboxes");
      const items = data.items ?? data;
      const text = items.map(mb =>
        `ID: ${mb.id}  |  Name: ${mb.name ?? ""}  |  Email: ${mb.email ?? ""}`
      ).join("\n");
      return { content: [{ type: "text", text: text || "No mailboxes found." }] };
    }
  );

  // Tool: list_messages
  server.tool(
    "list_messages",
    "List recent tickets/messages in a SupportBox mailbox. Returns ticket ID, status, sender and subject.",
    {
      mailbox_id: z.number().int().describe("SupportBox mailbox ID"),
      limit: z.number().int().min(1).max(50).default(20).describe("Number of tickets to return (default 20, max 50)"),
      status: z.enum(["new", "pending", "resolved", "spam"]).optional().describe("Filter by ticket status"),
    },
    async ({ mailbox_id, limit, status }) => {
      let path = `/mail-tickets?filter[mailbox_id][eq]=${mailbox_id}&per_page=${limit}`;
      if (status) path += `&filter[status][eq]=${status}`;

      const data = await apiFetch(path);
      const items = data.items ?? data ?? [];
      if (!items.length) {
        return { content: [{ type: "text", text: "No tickets found." }] };
      }
      const text = items.map(ticket => {
        const from = ticket.sender_email ?? ticket.from?.email ?? "";
        const subject = ticket.subject ?? "(no subject)";
        const ticketStatus = ticket.status ?? "";
        const lastMsg = ticket.last_message_at ?? ticket.created_at ?? "";
        return `Ticket #${ticket.id}  |  ${ticketStatus}  |  From: ${from}  |  Subject: ${subject}  |  Last: ${lastMsg}`;
      }).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // Tool: get_ticket
  server.tool(
    "get_ticket",
    "Get details of a specific SupportBox ticket including all messages in the thread.",
    {
      ticket_id: z.number().int().describe("SupportBox ticket ID"),
    },
    async ({ ticket_id }) => {
      const [ticketData, messagesData] = await Promise.all([
        apiFetch(`/mail-tickets?filter[id][eq]=${ticket_id}`),
        apiFetch(`/mail-tickets/${ticket_id}/messages`),
      ]);

      const ticket = (ticketData.items ?? ticketData ?? [])[0] ?? {};
      const messages = messagesData.items ?? messagesData ?? [];

      const lines = [
        `Ticket #${ticket.id ?? ticket_id}`,
        `Status: ${ticket.status ?? ""}`,
        `Subject: ${ticket.subject ?? ""}`,
        `Sender: ${ticket.sender_email ?? ""}`,
        `Created: ${ticket.created_at ?? ""}`,
        `Last message: ${ticket.last_message_at ?? ""}`,
        "",
        "--- Messages ---",
        ...messages.map((m, i) => {
          const from = m.from?.email ?? m.sender_email ?? "unknown";
          const type = m.type ?? "";
          const date = m.created_at ?? "";
          const text = (m.text ?? m.body ?? "").trim();
          return `[${i + 1}] ID: ${m.id}  |  ${date}  |  Type: ${type}  |  From: ${from}\n${text}\n`;
        }),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // Tool: send_email
  server.tool(
    "send_email",
    "Send an outgoing email via SupportBox. Use ticket_id to reply to an existing ticket, or mailbox_id + to + subject to create a new ticket.",
    {
      mailbox_id: z.number().int().optional().describe("SupportBox mailbox ID (required for new tickets)"),
      ticket_id: z.number().int().optional().describe("Ticket ID to reply to (for replies)"),
      source_message_id: z.number().int().optional().describe("ID of the message being replied to (auto-fetched if omitted)"),
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
    },
    async ({ mailbox_id, ticket_id, source_message_id, to, subject, body }) => {
      let result;
      if (ticket_id) {
        let msgId = source_message_id;
        if (!msgId) {
          const msgData = await apiFetch(`/mail-tickets/${ticket_id}/messages?per_page=50`);
          const msgs = msgData.items ?? msgData ?? [];
          msgId = msgs[msgs.length - 1]?.id ?? msgs[0]?.id;
          if (!msgId) throw new Error("Could not find message ID for this ticket");
        }
        result = await apiFetch(`/mail-tickets/${ticket_id}/messages`, {
          method: "POST",
          body: JSON.stringify({ type: "out_reply", to, subject, text: body, source_message_id: msgId }),
        });
      } else {
        if (!mailbox_id) throw new Error("mailbox_id is required when creating a new ticket");
        result = await apiFetch(`/mailboxes/${mailbox_id}/messages`, {
          method: "POST",
          body: JSON.stringify({ type: "out_new", to, subject, text: body }),
        });
      }
      const ticketId = result?.ticket?.id ?? result?.id ?? "unknown";
      return { content: [{ type: "text", text: `Email sent successfully. Ticket ID: ${ticketId}` }] };
    }
  );

  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Auth middleware for /mcp endpoint
app.use("/mcp", (req, res, next) => {
  if (MCP_AUTH_TOKEN) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${MCP_AUTH_TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", service: "supportbox-mcp" }));

// Session storage
const sessions = new Map();

// MCP endpoint — POST (new requests)
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] ?? randomUUID();
    let transport = sessions.get(sessionId);

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
      sessions.set(sessionId, transport);
      const server = createMcpServer();
      await server.connect(transport);
      transport.onclose = () => sessions.delete(sessionId);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// MCP endpoint — GET (SSE stream for server-sent events)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessions.get(sessionId);
  if (!transport) return res.status(404).send("Session not found");
  await transport.handleRequest(req, res);
});

// MCP endpoint — DELETE (close session)
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessions.get(sessionId);
  if (transport) {
    await transport.close();
    sessions.delete(sessionId);
  }
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Supportbox MCP HTTP server running on port ${PORT}`);
});
