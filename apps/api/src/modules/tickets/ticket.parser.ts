export type NormalizedTicket = {
  title: string;
  description: string;
  status: string;
  priority: string;
};

export class TicketParseError extends Error {}

const SUPPORTED_STATUSES = new Set([
  "open",
  "pending",
  "in_progress",
  "resolved",
  "closed",
]);

const SUPPORTED_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSafeString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function toSafeStatus(value: unknown): string {
  const status = toSafeString(value).toLowerCase();
  if (!status || !SUPPORTED_STATUSES.has(status)) {
    return "open";
  }

  return status;
}

function toSafePriority(value: unknown): string {
  const priority = toSafeString(value).toLowerCase();
  if (!priority || !SUPPORTED_PRIORITIES.has(priority)) {
    return "medium";
  }

  return priority;
}

function parseTicketObject(raw: Record<string, unknown>): NormalizedTicket {
  const title = toSafeString(
    raw.title ?? raw.subject ?? raw.summary ?? raw.name
  );
  const description = toSafeString(
    raw.description ?? raw.desc ?? raw.details ?? raw.body
  );

  if (!title) {
    throw new TicketParseError("Ticket title is required");
  }

  return {
    title,
    description,
    status: toSafeStatus(raw.status ?? raw.state),
    priority: toSafePriority(raw.priority ?? raw.severity ?? raw.urgency),
  };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseCsvTickets(csv: string): NormalizedTicket[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    throw new TicketParseError("CSV must include header and at least one row");
  }

  const headerLine = lines[0];
  if (!headerLine) {
    throw new TicketParseError("CSV header row is required");
  }

  const headers = parseCsvLine(headerLine).map((header) => header.toLowerCase());
  const tickets: NormalizedTicket[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const rowLine = lines[i];
    if (!rowLine) {
      continue;
    }

    const rowValues = parseCsvLine(rowLine);
    const rawTicket: Record<string, unknown> = {};

    headers.forEach((header, index) => {
      rawTicket[header] = rowValues[index] ?? "";
    });

    tickets.push(parseTicketObject(rawTicket));
  }

  return tickets;
}

function parseSingleTicket(raw: unknown): NormalizedTicket {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new TicketParseError("Ticket payload cannot be empty");
    }

    // Treat multiline/comma-separated strings as CSV input.
    if (value.includes("\n") && value.includes(",")) {
      const csvTickets = parseCsvTickets(value);
      if (csvTickets.length !== 1) {
        throw new TicketParseError(
          "CSV payload contains multiple rows; send it as a batch payload"
        );
      }
      const singleCsvTicket = csvTickets[0];
      if (!singleCsvTicket) {
        throw new TicketParseError("Ticket payload cannot be empty");
      }

      return singleCsvTicket;
    }

    return {
      title: value,
      description: "",
      status: "open",
      priority: "medium",
    };
  }

  if (isRecord(raw)) {
    return parseTicketObject(raw);
  }

  throw new TicketParseError("Ticket payload must be a string or object");
}

export function parseRawTickets(payload: unknown): NormalizedTicket[] {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      throw new TicketParseError("At least one ticket entry is required");
    }
    return payload.map((entry) => parseSingleTicket(entry));
  }

  if (typeof payload === "string") {
    const value = payload.trim();
    if (!value) {
      throw new TicketParseError("Ticket payload cannot be empty");
    }

    if (value.includes("\n") && value.includes(",")) {
      return parseCsvTickets(value);
    }

    return [parseSingleTicket(value)];
  }

  if (isRecord(payload) && Array.isArray(payload.tickets)) {
    if (payload.tickets.length === 0) {
      throw new TicketParseError("At least one ticket entry is required");
    }
    return payload.tickets.map((entry) => parseSingleTicket(entry));
  }

  if (isRecord(payload) && typeof payload.csv === "string") {
    return parseCsvTickets(payload.csv);
  }

  return [parseSingleTicket(payload)];
}
