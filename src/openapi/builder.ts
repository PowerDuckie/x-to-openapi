import type {
  Diagnostic,
  Header,
  NormalizedRequest,
  OpenApiDocument,
  ParameterValue,
  RequestAuth,
  RequestBody,
  ResolvedConvertOptions,
} from "../core/types.js";
import { operationId, tagFor } from "./naming.js";
import { buildPathTemplates } from "./paths.js";
import { jsonSchema, mergeSchemas, scalar, type Schema } from "./schema.js";

const STANDARD_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
]);

/** Transport noise: never useful as an OpenAPI parameter. */
const TRANSPORT_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "upgrade-insecure-requests",
  "expect",
  "content-type",
  "authorization",
  "cookie",
]);

/** Browser noise: excluded unless includeCommonHeaders is set. */
const BROWSER_HEADERS = [
  /^accept$/,
  /^accept-(?:encoding|language|charset)$/,
  /^user-agent$/,
  /^referer$/,
  /^origin$/,
  /^dnt$/,
  /^pragma$/,
  /^cache-control$/,
  /^priority$/,
  /^sec-/,
  /^if-(?:none-match|modified-since)$/,
];

type ParameterLocation = "path" | "query" | "header" | "cookie";

interface ParameterAccumulator {
  name: string;
  in: ParameterLocation;
  required: boolean;
  explode: boolean;
  samples: Schema[];
}

interface OperationAccumulator {
  method: string;
  path: string;
  origins: Set<string>;
  parameters: Map<string, ParameterAccumulator>;
  bodies: Map<string, Schema[]>;
  auth: Set<string>;
  samples: number;
}

function isDocumentedHeader(header: Header, includeCommon: boolean): boolean {
  const name = header.name.toLowerCase();
  if (TRANSPORT_HEADERS.has(name)) return false;
  if (includeCommon) return true;
  return !BROWSER_HEADERS.some((pattern) => pattern.test(name));
}

function bodySchema(
  body: RequestBody,
  includeExamples: boolean,
  report: (diagnostic: Diagnostic) => void,
  request: NormalizedRequest,
): { mediaType: string; schema: Schema } {
  if (body.kind === "json") {
    try {
      return {
        mediaType: body.mediaType,
        schema: jsonSchema(JSON.parse(body.raw ?? "null"), includeExamples),
      };
    } catch (cause) {
      report({
        code: "BODY_JSON_INVALID",
        severity: "warning",
        source: request.source,
        index: request.sourceIndex,
        message: `Body declared as ${body.mediaType} is not valid JSON; documented as text/plain.`,
        cause,
      });
      // Keep media type honest rather than pairing a string schema with a JSON type.
      return { mediaType: "text/plain", schema: { type: "string" } };
    }
  }

  if (body.kind === "multipart" || body.kind === "form-urlencoded") {
    const properties: Record<string, Schema> = {};
    const required: string[] = [];

    for (const field of body.fields ?? []) {
      properties[field.name] = field.fileName
        ? {
            type: "string",
            format: "binary",
            ...(field.contentType
              ? { contentMediaType: field.contentType }
              : {}),
          }
        : scalar(field.value ?? "", includeExamples);
      required.push(field.name);
    }

    if (Object.keys(properties).length === 0 && body.raw) {
      for (const [name, value] of new URLSearchParams(body.raw).entries()) {
        properties[name] = scalar(value, includeExamples);
        required.push(name);
      }
    }

    return {
      mediaType: body.mediaType,
      schema: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    };
  }

  if (body.kind === "binary")
    return {
      mediaType: body.mediaType,
      schema: { type: "string", format: "binary" },
    };

  return {
    mediaType: body.mediaType,
    schema: {
      type: "string",
      ...(includeExamples && body.raw ? { example: body.raw } : {}),
    },
  };
}

function securitySchemeName(auth: RequestAuth): string {
  if (auth.type === "bearer") return "bearerAuth";
  if (auth.type === "basic") return "basicAuth";
  return "apiKeyAuth";
}

function collect(
  accumulator: OperationAccumulator,
  location: ParameterLocation,
  values: readonly ParameterValue[],
  includeExamples: boolean,
): void {
  const counts = new Map<string, number>();
  for (const value of values)
    counts.set(value.name, (counts.get(value.name) ?? 0) + 1);

  for (const value of values) {
    const key = `${location}:${value.name}`;
    const repeated = (counts.get(value.name) ?? 0) > 1;

    const existing = accumulator.parameters.get(key) ?? {
      name: value.name,
      in: location,
      required: location === "path",
      explode: repeated,
      samples: [],
    };

    existing.explode ||= repeated;
    existing.samples.push(scalar(value.value, includeExamples));
    accumulator.parameters.set(key, existing);
  }
}

