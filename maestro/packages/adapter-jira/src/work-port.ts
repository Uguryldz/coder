import { TicketKey, type CommandEnvelope, type TicketSnapshot } from "@maestro/contracts";
import { type WorkPort } from "@maestro/ports";
import { adfToWikiMarkup, toAdfDocument } from "./adf.js";
import { JiraDcClient, type FetchLike, type TokenProvider } from "./client.js";
import type { JiraDcConfig } from "./config.js";
import { parseDcCommandFromComment, type DcCommentCommand } from "./dc-comment-command.js";
import {
  JiraArgumentError,
  JiraForbiddenError,
  JiraLinkFailedError,
  JiraMembershipUnresolvedError,
  JiraNotFoundError,
  JiraResponseError,
} from "./errors.js";
import { ISSUE_FIELDS, mapIssueToSnapshot, userIdOf } from "./mapping.js";
import { searchDcIssues, type DcSearchPage, type DcSearchRequest } from "./search.js";
import {
  currentStatusNameOf,
  foldStatusName,
  parseAvailableTransitions,
  requireTransitionId,
  selectTransitionByStatusName,
  type AvailableTransition,
  type TransitionOutcome,
} from "./transitions.js";
import {
  commandFromWebhook,
  JIRA_SIGNATURE_HEADER,
  verifyWebhookSignature,
  type RawBody,
  type WebhookCommand,
} from "./webhook.js";

export interface JiraDcWorkPortOptions {
  config: JiraDcConfig;
  /** Resolves the PAT (usually `() => secrets.get(config.tokenRef)`). */
  token: TokenProvider;
  /** Resolves the webhook shared secret. */
  webhookSecret: () => string | Promise<string>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const API = "/rest/api/2";
const MAX_GROUP_PAGES = 40;

/**
 * WorkPort driver for Jira Data Center (M46). Permission set: Browse, Add
 * Comment, Edit Issue (labels), Assign, Create/Link Issue — ve M111'den beri
 * Transition Issues.
 *
 * M102'de DC sürücüsü kasten hiçbir iş akışı geçişi sahiplenmiyordu ("no
 * workflow permission is requested") ve ilerleme bir ETİKETLE gösteriliyordu.
 * O karar, operatör panelde bir statü haritası kurduğu anda geçersiz kaldı:
 * harita `onStart` / `onNeedInfo` / `onReview` / `onRejected` / `onDone` için
 * statü ADLARI söylüyor ve bunları uygulayacak tek yer bu sürücü.
 *
 * İzin sorusu yeteneğin VARLIĞIYLA karıştırılmıyor. Yetenek her zaman mevcut —
 * `apps/deploy/src/stores/status-mover.ts` sürücüyü YAPISAL olarak yokluyor,
 * metot yoksa harita sessizce hiçbir şey yapmaz. Servis hesabına "Transition
 * Issues" izni verilmemişse Jira 403 döner ve bu bir çökme değil, gerekçeli bir
 * sonuçtur: `{moved:false, reason:"forbidden"}`. Akış uyarır ve devam eder.
 */
export class JiraDcWorkPort implements WorkPort {
  readonly driver = "jira-dc";
  private readonly client: JiraDcClient;
  private readonly config: JiraDcConfig;
  private readonly webhookSecret: () => string | Promise<string>;

  constructor(options: JiraDcWorkPortOptions) {
    this.config = options.config;
    this.webhookSecret = options.webhookSecret;
    this.client = new JiraDcClient({
      baseUrl: options.config.baseUrl,
      token: options.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.config.requestTimeoutMs,
      sleep: options.sleep,
    });
  }

