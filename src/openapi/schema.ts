export type Schema = Record<string, unknown>;

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
  if (NUMBER.test(value) && !/^0\d/.test(value))
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
      const schemaProperties = (schema.properties ?? {}) as Record<
        string,
        Schema
      >;
      const required = new Set(
        (Array.isArray(schema.required) ? schema.required : []) as string[],
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
    const itemSchemas = items.map((schema) => (schema.items ?? {}) as Schema);
    return { type: "array", items: mergeSchemas(itemSchemas) };
  }

  // Numeric widening keeps the document readable instead of emitting a union.
  const normalized = allTypes.includes("number")
    ? allTypes.filter((type) => type !== "integer")
    : allTypes;
  const formats = [
    ...new Set(
      items
        .map((schema) => schema.format)
        .filter((format): format is string => typeof format === "string"),
    ),
  ];

  return {
    type: normalized.length === 1 ? normalized[0]! : normalized,
    ...(normalized.length === 1 && formats.length === 1
      ? { format: formats[0] }
      : {}),
  };
}
