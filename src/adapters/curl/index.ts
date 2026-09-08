import type {
  AdapterContext,
  FormField,
  Header,
  NormalizedRequest,
  ParameterValue,
  RequestAuth,
  RequestBody,
  SourceAdapter,
} from "../../core/types.js";
import {
  availableExports,
  resolveBackend,
  type RawRequest,
} from "./backend.js";
import { splitCurlCommands } from "./split.js";

export { splitCurlCommands };
export { resolveBackend, availableExports, resetBackend } from "./backend.js";

const DEFAULT_MEDIA_TYPE: Record<string, string> = {
  json: "application/json",
  xml: "application/xml",
  multipart: "multipart/form-data",
  "form-urlencoded": "application/x-www-form-urlencoded",
  text: "text/plain",
  binary: "application/octet-stream",
};

/** Common query parameter names that carry API keys. */
const API_KEY_QUERY_NAMES = new Set([
  "api_key",
  "apikey",
  "api-key",
  "key",
  "token",
  "access_token",
  "accesstoken",
  "app_id",
  "appid",
]);

function normalizeMethod(value: string | undefined): string {
  const token = value?.trim() ?? "";
  return token === "" ? "get" : token.toLowerCase();
}

function normalizeMediaType(value: string | undefined): string | undefined {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  return mediaType || undefined;
}

function getHeader(
  headers: readonly Header[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value;
}

function classify(
  mediaType: string | undefined,
  fields: readonly FormField[] | undefined,
): RequestBody["kind"] {
  if (mediaType === "application/json" || mediaType?.endsWith("+json"))
    return "json";
  if (
    mediaType === "application/xml" ||
    mediaType === "text/xml" ||
    mediaType?.endsWith("+xml")
  )
    return "xml";
  if (mediaType === "application/x-www-form-urlencoded")
    return "form-urlencoded";
  if (mediaType === "multipart/form-data") return "multipart";
  if (mediaType?.startsWith("text/")) return "text";
  if (!mediaType && fields?.length) return "multipart";
  return "binary";
}

function buildBody(raw: RawRequest): RequestBody | undefined {
  if (!raw.bodyText && !raw.formFields) return undefined;

  const declared = normalizeMediaType(raw.mimeType);
  const kind = classify(declared, raw.formFields);

  return {
    kind,
    mediaType: declared ?? DEFAULT_MEDIA_TYPE[kind]!,
    ...(raw.bodyText ? { raw: raw.bodyText } : {}),
    ...(raw.formFields ? { fields: raw.formFields } : {}),
  };
}

const USER_FLAG =
  /(?:^|\s)(?:-u|--user)(?:[\s=]+|(?=\w))(?:'[^']*'|"[^"]*"|\S+)/;
const BEARER_FLAG = /(?:^|\s)--oauth2-bearer[\s=]+(?:'[^']*'|"[^"]*"|\S+)/;

function detectAuth(
  command: string,
  headers: readonly Header[],
  query: readonly ParameterValue[],
  raw: RawRequest,
): RequestAuth | undefined {
  const authorization = getHeader(headers, "authorization") ?? "";

  if (
    raw.bearerToken ||
    /^bearer\s+\S/i.test(authorization) ||
    BEARER_FLAG.test(command)
  )
    return { type: "bearer" };
  if (
    raw.basicAuth ||
    /^basic\s+\S/i.test(authorization) ||
    USER_FLAG.test(command)
  )
    return { type: "basic" };

  const apiKeyHeader = headers.find((header) =>
    /^x-api-key$/i.test(header.name),
  );
  if (apiKeyHeader)
    return { type: "apiKey", in: "header", name: apiKeyHeader.name };

  const apiKeyQuery = query.find((param) =>
    API_KEY_QUERY_NAMES.has(param.name.toLowerCase()),
  );
  if (apiKeyQuery)
    return { type: "apiKey", in: "query", name: apiKeyQuery.name };

  return undefined;
}

function parseCookies(headers: readonly Header[]): ParameterValue[] {
  const raw = getHeader(headers, "cookie");
  if (!raw) return [];

  return raw
    .split(/;\s*/)
    .flatMap((pair) => {
      const separator = pair.indexOf("=");
      return separator > 0
        ? [
            {
              name: pair.slice(0, separator).trim(),
              value: pair.slice(separator + 1),
            },
          ]
        : [];
    })
    .filter((cookie) => cookie.name.length > 0);
}

const FORM_FLAG = /(?:^|\s)(?:-F|--form|--form-string)(?:[\s=]|$)/;

function hasFormFlag(command: string): boolean {
  return FORM_FLAG.test(command);
}

/**
 * Post-processes a raw request when the command used -F/--form but the
 * backend did not emit a content-type or structured fields (common with
 * text-only multipart where curlconverter puts fields into `data`).
 */
function normalizeMultipart(raw: RawRequest, command: string): RawRequest {
  if (!hasFormFlag(command)) return raw;

  const mimeType = raw.mimeType ?? "multipart/form-data";

  // If the backend already produced form fields, just ensure the media type.
  if (raw.formFields && raw.formFields.length > 0) {
    return { ...raw, mimeType };
  }

  // Text-only multipart: bodyText is JSON-serialized data from curlconverter.
  if (raw.bodyText) {
    try {
      const parsed = JSON.parse(raw.bodyText);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((v) => typeof v === "string")
      ) {
        return {
          ...raw,
          mimeType,
          bodyText: undefined,
          formFields: Object.entries(parsed).map(([name, value]) => ({
            name,
            value: String(value),
          })),
        };
      }
    } catch {
      // Not JSON; leave as-is.
    }
  }

  return { ...raw, mimeType };
}

