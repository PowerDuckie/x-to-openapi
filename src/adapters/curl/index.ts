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

  const apiKey = headers.find((header) => /^x-api-key$/i.test(header.name));
  return apiKey
    ? { type: "apiKey", in: "header", name: apiKey.name }
    : undefined;
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

    if (backend.kind === "json") {
      context.report({
        code: "CURL_BACKEND_JSON_FALLBACK",
        severity: "info",
        source: this.id,
        message:
          "curlconverter.toHar() is unavailable; using the JSON generator. Upgrade to curlconverter >= 4 for richer multipart metadata.",
      });
    }

    const requests: NormalizedRequest[] = [];

    for (const [sourceIndex, command] of sources.entries()) {
      try {
        const raw = backend.convert(command);

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

        requests.push({
          source: this.id,
          sourceIndex,
          method: normalizeMethod(raw.method),
          url,
          headers,
          query,
          cookies: parseCookies(headers),
          body: buildBody({ ...raw, headers }),
          auth: detectAuth(command, headers, raw),
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
