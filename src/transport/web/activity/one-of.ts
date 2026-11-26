export function isOneOf<Value extends string>(values: readonly Value[], value: string | null): value is Value {
  return values.some((candidate) => candidate === value);
}
