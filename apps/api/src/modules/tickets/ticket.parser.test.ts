import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRawTickets, TicketParseError } from "./ticket.parser.js";

describe("parseRawTickets", () => {
  it("defaults status and priority to documented values", () => {
    const [ticket] = parseRawTickets({ title: "Printer offline" });

    assert.ok(ticket);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.priority, "medium");
    assert.equal(ticket.description, "");
  });

  it("normalises valid status and priority values", () => {
    const [ticket] = parseRawTickets({
      title: "DB latency",
      status: " Resolved ",
      priority: "URGENT",
    });

    assert.ok(ticket);
    assert.equal(ticket.status, "resolved");
    assert.equal(ticket.priority, "urgent");
  });

  it("falls back to defaults instead of inventing values", () => {
    const [ticket] = parseRawTickets({
      title: "Odd values",
      status: "finished",
      priority: "catastrophic",
    });

    assert.ok(ticket);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.priority, "medium");
  });

  it("reads aliases for title, description and priority", () => {
    const [ticket] = parseRawTickets({
      subject: "Checkout failing",
      details: "Card payments time out",
      urgency: "high",
    });

    assert.ok(ticket);
    assert.equal(ticket.title, "Checkout failing");
    assert.equal(ticket.description, "Card payments time out");
    assert.equal(ticket.priority, "high");
  });

  it("rejects a ticket without a title", () => {
    assert.throws(
      () => parseRawTickets({ description: "no title" }),
      TicketParseError
    );
  });

  it("parses CSV batches including quoted commas", () => {
    const csv = [
      "title,description,priority",
      '"Disk full, prod",node 3,urgent',
      "API errors,spike,high",
    ].join("\n");

    const tickets = parseRawTickets(csv);

    assert.equal(tickets.length, 2);
    assert.equal(tickets[0]?.title, "Disk full, prod");
    assert.equal(tickets[0]?.priority, "urgent");
    assert.equal(tickets[1]?.title, "API errors");
  });

  it("rejects CSV without data rows and empty batches", () => {
    assert.throws(() => parseRawTickets({ csv: "title,priority" }), TicketParseError);
    assert.throws(() => parseRawTickets([]), TicketParseError);
    assert.throws(() => parseRawTickets({ tickets: [] }), TicketParseError);
  });

  it("treats a single string as a title", () => {
    const [ticket] = parseRawTickets("Nightly backup failed");

    assert.ok(ticket);
    assert.equal(ticket.title, "Nightly backup failed");
    assert.equal(ticket.status, "open");
  });
});
