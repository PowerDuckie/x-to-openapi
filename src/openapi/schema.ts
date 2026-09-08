/**
 * Structural JSON Schema subset used for inferred request/response bodies.
 * Kept as an interface (not Record<string, unknown>) so property access is
 * type-checked; the index signature permits OpenAPI extensions and fields
 * we do not explicitly model.
 */
export interface Schema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  example?: unknown;
  contentMediaType?: string;
  description?: string;
  nullable?: boolean;
  /** OpenAPI extensions and any unmodeled fields. */
  [key: string]: unknown;
}

const INTEGER = /^[-+]?(?:0|[1-9]\d*)$/;
const NUMBER = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:e[-+]?\d+)?$/i;
const BOOLEAN = /^(?:true|false)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_INTEGER_LENGTH = 15;

/** Infers a schema from a single string sample. Conservative by design. */
export function scalar(value: string, includeExample = false): Schema {
  const example = includeExample ? { example: value } : {};

  if (BOOLEAN.test(value)) return { type: "boolean", ...example };
  if (UUID.test(value)) return { type: "string", format: "uuid", ...example };
  if (DATE_TIME.test(value))
    return { type: "string", format: "date-time", ...example };
  if (DATE.test(value)) return { type: "string", format: "date", ...example };

  // "007" and long digit runs (snowflake ids, phone numbers) stay strings.
  if (
    INTEGER.test(value) &&
    value.replace(/^[-+]/, "").length <= SAFE_INTEGER_LENGTH
  ) {
    return { type: "integer", ...example };
  }
  if (
    NUMBER.test(value) &&
    !/^0\d/.test(value) &&
    value.replace(/^[-+]/, "").replace(/[.eE].*$/, "").length <=
      SAFE_INTEGER_LENGTH
  )
    return { type: "number", ...example };

  return { type: "string", ...example };
}

export function jsonSchema(value: unknown, includeExample = false): Schema {
  if (value === null) return { type: "null" };

  if (Array.isArray(value)) {
    return {
      type: "array",
      items:
        value.length === 0
          ? {}
          : mergeSchemas(value.map((item) => jsonSchema(item, includeExample))),
    };
  }

  if (typeof value === "object") {
    const properties: Record<string, Schema> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      properties[key] = jsonSchema(child, includeExample);
    }
    const required = Object.keys(properties);
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };
  }

  if (typeof value === "number") {
    return {
      type: Number.isInteger(value) ? "integer" : "number",
      ...(includeExample ? { example: value } : {}),
    };
  }
  if (typeof value === "boolean") return { type: "boolean" };

  return {
    type: "string",
    ...(includeExample && typeof value === "string" ? { example: value } : {}),
  };
}

function types(schema: Schema): string[] {
  const type = schema.type;
  return Array.isArray(type)
    ? type.filter((item): item is string => typeof item === "string")
    : typeof type === "string"
      ? [type]
      : [];
}

/**
 * Structurally merges samples of the same entity.
 * Object properties union; a property missing from any sample becomes optional.
 */
export function mergeSchemas(schemas: readonly Schema[]): Schema {
  const items = schemas.filter((schema) => Object.keys(schema).length > 0);

  if (items.length === 0) return {};
  if (items.length === 1) return { ...items[0]! };

  const allTypes = [...new Set(items.flatMap(types))];

  if (allTypes.length === 1 && allTypes[0] === "object") {
    const properties: Record<string, Schema[]> = {};
    const requiredCounts = new Map<string, number>();

    for (const schema of items) {
      const schemaProperties = schema.properties ?? {};
      const required = new Set(
        Array.isArray(schema.required) ? schema.required : [],
      );

      for (const [key, child] of Object.entries(schemaProperties)) {
        (properties[key] ??= []).push(child);
        if (required.has(key))
          requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
      }
    }

    const merged: Record<string, Schema> = {};
    for (const [key, samples] of Object.entries(properties))
      merged[key] = mergeSchemas(samples);

    const required = Object.keys(merged).filter(
      (key) => requiredCounts.get(key) === items.length,
    );

    return {
      type: "object",
      properties: merged,
      ...(required.length ? { required } : {}),
    };
  }

  if (allTypes.length === 1 && allTypes[0] === "array") {
    const itemSchemas = items.map((schema) => schema.items ?? {});
    return { type: "array", items: mergeSchemas(itemSchemas) };
  }

  // Numeric widening keeps the document readable instead of emitting a union.
  const normalized = allTypes.includes("number")
    ? allTypes.filter((type) => type !== "integer")
    : allTypes;

  // Keep format only when every sample declares the same one.
  const formatValues = items.map((schema) => schema.format);
  const allHaveFormat = formatValues.every(
    (f) => typeof f === "string",
  );
  const uniqueFormats = [...new Set(formatValues.filter((f): f is string => typeof f === "string"))];

  return {
    type: normalized.length === 1 ? normalized[0]! : normalized,
    ...(allHaveFormat && uniqueFormats.length === 1
      ? { format: uniqueFormats[0] }
      : {}),
  };
}
