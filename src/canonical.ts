export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * One byte form per value: sorted keys, no whitespace, safe integers only.
 * Signatures cover these bytes, so a second encoding of the same value must
 * be impossible; floats are refused because their text form is not unique.
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`canonical JSON allows only safe integers, got ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as { readonly [key: string]: Json };
  if (Object.hasOwn(record, "__proto__")) {
    // JSON.parse makes this an own key; any later spread or assign by a
    // consumer would turn it into prototype pollution.
    throw new TypeError("canonical JSON refuses a __proto__ key");
  }
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key] as Json)}`);
  return `{${members.join(",")}}`;
}
