import type { PageRequest } from "../read-models.js";
import type {
  OnboardingOptionsRecord,
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
  constructor(
    private readonly record: OnboardingOptionsRecord = {
      projects: [],
      repos: [],
      platforms: [],
    },
    private readonly samples: ReadonlyMap<string, readonly OnboardingSampleTicket[]> = new Map(),
  ) {}

  options(request: PageRequest): Promise<OnboardingOptionsRecord> {
    return Promise.resolve({
      projects: this.record.projects.slice(0, request.limit),
      repos: this.record.repos.slice(0, request.limit),
      platforms: [...this.record.platforms],
    });
  }

  recentTickets(projectKey: string, limit: number): Promise<readonly OnboardingSampleTicket[]> {
    return Promise.resolve((this.samples.get(projectKey) ?? []).slice(0, limit));
  }

  binding(projectKey: string): Promise<OnboardingProject | null> {
    return Promise.resolve(
      this.record.projects.find((project) => project.projectKey === projectKey) ?? null,
    );
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
