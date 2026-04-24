import { createLogger, loadConfig } from "@orkestra/config";
import type { TestRunResult, TestScenario } from "@orkestra/contracts";
import axios, { AxiosInstance, AxiosResponse } from "axios";

const log = createLogger("testrail");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestRailClientOptions {
  baseUrl?: string;
  user?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface TestRailCaseRef {
  id: number;
  title: string;
  sectionId?: number;
  suiteId?: number;
}

export interface TestRailRunRef {
  id: number;
  name: string;
  url?: string;
}

// Inferring shapes from @orkestra/contracts
export type TestRailScenario = TestScenario extends infer T ? T : never;
export type TestRailResult = TestRunResult extends infer T ? T : never;

// ---------------------------------------------------------------------------
// TestRailClient
// ---------------------------------------------------------------------------

/**
 * TestRail REST client.
 *
 * - Noop when `TESTRAIL_BASE_URL` is empty (allows running Orkestra without
 *   TestRail configured).
 * - Uses Basic auth (user + API key).
 */
export class TestRailClient {
  private readonly http: AxiosInstance | null;
  private readonly baseUrl: string;

  constructor(opts: TestRailClientOptions = {}) {
    const cfg = loadConfig();
    this.baseUrl = (opts.baseUrl ?? cfg.TESTRAIL_BASE_URL).replace(/\/+$/, "");
    const user = opts.user ?? cfg.TESTRAIL_USER;
    const apiKey = opts.apiKey ?? cfg.TESTRAIL_API_KEY;

    if (!this.baseUrl) {
      this.http = null;
      return;
    }

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: opts.timeoutMs ?? 15_000,
      auth: user ? { username: user, password: apiKey } : undefined,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });

    this.http.interceptors.request.use((req) => {
      (req as { _startedAt?: number })._startedAt = Date.now();
      return req;
    });
    this.http.interceptors.response.use(
      (res: AxiosResponse) => {
        const started = (res.config as { _startedAt?: number })._startedAt ?? Date.now();
        log.debug(
          {
            method: res.config.method,
            url: res.config.url,
            status: res.status,
            durationMs: Date.now() - started,
          },
          "testrail.http",
        );
        return res;
      },
      (err: unknown) => {
        if (axios.isAxiosError(err)) {
          const started =
            (err.config as { _startedAt?: number } | undefined)?._startedAt ?? Date.now();
          log.warn(
            {
              method: err.config?.method,
              url: err.config?.url,
              status: err.response?.status,
              durationMs: Date.now() - started,
            },
            "testrail.http.error",
          );
        }
        return Promise.reject(err);
      },
    );
  }

  get isConfigured(): boolean {
    return this.http !== null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create or update TestRail test cases from `TestScenario[]`. Looks up the
   * project by key, finds or creates a section named after the project, then
   * upserts cases keyed by (title).
   *
   * Returns the list of case refs touched. No-op when unconfigured.
   */
  async pushTestCases(
    projectKey: string,
    scenarios: TestRailScenario[],
  ): Promise<TestRailCaseRef[]> {
    if (!this.http) {
      log.info(
        { projectKey, n: scenarios.length },
        "testrail not configured — pushTestCases skipped",
      );
      return [];
    }
    try {
      const project = await this.getProjectByKey(projectKey);
      const suiteId = await this.getOrCreateDefaultSuite(project.id);
      const sectionId = await this.getOrCreateSection(project.id, suiteId, projectKey);
      const existing = await this.listCases(project.id, suiteId);
      const existingByTitle = new Map(existing.map((c) => [c.title, c]));

      const refs: TestRailCaseRef[] = [];
      for (const s of scenarios) {
        const body = {
          title: s.title,
          custom_steps: s.gherkin,
          custom_automation_type: 1,
          custom_preconds: `Framework: ${s.framework}\nType: ${s.type}\nNegative: ${s.negative}`,
          custom_expected: s.code,
        };
        const match = existingByTitle.get(s.title);
        if (match) {
          const res = await this.http.post(`/index.php?/api/v2/update_case/${match.id}`, body);
          refs.push({ id: (res.data as { id: number }).id, title: s.title, sectionId, suiteId });
        } else {
          const res = await this.http.post(`/index.php?/api/v2/add_case/${sectionId}`, body);
          refs.push({ id: (res.data as { id: number }).id, title: s.title, sectionId, suiteId });
        }
      }
      return refs;
    } catch (err) {
      throw new Error(`[testrail] pushTestCases ${projectKey}: ${errMsg(err)}`);
    }
  }

  /**
   * Create a TestRail run with results. Results are matched to existing cases
   * by scenario title. No-op when unconfigured.
   */
  async pushTestRun(
    projectKey: string,
    runName: string,
    results: TestRailResult[],
  ): Promise<TestRailRunRef | null> {
    if (!this.http) {
      log.info({ projectKey, runName }, "testrail not configured — pushTestRun skipped");
      return null;
    }
    try {
      const project = await this.getProjectByKey(projectKey);
      const suiteId = await this.getOrCreateDefaultSuite(project.id);
      const cases = await this.listCases(project.id, suiteId);
      const casesByTitle = new Map(cases.map((c) => [c.title, c]));

      const caseIds: number[] = [];
      for (const r of results) {
        const match = casesByTitle.get(r.scenarioTitle);
        if (match) caseIds.push(match.id);
      }

      const addRun = await this.http.post(`/index.php?/api/v2/add_run/${project.id}`, {
        suite_id: suiteId,
        name: runName,
        include_all: false,
        case_ids: caseIds,
      });
      const run = addRun.data as { id: number; url?: string; name?: string };

      const apiResults: Array<Record<string, unknown>> = [];
      for (const r of results) {
        const match = casesByTitle.get(r.scenarioTitle);
        if (!match) continue;
        apiResults.push({
          case_id: match.id,
          status_id: r.passed ? 1 : 5, // 1=Passed, 5=Failed
          elapsed:
            r.durationMs > 0 ? `${Math.max(1, Math.round(r.durationMs / 1000))}s` : undefined,
          comment: r.errorMessage ? `${r.errorMessage}\n\n${r.output}` : r.output,
        });
      }

      if (apiResults.length > 0) {
        await this.http.post(`/index.php?/api/v2/add_results_for_cases/${run.id}`, {
          results: apiResults,
        });
      }

      return { id: run.id, name: run.name ?? runName, url: run.url };
    } catch (err) {
      throw new Error(`[testrail] pushTestRun ${projectKey} ${runName}: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async getProjectByKey(projectKey: string): Promise<{ id: number; name: string }> {
    const res = await this.http!.get(`/index.php?/api/v2/get_projects`);
    const list = Array.isArray(res.data)
      ? (res.data as Array<{ id: number; name: string; announcement?: string }>)
      : ((res.data as { projects?: Array<{ id: number; name: string }> }).projects ?? []);
    const hit = list.find((p) => p.name === projectKey);
    if (!hit) throw new Error(`project "${projectKey}" not found in TestRail`);
    return { id: hit.id, name: hit.name };
  }

  private async getOrCreateDefaultSuite(projectId: number): Promise<number> {
    const res = await this.http!.get(`/index.php?/api/v2/get_suites/${projectId}`);
    const list = Array.isArray(res.data) ? (res.data as Array<{ id: number; name: string }>) : [];
    if (list.length > 0) return list[0]!.id;
    const created = await this.http!.post(`/index.php?/api/v2/add_suite/${projectId}`, {
      name: "Orkestra",
    });
    return (created.data as { id: number }).id;
  }

  private async getOrCreateSection(
    projectId: number,
    suiteId: number,
    name: string,
  ): Promise<number> {
    const res = await this.http!.get(
      `/index.php?/api/v2/get_sections/${projectId}&suite_id=${suiteId}`,
    );
    const list = Array.isArray(res.data)
      ? (res.data as Array<{ id: number; name: string }>)
      : ((res.data as { sections?: Array<{ id: number; name: string }> }).sections ?? []);
    const hit = list.find((s) => s.name === name);
    if (hit) return hit.id;
    const created = await this.http!.post(`/index.php?/api/v2/add_section/${projectId}`, {
      name,
      suite_id: suiteId,
    });
    return (created.data as { id: number }).id;
  }

  private async listCases(projectId: number, suiteId: number): Promise<TestRailCaseRef[]> {
    const res = await this.http!.get(
      `/index.php?/api/v2/get_cases/${projectId}&suite_id=${suiteId}`,
    );
    const list = Array.isArray(res.data)
      ? (res.data as Array<{ id: number; title: string; section_id?: number }>)
      : ((res.data as { cases?: Array<{ id: number; title: string; section_id?: number }> })
          .cases ?? []);
    return list.map((c) => ({ id: c.id, title: c.title, sectionId: c.section_id, suiteId }));
  }
}

// ---------------------------------------------------------------------------
// Xray stub (Jira-native test management — future)
// ---------------------------------------------------------------------------

/**
 * Xray client stub. Shape-compatible with `TestRailClient` for the two
 * public methods, so callers can swap between them. All methods no-op with
 * an info log until v1.1.
 */
export class XrayClient {
  constructor(_opts: TestRailClientOptions = {}) {
    // reserved for future config
  }

  get isConfigured(): boolean {
    return false;
  }

  async pushTestCases(
    projectKey: string,
    scenarios: TestRailScenario[],
  ): Promise<TestRailCaseRef[]> {
    log.info({ projectKey, n: scenarios.length }, "xray client is a stub — pushTestCases no-op");
    return [];
  }

  async pushTestRun(
    projectKey: string,
    runName: string,
    _results: TestRailResult[],
  ): Promise<TestRailRunRef | null> {
    log.info({ projectKey, runName }, "xray client is a stub — pushTestRun no-op");
    return null;
  }
}

// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    return `${status ?? "?"} ${typeof data === "string" ? data : JSON.stringify(data ?? err.message)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
