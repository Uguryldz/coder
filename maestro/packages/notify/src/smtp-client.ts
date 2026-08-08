import { SMTP_DRIVER, type SmtpDriverConfig } from "./config.js";
import type { SocketLike } from "./deps.js";
import { NotifyPermanentError, NotifyTransientError, redact, safeMessage } from "./errors.js";
import { parseCapabilities, type SmtpReply, SmtpReplyReader } from "./smtp-protocol.js";

/**
 * Minimal SMTP submission client: EHLO → STARTTLS → AUTH → MAIL → RCPT → DATA.
 *
 * Written by hand rather than pulled from npm (see RAPOR): the flow is ~150
 * lines of a stable 1982 protocol, whereas nodemailer would add a large
 * transitive surface to a bank's build for one code path — and, decisively,
 * its socket is not injectable, so every test here would need a live server.
 *
 * Fail-closed by construction:
 *  - `security: "starttls"` REQUIRES the upgrade; a server that does not
 *    advertise STARTTLS is an error, never a silent cleartext fallback;
 *  - credentials are never sent over an unencrypted channel;
 *  - a rejected recipient aborts the whole message instead of delivering to
 *    "most" approvers.
 */
export const SMTP_OK = 250;

export interface SmtpEnvelope {
  from: string;
  to: readonly string[];
  /** Ready-made DATA payload (headers + body), CRLF-terminated lines. */
  data: string;
}

export class SmtpSession {
  private readonly reader: SmtpReplyReader;
  private readonly encoder = new TextEncoder();
  private tlsActive: boolean;

  constructor(
    private readonly socket: SocketLike,
    private readonly config: SmtpDriverConfig,
    private readonly password: string | undefined,
  ) {
    this.reader = new SmtpReplyReader(() => socket.read());
    this.tlsActive = config.security === "implicit";
  }

  /** Runs the whole submission. Throws transient/permanent; never partial. */
  async send(envelope: SmtpEnvelope): Promise<void> {
    await this.expect(await this.read(), [220], "greeting");
    let caps = await this.ehlo();

    if (this.config.security === "starttls") {
      if (!caps.has("STARTTLS")) {
        throw new NotifyPermanentError(SMTP_DRIVER, "server does not advertise STARTTLS — refusing to send in cleartext");
      }
      await this.command("STARTTLS", [220], "STARTTLS");
      if (this.reader.hasBufferedBytes) {
        // Bytes sent before the handshake cannot be trusted after it
        // (a classic STARTTLS command-injection).
        throw new NotifyPermanentError(SMTP_DRIVER, "server sent data before the TLS handshake");
      }
      await this.socket.startTls();
      this.tlsActive = true;
      caps = await this.ehlo(); // capabilities are re-negotiated after upgrade
    }

    await this.authenticate(caps);
    await this.command(`MAIL FROM:<${envelope.from}>`, [SMTP_OK], "MAIL FROM");
    for (const recipient of envelope.to) {
      await this.command(`RCPT TO:<${recipient}>`, [SMTP_OK, 251], `RCPT TO <${recipient}>`);
    }
    await this.command("DATA", [354], "DATA");
    await this.write(`${envelope.data}\r\n.\r\n`);
    await this.expect(await this.read(), [SMTP_OK], "message body");
  }

  /** Best-effort close: QUIT is courtesy, the socket close is what matters. */
  async close(): Promise<void> {
    try {
      await this.write("QUIT\r\n");
      await this.read();
    } catch {
      /* the server may drop the connection first — nothing to salvage */
    } finally {
      await this.socket.close();
    }
  }

  private async ehlo(): Promise<Map<string, string[]>> {
    const reply = await this.command(`EHLO ${this.config.ehloName}`, [SMTP_OK], "EHLO");
    return parseCapabilities(reply.lines);
  }

  private async authenticate(caps: Map<string, string[]>): Promise<void> {
    if (this.config.username === undefined || this.password === undefined) return;
    if (!this.tlsActive && !this.config.allowInsecureAuth) {
      throw new NotifyPermanentError(SMTP_DRIVER, "refusing to send credentials over an unencrypted connection");
    }
    const mechanisms = caps.get("AUTH") ?? [];
    if (mechanisms.includes("PLAIN")) {
      const token = b64(`\0${this.config.username}\0${this.password}`);
      await this.command(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN");
      return;
    }
    if (mechanisms.includes("LOGIN")) {
      await this.command("AUTH LOGIN", [334], "AUTH LOGIN");
      await this.command(b64(this.config.username), [334], "AUTH LOGIN (user)");
      await this.command(b64(this.password), [235], "AUTH LOGIN (password)");
      return;
    }
    throw new NotifyPermanentError(
      SMTP_DRIVER,
      `credentials are configured but the server offers no supported AUTH mechanism (${mechanisms.join(",") || "none"})`,
    );
  }

  /**
   * Sends one command line and checks the reply. The command text is NEVER
   * echoed into an error — `AUTH PLAIN <base64>` carries the password — which
   * is why every call passes a human-readable `step` label instead.
   */
  private async command(line: string, accept: number[], step: string): Promise<SmtpReply> {
    await this.write(`${line}\r\n`);
    return this.expect(await this.read(), accept, step);
  }

  private async read(): Promise<SmtpReply> {
    try {
      return await this.reader.nextReply();
    } catch (error) {
      throw new NotifyTransientError(SMTP_DRIVER, safeMessage(error, [this.password]));
    }
  }

  private async write(text: string): Promise<void> {
    try {
      await this.socket.write(this.encoder.encode(text));
    } catch (error) {
      throw new NotifyTransientError(SMTP_DRIVER, safeMessage(error, [this.password]));
    }
  }

  /** 4xx is retryable (greylisting, mailbox busy); 5xx is final. */
  private expect(reply: SmtpReply, accept: number[], step: string): SmtpReply {
    if (accept.includes(reply.code)) return reply;
    const text = redact(reply.lines.join(" "), [this.password]);
    const reason = `${step} rejected with ${reply.code}: ${text}`;
    if (reply.code >= 400 && reply.code < 500) throw new NotifyTransientError(SMTP_DRIVER, reason);
    throw new NotifyPermanentError(SMTP_DRIVER, reason);
  }
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
