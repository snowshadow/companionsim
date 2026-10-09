import { parseDocument, stringify } from "yaml";

/** YAML aliases and duplicate keys are rejected, not silently expanded/overwritten. */
export function parseNacosDocument(content: string): unknown {
  const parsed = parseDocument(content, { uniqueKeys: true, strict: true });
  if (parsed.errors.length || parsed.warnings.length) throw new Error("invalid_yaml");
  return parsed.toJS({ maxAliasCount: 0 });
}
export function serializeNacosDocument(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}
