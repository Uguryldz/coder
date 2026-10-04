/**
 * Bu dosya bir dönem `apps/demo/src/http.ts` ile BİREBİR aynı 85 satırdı;
 * gövde `@maestro/http-kit`e taşındı. Burada yalnız pilota ait olan tek şey
 * kalıyor: hangi ortam değişkeninin sunucuyu ağa açtığı.
 */
export {
  CORS_HEADERS,
  LOOPBACK_HOST,
  close,
  headerValue,
  parseJsonObject,
  readRawBody,
  requestUrl,
  sendJson,
  sendText,
} from "@maestro/http-kit";

import type { Server } from "node:http";
import { LOOPBACK_HOST, hostFromEnv, listen as listenOn } from "@maestro/http-kit";

/**
 * Bağlanma adresi. Varsayılan geri döngü — pilotun kimlik doğrulaması yok ve
 * gerçek model kotası harcıyor. `MAESTRO_PILOT_HOST=0.0.0.0` bunu bilerek açar.
 *
 * `MAESTRO_DEMO_HOST` de HÂLÂ okunuyor, ikinci sırada: kopyalama döneminde
 * pilot da o adı okuyordu, ve pilotu ağa açmış bir kurulum bu birleştirme
 * yüzünden sessizce geri döngüye kapanmamalı. Yeni ad önce gelir.
 */
export function bindHost(): string {
  const own = hostFromEnv("MAESTRO_PILOT_HOST");
  return own === LOOPBACK_HOST ? hostFromEnv("MAESTRO_DEMO_HOST") : own;
}

export function listen(server: Server, port: number): Promise<number> {
  return listenOn(server, port, bindHost());
}