export function buildOpenApi32(
  requests: readonly NormalizedRequest[],
  options: ResolvedConvertOptions,
  report: (diagnostic: Diagnostic) => void,
): OpenApiDocument {
  if (requests.length === 0) {
    report({
      code: "NO_REQUESTS",
      severity: "warning",
      message: "No requests to convert; emitting an empty document.",
    });
  }

  const origins = [...new Set(requests.map((request) => request.url.origin))];

  if (origins.length > 1) {
    report({
      code: "MULTIPLE_SERVERS",
      severity: "warning",
      message: `Requests span ${origins.length} origins (${origins.join(", ")}); all operations are merged under one paths object.`,
    });
  }

  const templates = buildPathTemplates(
    requests,
    options.pathParameterMinSamples,
    options.inferPathParameters,
  );
  const operations = new Map<string, OperationAccumulator>();
  const schemes = new Map<string, Record<string, unknown>>();

  for (const request of requests) {
    const template = templates.get(request.sourceIndex) ?? {
      path: request.url.pathname || "/",
      parameters: new Map(),
    };
    const key = `${template.path}\u0000${request.method}`;

    const accumulator: OperationAccumulator = operations.get(key) ?? {
      method: request.method,
      path: template.path,
      origins: new Set(),
      parameters: new Map(),
      bodies: new Map(),
      auth: new Set(),
      samples: 0,
    };

    accumulator.samples += 1;
    accumulator.origins.add(request.url.origin);

    if (accumulator.origins.size > 1) {
      report({
        code: "PATH_MERGE_CONFLICT",
        severity: "warning",
        path: template.path,
        message: `${request.method.toUpperCase()} ${template.path} is served by multiple origins; parameter samples were merged.`,
      });
    }

    const actualSegments = request.url.pathname.split("/");
    const pathValues: ParameterValue[] = [...template.parameters.entries()].map(
      ([index, name]) => ({
        name,
        value: actualSegments[index] ?? "",
      }),
    );

    collect(accumulator, "path", pathValues, options.includeExamples);
    collect(accumulator, "query", request.query, options.includeExamples);
    collect(
      accumulator,
      "header",
      request.headers.filter((header) =>
        isDocumentedHeader(header, options.includeCommonHeaders),
      ),
      options.includeExamples,
    );

    if (options.includeCookies)
      collect(accumulator, "cookie", request.cookies, options.includeExamples);

    if (request.body) {
      const { mediaType, schema } = bodySchema(
        request.body,
        options.includeExamples,
        report,
        request,
      );
      const bucket = accumulator.bodies.get(mediaType);
      if (bucket) bucket.push(schema);
      else accumulator.bodies.set(mediaType, [schema]);
    }

    if (options.inferSecurity && request.auth) {
      const name = securitySchemeName(request.auth);
      accumulator.auth.add(name);

      if (request.auth.type === "apiKey") {
        schemes.set(name, {
          type: "apiKey",
          in: request.auth.in,
          name: request.auth.name,
        });
      } else {
        schemes.set(name, { type: "http", scheme: request.auth.type });
      }
    }

    operations.set(key, accumulator);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const usedOperationIds = new Set<string>();

  for (const accumulator of [...operations.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const id = operationId(
      accumulator.method,
      accumulator.path,
      usedOperationIds,
    );
    usedOperationIds.add(id);

    const parameters = [...accumulator.parameters.values()].map(
      (parameter) => ({
        name: parameter.name,
        in: parameter.in,
        ...(parameter.required ? { required: true } : {}),
        ...(parameter.explode ? { explode: true } : {}),
        schema: parameter.explode
          ? { type: "array", items: mergeSchemas(parameter.samples) }
          : mergeSchemas(parameter.samples),
      }),
    );

    const operation: Record<string, unknown> = {
      operationId: id,
      tags: [tagFor(accumulator.path)],
      responses: { default: { description: "Successful response" } },
    };

    if (parameters.length > 0) operation.parameters = parameters;

    if (accumulator.bodies.size > 0) {
      const content: Record<string, unknown> = {};
      for (const [mediaType, schemas] of accumulator.bodies)
        content[mediaType] = { schema: mergeSchemas(schemas) };
      operation.requestBody = {
        required: accumulator.bodies.size === 1,
        content,
      };
    }

    if (accumulator.auth.size > 0) {
      operation.security = [...accumulator.auth].map((name) => ({
        [name]: [],
      }));
    }

    const item = (paths[accumulator.path] ??= {});

    if (STANDARD_METHODS.has(accumulator.method)) {
      item[accumulator.method] = operation;
    } else {
      const additional = (item.additionalOperations ??= {}) as Record<
        string,
        unknown
      >;
      additional[accumulator.method.toUpperCase()] = operation;
    }
  }

  const servers =
    origins.length > 0 ? origins.map((url) => ({ url })) : [{ url: "/" }];

  return {
    openapi: "3.2.0",
    info: {
      title: options.title,
      version: options.version,
      ...(options.description ? { description: options.description } : {}),
    },
    servers,
    paths,
    ...(schemes.size > 0
      ? { components: { securitySchemes: Object.fromEntries(schemes) } }
      : {}),
  } as unknown as OpenApiDocument;
}
