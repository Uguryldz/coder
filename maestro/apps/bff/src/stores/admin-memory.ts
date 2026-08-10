import type {
  ConnectionView,
  NotifyDriverView,
  RoutingProjectView,
  RoutingReader,
  RoutingRuleView,
  SettingsReader,
} from "../deps.js";

/**
 * Reference implementations of the two admin read seams, for tests and for the
 * dev compose.
 *
 * They answer from a list they were GIVEN. That is the whole design: a fake
 * that invented a plausible connection table would make a test pass against
 * data no deployment has, and the composition root would still be free to ship
 * without wiring the real reader. Constructed empty they answer empty, and the
 * screens render "nothing configured" — which is the truth about a store
 * holding nothing, and is why the composition root uses the Postgres-backed
 * and environment-backed readers instead of these.
 */

export class StaticSettingsReader implements SettingsReader {
  constructor(
    private readonly connectionRows: readonly ConnectionView[] = [],
    private readonly driverRows: readonly NotifyDriverView[] = [],
  ) {}

  connections(): Promise<readonly ConnectionView[]> {
    return Promise.resolve(this.connectionRows.map((row) => ({ ...row })));
  }

  notifyDrivers(): Promise<readonly NotifyDriverView[]> {
    return Promise.resolve(this.driverRows.map((row) => ({ ...row })));
  }
}

export class StaticRoutingReader implements RoutingReader {
  constructor(
    private readonly projectRows: readonly RoutingProjectView[] = [],
    private readonly ruleRows: readonly RoutingRuleView[] = [],
  ) {}

  projects(): Promise<readonly RoutingProjectView[]> {
    return Promise.resolve(this.projectRows.map((row) => ({ ...row, apps: [...row.apps] })));
  }

  rules(): Promise<readonly RoutingRuleView[]> {
    return Promise.resolve(this.ruleRows.map((row) => ({ ...row })));
  }
}
