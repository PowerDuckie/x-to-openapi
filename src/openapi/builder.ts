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
  /** OpenAPI extensions collected from requests; first-wins per key. */
  extensions: Map<string, unknown>;
}

function isDocumentedHeader(header: Header, includeCommon: boolean): boolean {
  const name = header.name.toLowerCase();
  if (TRANSPORT_HEADERS.has(name)) return false;
  if (includeCommon) return true;
  return !BROWSER_HEADERS.some((pattern) => pattern.test(name));
}

/**
 * Parses a raw multipart/form-data body when the backend did not provide
 * structured fields. Extracts the boundary from the media type and splits
 * parts, recovering name / filename / content-type per part.
 */
function parseMultipartRaw(
  raw: string,
  mediaType: string,
): { name: string; value?: string; fileName?: string; contentType?: string }[] {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(mediaType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return [];

  const delimiter = `--${boundary}`;
  const parts = raw.split(delimiter).slice(1, -1);
  const fields: {
    name: string;
    value?: string;
    fileName?: string;
    contentType?: string;
  }[] = [];

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerBlock = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, "");

    const disposition = /content-disposition:\s*form-data;/i.exec(headerBlock);
    if (!disposition) continue;

    const nameMatch = /name="([^"]*)"/i.exec(headerBlock);
    if (!nameMatch) continue;

    const fileNameMatch = /filename="([^"]*)"/i.exec(headerBlock);
    const contentTypeMatch = /content-type:\s*(\S+)/i.exec(headerBlock);

    fields.push({
      name: nameMatch[1]!,
      ...(fileNameMatch ? { fileName: fileNameMatch[1] } : {}),
      ...(contentTypeMatch ? { contentType: contentTypeMatch[1] } : {}),
      ...(!fileNameMatch ? { value: body } : {}),
    });
  }

  return fields;
}

function bodySchema(
  body: RequestBody,
  includeExamples: boolean,
  report: (diagnostic: Diagnostic) => void,
  request: NormalizedRequest,
): { mediaType: string; schema: Schema } {
  // Strip parameters like "; boundary=..." so the media type is a clean content key.
  const cleanMediaType = body.mediaType.split(";")[0]?.trim().toLowerCase() ?? body.mediaType;
  if (body.kind === "json") {
    try {
      return {
        mediaType: cleanMediaType,
        schema: jsonSchema(JSON.parse(body.raw ?? "null"), includeExamples),
      };
    } catch (cause) {
      report({
        code: "BODY_JSON_INVALID",
        severity: "warning",
        source: request.source,
        index: request.sourceIndex,
        message: `Body declared as ${cleanMediaType} is not valid JSON; documented as text/plain.`,
        cause,
      });
      return { mediaType: "text/plain", schema: { type: "string" } };
    }
  }

  if (body.kind === "multipart" || body.kind === "form-urlencoded") {
    const properties: Record<string, Schema> = {};
    const required: string[] = [];

    let fields = body.fields;

    // Fallback: parse raw body when structured fields are absent.
    if ((!fields || fields.length === 0) && body.raw) {
      if (body.kind === "multipart") {
        fields = parseMultipartRaw(body.raw, body.mediaType);
      } else {
        fields = [...new URLSearchParams(body.raw).entries()].map(
          ([name, value]) => ({ name, value }),
        );
      }
    }

    for (const field of fields ?? []) {
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

    return {
      mediaType: cleanMediaType,
      schema: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    };
  }

  if (body.kind === "binary")
    return {
      mediaType: cleanMediaType,
      schema: { type: "string", format: "binary" },
    };

  return {
    mediaType: cleanMediaType,
    schema: {
      type: "string",
      ...(includeExamples && body.raw ? { example: body.raw } : {}),
    },
  };
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "_");
}

function securitySchemeName(auth: RequestAuth): string {
  if (auth.type === "bearer") return "bearerAuth";
  if (auth.type === "basic") return "basicAuth";
  // Include location + name so distinct apiKey headers do not collide.
  return `apiKey_${auth.in}_${sanitizeIdentifier(auth.name)}`;
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

/**
 * Finds the longest common directory prefix across all pathnames.
 * Only splits at segment boundaries, so /api/v1/users and /api/v2/posts
 * share /api/ but not /api/v.
 */
function commonBasePath(pathnames: readonly string[]): string {
  if (pathnames.length === 0) return "";

  const segments = pathnames.map((p) => p.split("/").filter(Boolean));
  const minLength = Math.min(...segments.map((s) => s.length));
  const common: string[] = [];

  for (let i = 0; i < minLength; i += 1) {
    const value = segments[0]![i];
    if (segments.every((s) => s[i] === value)) common.push(value!);
    else break;
  }

  return common.length > 0 ? `/${common.join("/")}` : "";
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

  // When useServerBasePath is enabled and all requests share one origin,
  // collapse the common path prefix into servers[0] and strip it from paths.
  let basePath = "";
  if (
    options.useServerBasePath &&
    origins.length === 1 &&
    requests.length > 0
  ) {
    basePath = commonBasePath(
      requests.map((r) => r.url.pathname),
    );
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

    // Strip the common base path from the templated path.
    let operationPath = template.path;
    if (basePath && operationPath.startsWith(basePath)) {
      operationPath = operationPath.slice(basePath.length) || "/";
    }

    const key = `${operationPath}\u0000${request.method}`;

    const accumulator: OperationAccumulator = operations.get(key) ?? {
      method: request.method,
      path: operationPath,
      origins: new Set(),
      parameters: new Map(),
      bodies: new Map(),
      auth: new Set(),
      samples: 0,
      extensions: new Map(),
    };

    accumulator.samples += 1;
    accumulator.origins.add(request.url.origin);

    if (accumulator.origins.size > 1) {
      report({
        code: "PATH_MERGE_CONFLICT",
        severity: "warning",
        path: operationPath,
        message: `${request.method.toUpperCase()} ${operationPath} is served by multiple origins; parameter samples were merged.`,
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

    // Collect OpenAPI extensions; first-wins per key so the earliest
    // request in the batch sets the value.
    if (request.extensions) {
      for (const [key, value] of Object.entries(request.extensions)) {
        if (!accumulator.extensions.has(key)) {
          accumulator.extensions.set(key, value);
        }
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

    if (usedOperationIds.has(id)) {
      report({
        code: "OPERATION_ID_COLLISION",
        severity: "info",
        path: accumulator.path,
        message: `operationId "${id}" was already used; a numeric suffix was appended.`,
      });
    }
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

    // Merge collected OpenAPI extensions onto the operation.
    if (accumulator.extensions.size > 0) {
      for (const [key, value] of accumulator.extensions) {
        operation[key] = value;
      }
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
    origins.length > 0
      ? origins.map((origin) => ({ url: origin + basePath }))
      : [{ url: "/" }];

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
