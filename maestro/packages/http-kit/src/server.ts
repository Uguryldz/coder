import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * DÜZ NODE HTTP SUNUCUSU YARDIMCILARI — TEK KAYNAK.
 *
 * `apps/demo/src/http.ts` ile `apps/pilot/src/http.ts` bir dönem birebir aynı
 * 85 satırdı; ölçüldü, tek karakter farkı yoktu. İkisi de gerçek bir HTTP
 * sunucusu ayağa kaldırıyor (sahte Jira/ADO uçları, prova arayüzü) ve ikisi de
 * webhook imzası doğruladığı için HAM gövdeyi okumak zorunda.
 *
 * Kopyanın maliyeti burada da "iki dosya" değil, POLİTİKANIN İKİYE BÖLÜNMESİ
 * idi: `readRawBody` imza doğrulamasının dayandığı baytları üretiyor ve
 * `listen` sunucunun ağa açılıp açılmayacağına karar veriyor. İkisi de
 * güvenlik davranışı; bir tarafta düzeltilip ötekinde unutulabilecek türden.
 *
 * Paketin çalışma zamanı bağımlılığı yok: yalnız Node'un kendi `http`/`net`
 * tipleri. `@maestro/ports`a konmadı çünkü orası saf arayüz katmanı ve Node'a
 * bağlanmamalı; M44 clean-room DI bu ayrımla korunuyor.
 */

/** Reads the RAW request body — webhook signatures are computed over these bytes. */
export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(text);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

/** Permissive CORS for the demo-only routes the browser talks to directly. */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** Case-insensitive single header value. */
export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** `new URL` needs an origin; requests only ever carry a path here. */
export function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

/**
 * Varsayılan bağlanma adresi: geri döngü.
 *
 * Bu uygulamaların kimlik doğrulaması yok ve gerçek model kotası harcıyorlar,
 * yani ağdan erişilebilir olmamaları GEREKİR. Ağa açmak bilinçli bir karardır
 * (başka bir makineden izlemek, ters vekil arkasına koymak) ve `listen`in
 * `host` argümanıyla açıkça istenir.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Bağlanma adresini bir ortam değişkeninden okur, ayarsızsa geri döngüde
 * kalır. Değişken adı çağırana ait: prova ortamı ile pilot ortamı aynı adı
 * paylaşmak zorunda değil — bir dönem paylaşıyorlardı, ve bu bir kopyalama
 * kazasıydı: pilot da `MAESTRO_DEMO_HOST` okuyordu, yani pilotu ağa açmak
 * isteyen operatör "demo" adlı bir değişkeni ayarlamak zorundaydı.
 *
 * BOŞ DİZE AYARSIZ SAYILIR. compose dosyaları değişkenleri `${VAR:-}` ile
 * geçiriyor, yani ayarlanmamış bir değişken buraya `""` olarak ulaşır; `??`
 * bunu yakalamaz ve sunucu `""` adresine bağlanmaya çalışır (ki bu Node'da
 * TÜM arayüzler demektir — tam da kaçınılan şey).
 */
export function hostFromEnv(
  variable: string,
  source: Record<string, string | undefined> = process.env,
): string {
  const configured = source[variable]?.trim() ?? "";
  return configured === "" ? LOOPBACK_HOST : configured;
}

export function listen(server: Server, port: number, host: string = LOOPBACK_HOST): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo | null;
      resolve(address?.port ?? port);
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** JSON body or `null` when the payload is not an object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
