import type { MaloAssertCheck, MaloAssertInput } from "../../shared/malo";

export type MaloAssertState = {
  url: string;
  title: string;
  visible: boolean | null;
  hidden_visible: boolean | null;
  text: boolean | null;
  value: string | null;
  count: number | null;
  invalid_selector: string | null;
};

export function buildAssertChecks(
  input: MaloAssertInput,
  state: MaloAssertState,
): MaloAssertCheck[] {
  const checks: MaloAssertCheck[] = [];
  if (input.visible !== undefined) {
    checks.push({
      kind: "visible",
      expected: true,
      actual: state.visible,
      ok: state.visible === true,
    });
  }
  if (input.hidden !== undefined) {
    checks.push({
      kind: "hidden",
      expected: false,
      actual: state.hidden_visible,
      ok: state.hidden_visible === false,
    });
  }
  if (input.text !== undefined) {
    checks.push({
      kind: "text",
      expected: input.text,
      actual: state.text,
      ok: state.text === true,
    });
  }
  if (input.value !== undefined) {
    checks.push({
      kind: "value",
      expected: input.value,
      actual: state.value,
      ok: state.value === input.value,
    });
  }
  if (input.url !== undefined) {
    checks.push({
      kind: "url",
      expected: input.url,
      actual: state.url,
      ok: state.url.includes(input.url),
    });
  }
  if (input.count !== undefined) {
    checks.push({
      kind: "count",
      expected: input.count,
      actual: state.count,
      ok: state.count === input.count,
    });
  }
  return checks;
}

export function describeAssertFailure(checks: MaloAssertCheck[]): string {
  return checks
    .filter((check) => !check.ok)
    .map(
      (check) =>
        `${check.kind} expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`,
    )
    .join("; ");
}