  async getTicket(key: TicketKey): Promise<TicketSnapshot> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      fields: ISSUE_FIELDS,
    });
    return mapIssueToSnapshot(raw);
  }

  /**
   * `body` is an ADF document or a plain string. DC's REST v2 comment API
   * speaks wiki markup, so the document is rendered on the way out (M46).
   */
  async addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }> {
    const issueKey = requireTicketKey(key, "key");
    const rendered = adfToWikiMarkup(toAdfDocument(body));
    const created = await this.client.post<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: rendered,
    });
    return { commentId: requireId(created, "comment") };
  }

  /**
   * Edit an existing comment in place — the "▶ Maestro durum" progress comment
   * is updated instead of spamming new ones (M75).
   */
  async updateComment(key: TicketKey, commentId: string, body: unknown): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    if (commentId.trim().length === 0) throw new JiraArgumentError("commentId", "empty");
    const rendered = adfToWikiMarkup(toAdfDocument(body));
    const updated = await this.client.put<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { body: rendered },
    );
    requireId(updated, "comment");
  }

  /** Full replacement of the label set — the only issue edit the driver performs (M102). */
  async setLabels(key: TicketKey, labels: string[]): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const clean = labels.map((label) => label.trim());
    for (const label of clean) {
      if (label.length === 0) throw new JiraArgumentError("labels", "empty label");
      if (/\s/.test(label)) throw new JiraArgumentError("labels", `Jira labels cannot contain whitespace: "${label}"`);
    }
    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}`, { fields: { labels: clean } });
  }

  /**
   * On DC the assignee is addressed by username (`name`); `null` unassigns.
   * The port calls the argument `accountId` for Cloud parity.
   */
  async assign(key: TicketKey, accountId: string | null): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const name = accountId === null ? null : accountId.trim();
    if (name !== null && name.length === 0) throw new JiraArgumentError("accountId", "empty");
    await this.client.put<void>(`${API}/issue/${encodeURIComponent(issueKey)}/assignee`, { name });
  }

  /** Fan-out child (M100): create, then link it back to the parent. */
  async createLinkedIssue(
    parent: TicketKey,
    fields: { summary: string; description: string; labels?: string[] },
  ): Promise<{ key: TicketKey }> {
    const parentKey = requireTicketKey(parent, "parent");
    const projectKey = parentKey.split("-")[0];
    if (!projectKey) throw new JiraArgumentError("parent", "cannot derive project key");
    if (fields.summary.trim().length === 0) throw new JiraArgumentError("summary", "empty");

    const created = await this.client.post<unknown>(`${API}/issue`, {
      fields: {
        project: { key: projectKey },
        summary: fields.summary,
        description: fields.description,
        issuetype: { name: this.config.childIssueTypeName },
        ...(fields.labels && fields.labels.length > 0 ? { labels: fields.labels } : {}),
      },
    });

    const childKey = requireKey(created, "created issue");
    try {
      await this.client.post<void>(`${API}/issueLink`, {
        type: { name: this.config.linkTypeName },
        inwardIssue: { key: childKey },
        outwardIssue: { key: parentKey },
      });
    } catch (error) {
      throw new JiraLinkFailedError(childKey, parentKey, error);
    }
    return { key: childKey };
  }

  /**
   * Group membership backing gate authorisation (M32/M51). This is the ONLY
   * evidence a gate decision rests on, so it matches solely on identifiers a
   * Jira admin controls, skips inactive members locally, and never guesses:
   * an undecidable page raises instead of quietly denying.
   */
  async verifyMembership(userId: string, group: string): Promise<boolean> {
    // The decision carries an AUDIT actor (`712020.abc@banka.local`), while
    // the directory knows a Jira identifier. The local part is what the two
    // have in common; the raw string is kept too, because a Data Center login
    // may legitimately contain an `@`.
    const raw = userId.trim().toLowerCase();
    const needles = [raw, raw.includes("@") ? raw.slice(0, raw.lastIndexOf("@")) : raw];
    if (raw.length === 0) throw new JiraArgumentError("userId", "empty");
    if (group.trim().length === 0) throw new JiraArgumentError("group", "empty");

    let startAt = 0;
    for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
      const res = await this.client
        .get<unknown>(`${API}/group/member`, {
          groupname: group,
          includeInactiveUsers: false,
          startAt,
          maxResults: this.config.groupPageSize,
        })
        .catch((error: unknown) => {
          /**
           * 404 = "böyle bir grup yok", bir ağ arızası değil.
           *
           * Ham 404 yukarıya çıktığında ekranda yalnız "üyelik doğrulanamadı"
           * yazıyordu ve operatör bunu bir yetki reddi sanıyordu; oysa arıza
           * `GATE_GROUPS` eşlemesindeydi. Adıyla söylemek, bu satırın tek işi.
           * Hâlâ FIRLIYOR — sessiz bir "üye değil"e çevirmek fail-open olurdu.
           */
          if (error instanceof JiraNotFoundError) {
            throw new JiraMembershipUnresolvedError(group, "no_such_group", "Jira 404");
          }
          throw error;
        });
      const body = asRecord(res);
      const values = Array.isArray(body?.["values"]) ? body["values"] : [];
      for (const member of values) {
        if (isActiveMember(member)) {
          const ids = identifiersOf(member);
          if (needles.some((needle) => ids.includes(needle))) return true;
        }
      }
      if (values.length === 0) return false;
      startAt += values.length;
      if (!hasMorePages(body, startAt, group)) return false;
    }
    throw new JiraMembershipUnresolvedError(
      group,
      "too_many_pages",
      `stopped after ${MAX_GROUP_PAGES} pages of ${this.config.groupPageSize}`,
    );
  }

  /**
   * One page of an issue's comments, raw as the server recorded them
   * (fixtures/comments-list.json) — the poll source that feeds
   * `parseCommandFromComment`.
   *
   * DRIVER-SPECIFIC CAPABILITY, not a `WorkPort` method: the port carries what
   * the WORKFLOW needs, and reading a thread is not that (the engine is
   * signalled, it does not look). The Cloud driver offers the same method for
   * the same reason.
   *
   * WHY DC needs it at all. The signed webhook above is this driver's primary
   * command path and stays primary — but a Data Center behind a corporate
   * firewall often cannot call out to Maestro, and then `/approve` written on
   * the ticket reaches nothing at all: the approval gate waits forever and
   * nobody can say why. This is the fallback (`apps/deploy/src/jira-poller.ts`,
   * enabled by `JIRA_POLL_MS`).
   *
   * REST v2's shape is v3's: `{ startAt, maxResults, total, comments: [...] }`.
   * A response that is not that shape raises rather than returning an empty
   * list — silently reading zero comments looks exactly like "nobody approved
   * yet", which is the failure this method exists to end.
   */
  async listComments(key: TicketKey): Promise<unknown[]> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}/comment`, {});
    const comments = asRecord(raw)?.["comments"];
    if (!Array.isArray(comments)) throw new JiraResponseError("comments", ["response carries no comments array"]);
    return comments;
  }

  /**
   * JQL araması — bir ticket'ın webhook OLMADAN platforma girebildiği tek yol.
   *
   * SÜRÜCÜYE ÖZGÜ YETENEK, donmuş `WorkPort`'un bir metodu değil: `listComments`
   * ve `readAvailableTransitions` ile aynı desen. `apps/deploy`'un keşif döngüsü
   * sürücüyü tam olarak bu metodun VARLIĞIYLA yokluyor (`canSearch`, yapısal
   * kontrol), yani bunu eklemek keşfi DC'de açan şeyin kendisidir.
   *
   * ── Neden bu metot bugüne dek yoktu, ve neden yokluğu ölümcüldü ───────────
   * `searchIssues` yalnız Cloud sürücüsünde vardı, ve `canSearch` DC'de false
   * dönüyordu. Tamamen kapalı bir kurulumda (webhook kaydedilemeyen bir Data
   * Center) bu üç şeyi aynı anda doğru kılıyordu:
   *
   *   · webhook gelmiyor  → intake yolu kapalı;
   *   · yorum yoklaması yalnız ZATEN koşusu olan ticket'lara bakıyor
   *     (`openTickets` = `db.workflowRun`) → hiç koşu yokken liste boş;
   *   · tarama DC'de hiç başlamıyor → yeni ticket bulunamıyor.
   *
   * Üçü birlikte kısır bir döngü: panel yeşil, bağlantı yeşil, kurallar doğru,
   * ve hiçbir ticket asla akışa girmiyor — hiçbir yerde de hata yok.
   *
   * ── Neden mümkün ──────────────────────────────────────────────────────────
   * DC'de arama YOK değildi; yalnızca sürücüye YAZILMAMIŞTI. REST v2
   * `GET /rest/api/2/search` ucunu `jql`/`startAt`/`maxResults`/`fields` ile
   * sunuyor (Atlassian Server/DC dokümanı, Context7 ile doğrulandı). Cevap
   * şekli Cloud'unkinden farklı — DC klasik `startAt`/`total` sayfalamasını
   * sürdürüyor, Cloud imleç sayfalamasına geçti — bu yüzden ayrıştırıcı ayrı
   * bir dosyada (`search.ts`), ortak olan yalnız `issues` dizisi.
   */
  searchIssues(request: DcSearchRequest): Promise<DcSearchPage> {
    return searchDcIssues(this.client, request);
  }

  /**
   * Direct entry for the comment poller: one v2 comment resource + its issue
   * key. The comment resource carries only an issue-id URL, so the caller —
   * who polled a specific issue — supplies the key.
   *
   * Enforces the same K-2 rule as the webhook path: an edited comment carries
   * no command. See `dc-comment-command.ts`.
   */
  parseCommandFromComment(ticketKey: string, comment: unknown): DcCommentCommand {
    return parseDcCommandFromComment(ticketKey, comment);
  }

  /** Verified webhook payload → command, or null. Never throws on unknown commands. */
  async parseCommand(rawBody: unknown): Promise<CommandEnvelope | null> {
    return this.parseCommandDetailed(rawBody).envelope;
  }

  /** Same parse, keeping the "looks like a command but is malformed" result. */
  parseCommandDetailed(rawBody: unknown): WebhookCommand {
    return commandFromWebhook(rawBody);
  }

  /**
   * Verify a delivery before anything else touches it. Throws
   * JiraWebhookVerificationError on any failure — fail-closed, no boolean.
   */
  async verifyWebhook(rawBody: RawBody, headers: Record<string, string>): Promise<void> {
    const header = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === JIRA_SIGNATURE_HEADER,
    )?.[1];
    verifyWebhookSignature(rawBody, header, await this.webhookSecret());
  }

  /**
   * Bir issue'nun MEVCUT statüsünden çıkan geçişler, her biri hedef statüsünün
   * kategorisiyle birlikte.
   *
   * SÜRÜCÜYE ÖZGÜ YETENEK, bir `WorkPort` metodu değil — `listComments` ile
   * aynı şekil. Bu bir OKUMA: `GET /rest/api/2/issue/{key}/transitions`.
   * `expand=transitions.fields` İSTENMEZ; varsayılan gövde zaten
   * `to.statusCategory` taşır (Context7 ile doğrulandı, DC REST v11003
   * "api-group-issue"), seçim için gereken de yalnızca o.
   */
  async readAvailableTransitions(key: TicketKey): Promise<AvailableTransition[]> {
    const issueKey = requireTicketKey(key, "key");
    const raw = await this.client.get<unknown>(
      `${API}/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return parseAvailableTransitions(raw);
  }

  /**
   * Geçişi id ile uygula: `POST /rest/api/2/issue/{key}/transitions` gövdesi
   * `{ transition: { id } }`, başarıda 204 No Content — Cloud'un v3 ucuyla
   * birebir aynı istek/yanıt şekli (Context7, DC REST v11003).
   */
  private async applyTransition(key: TicketKey, transitionId: string): Promise<void> {
    const issueKey = requireTicketKey(key, "key");
    const id = requireTransitionId(transitionId);
    await this.client.post<void>(`${API}/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id },
    });
  }

  /**
   * Donmuş portun `transition`ı — M102'deki yetenek reddi değil, artık gerçek
   * hareket. `applyTransition`ın port adı altındaki ince devri.
   *
   * ID ile taşıma DÜŞÜK seviyeli giriştir: bir geçiş id'si iş akışına özgü bir
   * numaradır (bir projedeki 11/21/31 başka projede hiçbir şey ifade etmez), o
   * yüzden yalnızca NEREYE gitmek istediğini bilen bir çağıran
   * `transitionToStatus`a uzanmalı. Bu metot, elinde düz bir `WorkPort`
   * referansı olan çağıranın da hareket edebilmesi için var; Cloud'daki
   * kardeşiyle aynı gerekçe.
   */
  async transition(key: TicketKey, transitionId: string): Promise<void> {
    await this.applyTransition(key, transitionId);
  }

  /**
   * Ticket'ın STATÜ değişimleri — kim, ne zaman, nereye. En eskiden en yeniye.
   *
   * ── Neden `readCurrentStatus` yetmiyor ────────────────────────────────────
   * Kapı kararı statüyle verilebiliyor, ve `decideGate` GRUP ÜYELİĞİ soruyor
   * (M32/M35): statü değiştirmek yetkiyi atlamanın yolu değildir. Üyelik ancak
   * kararı VERENİ adlandırabildiğimizde ölçülebilir. Ticket'ın şu anki statüsü
   * onu KİMİN oraya taşıdığını söylemez; changelog söyler.
   *
   * Webhook'suz kurulumda (dışarı çıkışı olmayan kurumsal ağdaki DC) bu tek
   * yoldur: teslimat gelmiyorsa aktörü öğrenmenin başka kaynağı yok, ve aktör
   * olmadan bu kanal kapı kararı taşıyamazdı.
   *
   * ── Neden ayrı bir yetenek, `WorkPort` metodu değil ───────────────────────
   * `listAssigneeChanges` ile aynı gerekçe ve aynı desen: `WorkPort` DONMUŞ, ve
   * bu okuma workflow'un ihtiyacı değil yoklama döngüsünün ihtiyacı.
   *
   * `at` (changelog kaydının kendi zamanı) taşınıyor, çünkü kapı kanalının ZAMAN
   * katmanı buna dayanıyor: kapı açılmadan ÖNCEKİ bir taşıma, Maestro'nun kendi
   * `onReview` hareketinin yankısıdır ve karar sayılmamalıdır.
   */
  async listStatusChanges(
    key: TicketKey,
  ): Promise<Array<{ id: string; actorAccountId: string; toStatus: string | null; at: string }>> {
    const issueKey = requireTicketKey(key, "key");
    /**
     * DC'de changelog AYRI bir uç DEĞİL: REST v2'de issue okumasına
     * `expand=changelog` ile iliştirilir. Cloud'un `/issue/{key}/changelog`
     * sayfalanmış ucu burada yok, ve bu farkı adlandırmak gerekiyor — iki
     * sürücünün aynı isimli metodu iki farklı Jira'ya iki farklı soru soruyor.
     *
     * `fields=status`: gövdeyi küçük tutar. Ticket METNİ istenmiyor — bu
     * döngü hiçbir noktada ticket içeriği tutmaz.
     */
    const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
      expand: "changelog",
      fields: "status",
    });
    const histories = asRecord(asRecord(raw)?.["changelog"])?.["histories"];
    if (!Array.isArray(histories)) {
      throw new JiraResponseError("changelog", ["response carries no changelog histories"]);
    }

    const out: Array<{ id: string; actorAccountId: string; toStatus: string | null; at: string }> = [];
    for (const entry of histories) {
      const rec = asRecord(entry);
      const id = rec?.["id"];
      const created = rec?.["created"];
      // DC'de `accountId` YOK. `userIdOf` `name`/`key`/`emailAddress` sırasını
      // uygular — yorum komutlarının yazarını çözen mantığın aynısı, çünkü
      // üyelik kontrolü de o kimlikle yapılıyor.
      const actor = userIdOf(rec?.["author"]);
      const items = rec?.["items"];
      if (typeof id !== "string" && typeof id !== "number") continue;
      if (actor === null || !Array.isArray(items)) continue;
      for (const item of items) {
        const it = asRecord(item);
        if (it?.["field"] !== "status") continue;
        const to = it["toString"];
        out.push({
          id: String(id),
          actorAccountId: actor,
          toStatus: typeof to === "string" && to.trim().length > 0 ? to.trim() : null,
          at: typeof created === "string" ? created : "",
        });
      }
    }
    return out;
  }

  /**
   * Ticket'ın ŞU ANKİ statü ADI — okuma, hareket yok.
   *
   * SÜRÜCÜYE ÖZGÜ YETENEK, `WorkPort` metodu DEĞİL: port DONMUŞ ve donmuş
   * `TicketSnapshot` bir statü alanı taşımıyor. Bu, yalnızca statüyü ekleyerek
   * o şemayı genişletmemenin bedeli — ve statüyü snapshot'a eklemek, ondan
   * beslenen her yazıcıya, her doğrulayıcıya ve donmuş sözleşmeye dokunmak
   * demek olurdu.
   *
   * Tek okuyucusu yoklama döngüsünün kapı statüsü kanalı
   * (`apps/deploy/src/jira-poller.ts`): webhook'un ULAŞMADIĞI kurulumda
   * operatörün ticket'ı bir statüye taşımasını GÖREBİLMEK için tek yol bu.
   * Webhook yolunda gerekmiyor — teslimat statüyü zaten taşıyor.
   *
   * `null` = "site bir statü adı söylemedi". Bir hata değil ve fırlatmıyor:
   * çağıran bunu "karar yok" olarak okur, ki bilinmeyen bir statüden karar
   * üretmemek zaten bu kanalın fail-closed yönü.
   *
   * `fields=status`: kararın ihtiyaç duyduğu tek alan. Ticket METNİ (summary /
   * description) bilerek istenmiyor — bu döngü hiçbir noktada ticket içeriği
   * tutmaz.
   */
  async readCurrentStatus(key: TicketKey): Promise<string | null> {
    const parsed = TicketKey.safeParse(key);
    if (!parsed.success) return null;
    const raw = await this.client.get<unknown>(
      `${API}/issue/${encodeURIComponent(parsed.data)}`,
      { fields: "status" },
    );
    return currentStatusNameOf(raw);
  }

  /**
   * Issue'yu ADINA göre bir statüye taşı ve fırlatmak yerine NE OLDUĞUNU
   * raporla — "uyar ama devam et" politikası olan iş akışı adımının girişi.
   * DC'nin statü haritasını (`apps/deploy/src/stores/status-mover.ts`) gerçekten
   * çalıştıran metot budur.
   *
   * SÜRÜCÜYE ÖZGÜ YETENEK, bir `WorkPort` metodu değil: `WorkPort` DONMUŞ
   * (packages/ports) ve bu metot `void` değil bir SONUÇ döner — donmuş imzanın
   * ifade edemeyeceği bir şey. Cloud sürücüsündeki eşiyle aynı sözleşme.
   *
   * Neden ada göre, id'ye göre değil: bir geçiş id'si onu üreten tek iş akışının
   * dışında anlamsızdır; sabit yazılmış bir id, proje başka bir iş akışı
   * kullandığı anda yanlış ticket'ı (ya da hiçbir şeyi) sessizce taşır. Çağıran
   * gitmek istediği HEDEFİ adlandırır, bu metot Jira'ya oraya hangi kenarın
   * götürdüğünü sorar.
   *
   * Sözleşme TAMDIR — ASLA fırlatmaz, her sonuç bir gerekçedir:
   *
   *   - `{moved:true}`                     — eşleşen geçiş uygulandı.
   *   - `{moved:false, reason:"already"}`  — issue ZATEN o statüde, hiç POST
   *     atılmaz. Adım yeniden çalıştırılabilir (workflow replay, elle tekrar) ve
   *     zaten yapılmış bir hareketi yeniden POSTlamak en iyi ihtimalle 400'dür;
   *     çağrıyı idempotent kılan bu kısa devredir.
   *   - `{moved:false, reason:"no_transition"}` — iş akışı, issue'nun durduğu
   *     yerden o statüye giden bir kenar sunmuyor. Hata değil: sitede o sütun
   *     olmayabilir ya da hareket oradan yasak olabilir.
   *   - `{moved:false, reason:"forbidden"}` — Jira 403 dedi. Servis hesabı
   *     issue'yu görebiliyor ama taşıyamıyor; OPERATÖR bunu Jira'da servis
   *     hesabına "Transition Issues" (Issue'ları Geçir) izni vererek düzeltir,
   *     Maestro'da değil. Analiz yine de teslim edilmeye değer, bu yüzden
   *     çağıran uyarır ve yoluna devam eder.
   *   - `{moved:false, reason:"read_failed" | "transition_failed"}` — geri
   *     kalan her şey (5xx, 404, bozuk gövde), HANGİ çağrının düştüğüne göre
   *     ayrılmış: seçenekleri hiç öğrenemedik mi, yoksa seçtiğimizi
   *     uygulayamadık mı.
   */
  async transitionToStatus(key: TicketKey, statusName: string): Promise<TransitionOutcome> {
    // Anahtar ve statü adı en başta doğrulanır ve fırlatılmaz, gerekçe olarak
    // raporlanır: fırlatmaması gereken bir çağıran, aksi hâlde argüman
    // korumalarından yine de bir istisna yerdi.
    const parsed = TicketKey.safeParse(key);
    if (!parsed.success) return { moved: false, reason: "bad_key" };
    const issueKey = parsed.data;
    const wanted = statusName.trim();
    if (wanted.length === 0) return { moved: false, reason: "bad_status_name" };

    // Önce MEVCUT statü okunur; böylece zaten oradaki bir issue bir GET'e mal
    // olur ve hiç yazma yapılmaz. `fields=status`, tüm issue'yu ağ üzerinden
    // sürüklemek yerine kararın ihtiyaç duyduğu tek alanla sınırlar.
    let current: string | null;
    let transitions: AvailableTransition[];
    try {
      const raw = await this.client.get<unknown>(`${API}/issue/${encodeURIComponent(issueKey)}`, {
        fields: "status",
      });
      current = currentStatusNameOf(raw);
      if (current !== null && foldStatusName(current) === foldStatusName(wanted)) {
        return { moved: false, reason: "already" };
      }
      transitions = await this.readAvailableTransitions(issueKey);
    } catch {
      return { moved: false, reason: "read_failed" };
    }

    const target = selectTransitionByStatusName(transitions, wanted);
    if (target === null) return { moved: false, reason: "no_transition" };

    try {
      await this.applyTransition(issueKey, target.id);
    } catch (error) {
      // 403 kendi başına ayrılıyor, çünkü operatörün Maestro'da değil JİRA'da
      // düzelttiği tek başarısızlık o: servis hesabına "Transition Issues"
      // izni ver. Günlükte kendi gerekçesini hak ediyor.
      if (error instanceof JiraForbiddenError) return { moved: false, reason: "forbidden" };
      return { moved: false, reason: "transition_failed" };
    }
    return { moved: true };
  }
}

