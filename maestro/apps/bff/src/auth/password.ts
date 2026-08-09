import { compare, hash } from "bcryptjs";
import { HttpError } from "../errors.js";

/**
 * Local password policy (M8). MVP identity only: once AD/LDAP is wired in
 * Aşama 2 the bank's own policy applies and this file stops being the
 * authority — which is why the rules are data, not scattered `if`s.
 */
export interface PasswordPolicy {
  minLength: number;
  /**
   * bcrypt hashes at most the first 72 BYTES of the input; anything past that
   * is silently ignored. Capping at 72 keeps "your password was accepted" and
   * "your password is checked" the same statement.
   */
  maxBytes: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxBytes: 72,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
};

export type PasswordViolation =
  | "too_short"
  | "too_long"
  | "no_upper"
  | "no_lower"
  | "no_digit"
  | "no_symbol"
  | "contains_username";

/** Every rule the candidate breaks, so the user is told once instead of five times. */
export function checkPassword(
  password: string,
  username: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  if (password.length < policy.minLength) violations.push("too_short");
  if (Buffer.byteLength(password, "utf8") > policy.maxBytes) violations.push("too_long");
  if (policy.requireUpper && !/\p{Lu}/u.test(password)) violations.push("no_upper");
  if (policy.requireLower && !/\p{Ll}/u.test(password)) violations.push("no_lower");
  if (policy.requireDigit && !/\p{Nd}/u.test(password)) violations.push("no_digit");
  if (policy.requireSymbol && !/[^\p{L}\p{Nd}]/u.test(password)) violations.push("no_symbol");

  const login = username.trim().toLowerCase().split("@")[0] ?? "";
  if (login.length >= 3 && password.toLowerCase().includes(login)) {
    violations.push("contains_username");
  }
  return violations;
}

export class PasswordPolicyError extends HttpError {
  constructor(readonly violations: readonly PasswordViolation[]) {
    super(400, "password_policy", { violations });
    this.name = "PasswordPolicyError";
  }
}

export function assertPassword(
  password: string,
  username: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): void {
  const violations = checkPassword(password, username, policy);
  if (violations.length > 0) throw new PasswordPolicyError(violations);
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, storedHash: string): Promise<boolean>;
  /**
   * Burn the same work as a real verification when there is no user to check
   * against, so "unknown account" and "wrong password" cannot be told apart by
   * a stopwatch.
   */
  burn(): Promise<void>;
}

/**
 * bcrypt (M8), through the pure-JavaScript implementation: the BFF image is a
 * hardened multi-stage build with no toolchain, and a native addon would have
 * to be compiled there. See RAPOR for the dependency justification.
 */
export class BcryptPasswordHasher implements PasswordHasher {
  /** A real bcrypt hash of a value no one can present; cost is irrelevant to it. */
  private readonly dummy: string;

  constructor(private readonly rounds = 12) {
    // Pre-computed at cost 10 for "…"; only its shape and cost matter.
    this.dummy = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
  }

  hash(password: string): Promise<string> {
    return hash(password, this.rounds);
  }

  verify(password: string, storedHash: string): Promise<boolean> {
    return compare(password, storedHash);
  }

  async burn(): Promise<void> {
    await compare("maestro-timing-equaliser", this.dummy);
  }
}
