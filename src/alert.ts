/**
 * Telegram alerts for the three things worth waking someone for: the balance floor
 * being crossed, a gas spike that suppressed a post, and a post that failed.
 *
 * Credentials are read from /opt/liqbot/.env at call time and never printed, never
 * logged, never passed on a command line, and never written anywhere. The only thing
 * that leaves this module is the message text and, on failure, a status code — the
 * token is redacted out of any error string before it can reach a log, because the
 * failing URL contains it.
 *
 * Alerting is best-effort by design: a keeper that dies because Telegram is down is
 * worse than one that posts quietly.
 */
import { readFileSync } from "node:fs";
import type { AlertKind } from "./policy.js";

const ENV_PATH = process.env["STATERA_TG_ENV"] ?? "/opt/liqbot/.env";

interface Creds {
  token: string;
  chat: string;
}

/** Reads TG_BOT_TOKEN and TG_ALERT_CHAT. Returns null when either is absent. */
export function readCreds(path = ENV_PATH): Creds | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const get = (k: string): string => {
    for (const line of raw.split("\n")) {
      if (line.startsWith(`${k}=`)) return line.slice(k.length + 1).trim();
    }
    return "";
  };
  const token = get("TG_BOT_TOKEN");
  const chat = get("TG_ALERT_CHAT");
  if (!token || !chat) return null;
  return { token, chat };
}

/** Strip anything token-shaped out of text that may end up in a log. */
export function redact(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join("[redacted]");
  // Telegram bot tokens look like 1234567890:AA... — redact the shape too, in case
  // the token reached the string by a route we did not anticipate.
  //
  // NO \b BEFORE THE DIGITS. The string this exists to protect is the failing URL,
  // https://api.telegram.org/bot<TOKEN>/sendMessage, where the token is glued to
  // "bot" — "t" and "1" are both word characters, so there is no boundary there and
  // an anchored pattern matches nothing at all. A test asserts that exact string.
  // The digit run is unbounded for the same class of reason: capping it at 12 made a
  // 13-digit bot id match nothing rather than match loosely.
  return out.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[redacted]");
}

export interface AlertResult {
  sent: boolean;
  /** Why it was not sent, already redacted. Never contains credentials. */
  detail: string;
}

export async function sendAlert(kind: AlertKind, message: string, timeoutMs = 10_000): Promise<AlertResult> {
  const creds = readCreds();
  if (!creds) return { sent: false, detail: `no TG_BOT_TOKEN/TG_ALERT_CHAT in ${ENV_PATH}` };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      chat_id: creds.chat,
      text: `statera ${kind}: ${message}`,
      disable_web_page_preview: "true",
    });
    const r = await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: ac.signal,
    });
    if (!r.ok) return { sent: false, detail: `telegram HTTP ${r.status}` };
    return { sent: true, detail: "" };
  } catch (e) {
    return { sent: false, detail: redact(e instanceof Error ? e.message : String(e), creds.token) };
  } finally {
    clearTimeout(t);
  }
}
