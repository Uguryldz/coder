import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  LOOPBACK_HOST,
  close,
  hostFromEnv,
  listen,
  parseJsonObject,
  readRawBody,
} from "../src/index.js";

describe("hostFromEnv — boş dize AYARSIZ sayılır", () => {
  /**
   * Bu, bu kod tabanında üç ayrı hataya yol açmış bir tuzak: compose
   * dosyaları değişkenleri `${VAR:-}` ile geçiriyor, yani ayarlanmamış bir
   * değişken sürece `""` olarak ulaşıyor ve `??` onu yakalamıyor. Burada
   * sonucu ağır olurdu: Node'da `""` adresine bağlanmak TÜM arayüzlere
   * bağlanmaktır — kimlik doğrulaması olmayan bir sunucuyu ağa açar.
   */
  it("ayarsız değişken geri döngüde kalır", () => {
    expect(hostFromEnv("MAESTRO_TEST_HOST", {})).toBe(LOOPBACK_HOST);
  });

  it("BOŞ DİZE geri döngüde kalır — tüm arayüzlere açılmaz", () => {
    expect(hostFromEnv("MAESTRO_TEST_HOST", { MAESTRO_TEST_HOST: "" })).toBe(LOOPBACK_HOST);
  });

  it("yalnız boşluktan oluşan değer de geri döngüde kalır", () => {
    expect(hostFromEnv("MAESTRO_TEST_HOST", { MAESTRO_TEST_HOST: "   " })).toBe(LOOPBACK_HOST);
  });

  it("gerçek bir adres verildiğinde ona uyar", () => {
    expect(hostFromEnv("MAESTRO_TEST_HOST", { MAESTRO_TEST_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

describe("listen varsayılan olarak geri döngüye bağlanır", () => {
  it("host verilmezse dışarıdan erişilemez", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    const port = await listen(server, 0);
    try {
      const address = server.address();
      expect(typeof address === "object" && address !== null ? address.address : null).toBe(
        LOOPBACK_HOST,
      );
      const response = await fetch(`http://${LOOPBACK_HOST}:${port}/`);
      expect(await response.text()).toBe("ok");
    } finally {
      await close(server);
    }
  });
});

describe("readRawBody HAM baytları verir", () => {
  /**
   * Webhook imzası bu baytlar üzerinden hesaplanıyor. Gövde ayrıştırılıp
   * yeniden serileştirilirse (boşluk, anahtar sırası, unicode kaçışı) imza
   * tutmaz ve gerçek bir webhook sessizce reddedilir.
   */
  it("boşluk ve anahtar sırası olduğu gibi korunur", async () => {
    const raw = '{"b":  1,\n  "a": "ç\\u00e7"}';
    let seen: string | null = null;
    const server = createServer((req, res) => {
      void readRawBody(req).then((body) => {
        seen = body;
        res.end();
      });
    });
    const port = await listen(server, 0);
    try {
      await fetch(`http://${LOOPBACK_HOST}:${port}/`, { method: "POST", body: raw });
      expect(seen).toBe(raw);
    } finally {
      await close(server);
    }
  });
});

describe("parseJsonObject yalnız nesne kabul eder", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ["[]", null],
    ["[1,2]", null],
    ['"metin"', null],
    ["42", null],
    ["null", null],
    ["bozuk", null],
    ["", null],
  ])("%s → %o", (raw, expected) => {
    expect(parseJsonObject(raw as string)).toEqual(expected);
  });
});
