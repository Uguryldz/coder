#!/usr/bin/env node
/**
 * Mini sahte Jira — sadece demo/test için.
 * Herhangi bir ticket key'e gerçekçi bir JSON dönder, yorumları loglar.
 */
import http from "node:http";

const PORT = process.env.PORT || 8080;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log(req.method, req.url, body ? `body(${body.length}b)` : "");
    res.setHeader("content-type", "application/json");

    // GET /rest/api/2/issue/KEY
    if (req.method === "GET" && /\/rest\/api\/[23]\/issue\/[^/]+$/.test(req.url)) {
      const key = req.url.split("/").pop();
      res.end(JSON.stringify({
        id: key,
        key,
        fields: {
          project: { key: "DEMO", name: "Demo Project" },
          summary: "Sepet sayfasına indirim kuponu butonu ekle",
          description: "Kullanıcı sepet ekranında kupon kodu girip indirim uygulayabilmeli. Sonuç fiyatı güncellenmeli.",
          issuetype: { name: "Task" },
          status: { name: "In Progress" },
          labels: ["mode:full-auto"],
          components: [{ name: "web" }],
          reporter: { accountId: "reporter-1", displayName: "Test Reporter", emailAddress: "reporter@demo.local" },
          assignee: null,
        },
      }));
      return;
    }
    // GET transitions
    if (req.method === "GET" && /transitions/.test(req.url)) {
      res.end(JSON.stringify({ transitions: [
        { id: "1", name: "AI Analyzing", to: { name: "AI Analyzing" } },
        { id: "2", name: "Waiting for PO", to: { name: "Waiting for PO" } },
        { id: "3", name: "Done", to: { name: "Done" } },
      ]}));
      return;
    }
    // POST comment
    if (req.method === "POST" && /\/comment/.test(req.url)) {
      const key = req.url.match(/issue\/([^/]+)/)?.[1];
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const text = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body).slice(0, 200);
      console.log(`\x1b[36m[JIRA ${key}]\x1b[0m ${text}\n`);
      res.statusCode = 201;
      res.end(JSON.stringify({ id: String(Date.now()), body: parsed.body }));
      return;
    }
    // POST transition
    if (req.method === "POST" && /transitions/.test(req.url)) {
      const key = req.url.match(/issue\/([^/]+)/)?.[1];
      console.log(`\x1b[33m[JIRA ${key}]\x1b[0m transition → ok`);
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end("{}");
  });
});

server.listen(PORT, () => log(`jira-stub dinliyor :${PORT}`));
