import { OPERATION_SCHEMAS } from "./generated/schemas.js";

/** What the spec says a path parameter may hold. */
export interface PathParamRule {
  /** The JSON type, like "string" or "integer"; "a|b" when it can be either. */
  type?: string;
  enum?: readonly string[];
}

/** Coolify uuids, names, hostnames, registries and GitHub owners and repos. */
const SAFE = /^[A-Za-z0-9_.:@~-]+$/;
const DOTS_ONLY = /^\.+$/;
const DIGITS = /^\d{1,18}$/;
const UNSAFE_CHAR = /[/\\\u0000-\u001f\u007f]/;

/**
 * Why a path parameter value is refused, or null when it is safe to put in a
 * Coolify path. A value must stay one path segment: no empty or dot-only
 * value (fetch would resolve "." and ".." and move the request to another
 * endpoint), no slash, backslash or control character, a listed value when
 * the spec has an enum, digits for an integer, and otherwise only
 * `A-Z a-z 0-9 _ . : @ ~ -`, so no percent-encoded dot or slash either. The
 * message names the parameter, never the value.
 */
export function pathParamProblem(
  name: string,
  value: unknown,
  rule: PathParamRule = {},
): string | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return `${name} must be a whole number`;
    }
    text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    return `${name} must be text or a number`;
  }
  if (text === "") return `${name} is required`;
  if (DOTS_ONLY.test(text)) return `${name} can't be only dots`;
  if (UNSAFE_CHAR.test(text)) {
    return `${name} can't hold a slash, backslash or control character`;
  }
  if (rule.enum?.length) {
    return rule.enum.includes(text)
      ? null
      : `${name} must be one of ${rule.enum.join(", ")}`;
  }
  const kinds = (rule.type ?? "string").split("|");
  if (kinds.every((kind) => kind === "integer")) {
    return DIGITS.test(text) ? null : `${name} must be a whole number`;
  }
  return SAFE.test(text)
    ? null
    : `${name} may only hold letters, digits and _ . : @ ~ -`;
}

/** The path parameter rules of a vendored operation, by name. */
export function pathRules(operationId: string): Record<string, PathParamRule> {
  const rules: Record<string, PathParamRule> = {};
  for (const param of OPERATION_SCHEMAS[operationId]?.params ?? []) {
    if (param.in === "path") {
      rules[param.name] = { type: param.type, enum: param.enum };
    }
  }
  return rules;
}

/**
 * Fills a vendored path template, each value checked by pathParamProblem.
 * `fail` makes the caller's own error, so nothing is sent on a bad value.
 */
export function fillPath(
  template: string,
  params: Record<string, unknown>,
  rules: Readonly<Record<string, PathParamRule>>,
  fail: (message: string) => Error,
): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw fail(`${name} is required`);
    }
    const problem = pathParamProblem(name, value, rules[name]);
    if (problem) throw fail(problem);
    return encodeURIComponent(String(value));
  });
}
