/**
 * Bu dosya bir dönem `apps/pilot/src/http.ts` ile BİREBİR aynı 85 satırdı;
 * gövde `@maestro/http-kit`e taşındı. Burada yalnız demo'ya ait olan tek şey
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
import { hostFromEnv, listen as listenOn } from "@maestro/http-kit";

/**
 * Bağlanma adresi. Varsayılan geri döngü — demo'nun kimlik doğrulaması yok ve
 * gerçek model kotası harcıyor, bu yüzden biri açıkça istemedikçe ağdan
 * erişilebilir olmamalı. `MAESTRO_DEMO_HOST=0.0.0.0` bunu bilerek açar.
 */
export function bindHost(): string {
  return hostFromEnv("MAESTRO_DEMO_HOST");
}

export function listen(server: Server, port: number): Promise<number> {
  return listenOn(server, port, bindHost());
}