function requireTicketKey(value: string, argument: string): TicketKey {
  const parsed = TicketKey.safeParse(value);
  if (!parsed.success) throw new JiraArgumentError(argument, `"${value}" is not a Jira issue key`);
  return parsed.data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireId(value: unknown, context: string): string {
  const id = asRecord(value)?.["id"];
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  throw new JiraResponseError(context, ["response carries no id"]);
}

function requireKey(value: unknown, context: string): TicketKey {
  const key = asRecord(value)?.["key"];
  const parsed = typeof key === "string" ? TicketKey.safeParse(key) : null;
  if (!parsed?.success) throw new JiraResponseError(context, ["response carries no usable issue key"]);
  return parsed.data;
}

/**
 * Identifiers a DC user may be matched by, lowercased. `displayName` is NOT
 * one of them: it comes from LDAP, is not unique, and changes — two people
 * called "Mert Demir" would share gate authority. Only the admin-controlled
 * username, the rename-proof user key, and the e-mail address count.
 */
/**
 * Every identifier a member can be recognised by.
 *
 * `name` and `key` are Data Center's; Cloud sends neither, and hides
 * `emailAddress` unless the caller has user-management scope — so on a Cloud
 * site every one of them is null and the only identifier present is
 * `accountId`. Without it, `verifyMembership` answered false for a person who
 * IS in the group, and a real approval was refused as "üyelik doğrulanamadı"
 * (OPS-36).
 *
 * The account id is also offered in the shape the audit trail forces it into:
 * `HUMAN_ACTOR` allows no colon, so the BFF writes `712020:abc` as
 * `712020.abc@<domain>` (`apps/bff/src/actor.ts`) and it is THAT string which
 * comes back on the decision. Both spellings are matched here rather than
 * unpicked at the call site, because this is the one place that knows what a
 * Jira identifier looks like.
 */
function identifiersOf(member: unknown): string[] {
  const user = asRecord(member);
  if (!user) return [];
  const accountId = typeof user["accountId"] === "string" ? user["accountId"] : undefined;
  const ids = [
    user["name"],
    user["key"],
    user["emailAddress"],
    accountId,
    // The colon-free spelling the audit contract requires. The local part
    // only — the domain is the deployment's, not Jira's, so matching on it
    // would tie this driver to whatever `MAESTRO_ACTOR_DOMAIN` happens to say.
    accountId?.replace(/:/gu, "."),
  ];
  return ids
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim().toLowerCase());
}

/**
 * `includeInactiveUsers=false` asks the server to leave off-boarded accounts
 * out, but the driver must not depend on the server honouring it — an approver
 * who left the bank never passes a gate (M32 fail-closed).
 */
function isActiveMember(member: unknown): boolean {
  return asRecord(member)?.["active"] !== false;
}

/**
 * Decide whether another page must be fetched. A page bean that carries
 * neither `isLast` nor a numeric `total` cannot be reasoned about, and
 * stopping there would deny a real member without a trace.
 */
function hasMorePages(body: Record<string, unknown> | null, startAt: number, group: string): boolean {
  const isLast = body?.["isLast"];
  if (typeof isLast === "boolean") return !isLast;
  const total = body?.["total"];
  if (typeof total === "number") return startAt < total;
  throw new JiraMembershipUnresolvedError(
    group,
    "incomplete_page_bean",
    "the member page carries neither a boolean isLast nor a numeric total",
  );
}
