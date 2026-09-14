import { PlatformProfile } from "@maestro/contracts";
import type { AppRegistration, AppRegistryWriter } from "../deps.js";
import type { PageRequest } from "../read-models.js";
import type {
  OnboardingOptionsRecord,
  OnboardingOptionsRequest,
  OnboardingProject,
  OnboardingReader,
  OnboardingSampleTicket,
  RepoPolicyReader,
  RepoPolicyRecord,
} from "../onboarding-models.js";

/**
 * Reference implementations of the onboarding and repo-policy readers.
 *
 * These exist for the BFF's own tests, which run offline against the interface
 * (M44). They are NOT what the composition root wires: a store that answers
 * truthfully about an empty map renders "no projects to onboard" on a screen
 * whose real answer is "the registry was never read", and those two look
 * identical to an operator. `apps/deploy/src/stores/` holds the Postgres ones.
 *
 * Seeded through the constructor rather than defaulting to a populated map, so
 * a test that forgets to seed sees empty lists rather than fixture data it did
 * not ask for.
 */

export class InMemoryOnboardingReader implements OnboardingReader {
  private readonly projects: OnboardingOptionsRecord["projects"];
  private readonly repos: { appId: string; repo: string; platform: string }[];
  private readonly platforms: Set<string>;

  constructor(
    record: OnboardingOptionsRecord = { projects: [], repos: [], platforms: [] },
    private readonly samples: ReadonlyMap<string, readonly OnboardingSampleTicket[]> = new Map(),
  ) {
    this.projects = [...record.projects];
    this.repos = record.repos.map((repo) => ({ ...repo }));
    this.platforms = new Set(record.platforms);
  }

  /**
   * Add a repo to the options the way `PrismaAppRegistryWriter` adds an
   * `Application` row: the test writer calls this so a submission that
   * REGISTERS a repo is then visible to the same request's `assertBindable`,
   * exactly as the Postgres reader would see the row the writer just upserted.
   * Keyed on `appId`, so re-registering the same repo replaces rather than
   * duplicates.
   */
  addRepo(entry: { appId: string; repo: string; platform: string }): void {
    const existing = this.repos.findIndex((candidate) => candidate.appId === entry.appId);
    if (existing >= 0) this.repos[existing] = { ...entry };
    else this.repos.push({ ...entry });
    this.platforms.add(entry.platform);
  }

  /**
   * `request.projectKey` BURADA DİKKATE ALINMAZ, ve bu bilerek.
   *
   * Proje sahipliği `Application.jiraProjectKey` kolonunda yaşıyor; bu bellek
   * mağazası ise `OnboardingRepo`nun üç alanını (appId/repo/platform) tutuyor
   * ve o alan orada YOK. Uydurulmuş bir sahiplik alanı eklemek, bellek
   * mağazasının Postgres okuyucusundan FARKLI bir cevap vermesi demek olurdu —
   * ve bu mağazanın tek işi, veritabanı bağlanmamış bir kurulumda aynı
   * cevabı verebilmek.
   *
   * Filtrelememek burada güvenli yön: bu mağaza yalnız kurulum öncesi
   * (`bootstrap`) kullanılıyor, yani henüz hiçbir deponun hiçbir projeye
   * bağlanmadığı an — filtreli bir liste zaten boş dönerdi.
   */
  options(request: OnboardingOptionsRequest): Promise<OnboardingOptionsRecord> {
    // The four platform PROFILES are a fixed contract set, not something that
    // grows out of past bindings — a fresh install has no bindings yet, so
    // deriving the list from `this.platforms` alone would leave the mandatory
    // "Platform profili" dropdown EMPTY and block the very first onboarding.
    // Union the contract's profiles with any already seen, so the field is
    // always fillable (mirrors the Prisma reader's `[...PlatformProfile.options]`).
    const platforms = new Set<string>([...PlatformProfile.options, ...this.platforms]);
    return Promise.resolve({
      projects: this.projects.slice(0, request.limit),
      repos: this.repos.slice(0, request.limit),
      platforms: [...platforms],
    });
  }

  recentTickets(projectKey: string, limit: number): Promise<readonly OnboardingSampleTicket[]> {
    return Promise.resolve((this.samples.get(projectKey) ?? []).slice(0, limit));
  }

  binding(projectKey: string): Promise<OnboardingProject | null> {
    return Promise.resolve(
      this.projects.find((project) => project.projectKey === projectKey) ?? null,
    );
  }
}

/**
 * Reference `AppRegistryWriter` for the BFF's offline tests. Writes into an
 * `InMemoryOnboardingReader` so the registration and the `assertBindable` that
 * follows it read the same store — the in-memory stand-in for "both sit on
 * `db.application`" in production.
 *
 * `repo` is stored as `<adoProject>/_git/<adoRepo>`, the exact shape the Postgres
 * reader derives, so `assertBindable`'s `candidate.repo` match behaves the same
 * offline as it does live.
 */
export class InMemoryAppRegistryWriter implements AppRegistryWriter {
  /** Every registration as sent — a test asserts the project a repo was filed under. */
  readonly registrations: AppRegistration[] = [];
  constructor(private readonly reader: InMemoryOnboardingReader) {}

  register(app: AppRegistration): Promise<void> {
    this.registrations.push({ ...app });
    this.reader.addRepo({
      appId: app.appId,
      repo: `${app.adoProject}/_git/${app.adoRepo}`,
      platform: app.platform,
    });
    return Promise.resolve();
  }
}

export class InMemoryRepoPolicyReader implements RepoPolicyReader {
  private readonly records: Map<string, RepoPolicyRecord>;

  constructor(records: readonly RepoPolicyRecord[] = []) {
    this.records = new Map(records.map((record) => [record.appId, record]));
  }

  /** Replace one record — how a test asserts that a write actually landed. */
  put(record: RepoPolicyRecord): void {
    this.records.set(record.appId, record);
  }

  list(request: PageRequest): Promise<readonly RepoPolicyRecord[]> {
    return Promise.resolve([...this.records.values()].slice(0, request.limit));
  }

  get(appId: string): Promise<RepoPolicyRecord | null> {
    return Promise.resolve(this.records.get(appId) ?? null);
  }
}