export class CurlAdapter implements SourceAdapter<string | readonly string[]> {
  readonly id = "curl";

  canHandle(input: unknown): boolean {
    const first = Array.isArray(input) ? input[0] : input;
    return (
      typeof first === "string" &&
      /^\s*(?:[$#>]\s*)?curl(?:\.exe)?\b/.test(first)
    );
  }

  async parse(
    input: string | readonly string[],
    context: AdapterContext,
  ): Promise<NormalizedRequest[]> {
    const sources = (Array.isArray(input) ? input : [input as string])
      .filter((item): item is string => typeof item === "string")
      .flatMap(splitCurlCommands);

    if (sources.length === 0) {
      context.report({
        code: "CURL_EMPTY_INPUT",
        severity: "warning",
        source: this.id,
        message: "No curl command found in the provided input.",
      });
      return [];
    }

    const backend = resolveBackend();

    if (!backend) {
      context.report({
        code: "CURL_CAPABILITY_MISSING",
        severity: "error",
        source: this.id,
        message: `No usable curlconverter generator found. Available exports: ${availableExports().join(", ") || "(none)"}.`,
      });
      return [];
    }

    if (backend.kind === "har") {
      context.report({
        code: "CURL_BACKEND_JSON_FALLBACK",
        severity: "info",
        source: this.id,
        message:
          "Using the HAR generator (JSON generator unavailable). Multipart form fields may be incomplete.",
      });
    }

    const requests: NormalizedRequest[] = [];

    for (const [sourceIndex, command] of sources.entries()) {
      try {
        let raw = backend.convert(command);

        // Fix up multipart requests that the backend under-specified.
        raw = normalizeMultipart(raw, command);

        if (!raw.url) throw new Error("curlconverter produced no request URL");

        const url = new URL(raw.url);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
          context.report({
            code: "CURL_UNSUPPORTED_SCHEME",
            severity: "warning",
            source: this.id,
            index: sourceIndex,
            message: `Skipping non-HTTP request (${url.protocol}).`,
          });
          continue;
        }

        const headers: Header[] = [];

        for (const header of raw.headers) {
          if (header.name.startsWith(":")) {
            context.report({
              code: "PSEUDO_HEADER_DROPPED",
              severity: "info",
              source: this.id,
              index: sourceIndex,
              message: `Dropped HTTP/2 pseudo-header "${header.name}".`,
            });
            continue;
          }
          headers.push(header);
        }

        const query =
          raw.query ??
          [...url.searchParams.entries()].map(([name, value]) => ({
            name,
            value,
          }));

        const body = buildBody({ ...raw, headers });
        const auth = detectAuth(command, headers, query, raw);

        requests.push({
          source: this.id,
          sourceIndex,
          method: normalizeMethod(raw.method),
          url,
          urlString: url.toString(),
          headers,
          query,
          cookies: parseCookies(headers),
          body,
          auth,
        });
      } catch (cause) {
        context.report({
          code: "CURL_PARSE_FAILED",
          severity: "error",
          source: this.id,
          index: sourceIndex,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }
    }

    return requests;
  }
}
