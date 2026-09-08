import * as curlconverterNamespace from "curlconverter";

import type { FormField, Header, ParameterValue } from "../../core/types.js";

/** Canonical intermediate shape, independent of which generator produced it. */
export interface RawRequest {
  method?: string;
  url?: string;
  headers: Header[];
  query?: ParameterValue[];
  bodyText?: string;
  mimeType?: string;
  formFields?: FormField[];
  /** Recovered from `-u user:pass`, which the JSON generator exposes directly. */
  basicAuth?: boolean;
  bearerToken?: string;
}

export type BackendKind = "har" | "json";

export interface CurlBackend {
  readonly kind: BackendKind;
  convert(command: string): RawRequest;
}

type AnyFn = (input: string | string[]) => unknown;
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Unwraps ESM/CJS interop layers. A CJS build imported via `import *` nests the
 * real exports under `.default`, sometimes twice with certain bundlers.
 */
function candidates(): UnknownRecord[] {
  const seen = new Set<unknown>();
  const result: UnknownRecord[] = [];
  const queue: unknown[] = [curlconverterNamespace];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;

    seen.add(current);
    result.push(current);
    queue.push(current.default);
  }

  return result;
}

function findFunction(
  names: readonly string[],
): { name: string; fn: AnyFn } | undefined {
  for (const candidate of candidates()) {
    for (const name of names) {
      const value = candidate[name];
      if (typeof value === "function") return { name, fn: value as AnyFn };
    }
  }
  return undefined;
}

export function availableExports(): string[] {
  return [
    ...new Set(candidates().flatMap((candidate) => Object.keys(candidate))),
  ].sort();
}

/* ----------------------------- header parsing ----------------------------- */

/** Accepts HAR arrays, `{name,value}` arrays and plain `{header: value}` maps. */
function toHeaders(value: unknown): Header[] {
  const result: Header[] = [];

  const push = (name: unknown, headerValue: unknown): void => {
    if (!isString(name) || name.length === 0) return;
    if (headerValue === null || headerValue === undefined) return;
    result.push({ name, value: String(headerValue) });
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      if ("name" in item || "value" in item) push(item.name, item.value);
      else
        for (const [name, headerValue] of Object.entries(item))
          push(name, headerValue);
    }
    return result;
  }

  if (isRecord(value)) {
    for (const [name, headerValue] of Object.entries(value))
      push(name, headerValue);
  }

  return result;
}

function headerValue(
  headers: readonly Header[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value;
}

/* -------------------------------- HAR path -------------------------------- */

function fromHar(output: unknown): RawRequest {
  const parsed = isString(output) ? (JSON.parse(output) as unknown) : output;
  const log = isRecord(parsed) ? parsed.log : undefined;
  const entries = isRecord(log) ? log.entries : undefined;
  const first = Array.isArray(entries) ? entries[0] : undefined;
  const request = isRecord(first) ? first.request : undefined;

  if (!isRecord(request))
    throw new Error("curlconverter HAR output contained no request entry");

  const headers = toHeaders(request.headers);
  const postData = isRecord(request.postData) ? request.postData : undefined;

  const query = Array.isArray(request.queryString)
    ? request.queryString.flatMap((item) =>
        isRecord(item) && isString(item.name)
          ? [{ name: item.name, value: String(item.value ?? "") }]
          : [],
      )
    : undefined;

  const formFields = Array.isArray(postData?.params)
    ? postData!.params.flatMap((item) =>
        isRecord(item) && isString(item.name) ? [toFormField(item)] : [],
      )
    : undefined;

  return {
    method: isString(request.method) ? request.method : undefined,
    url: isString(request.url) ? request.url : undefined,
    headers,
    query: query && query.length > 0 ? query : undefined,
    bodyText:
      isString(postData?.text) && postData!.text.length > 0
        ? (postData!.text as string)
        : undefined,
    mimeType: isString(postData?.mimeType)
      ? (postData!.mimeType as string)
      : headerValue(headers, "content-type"),
    formFields: formFields && formFields.length > 0 ? formFields : undefined,
  };
}

function toFormField(item: UnknownRecord): FormField {
  const fileName = isString(item.fileName)
    ? item.fileName
    : isString(item.filename)
      ? item.filename
      : undefined;
  const contentType = isString(item.contentType)
    ? item.contentType
    : isString(item.mimeType)
      ? item.mimeType
      : undefined;

  return {
    name: item.name as string,
    ...(isString(item.value) ? { value: item.value } : {}),
    ...(fileName ? { fileName } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

/* -------------------------------- JSON path ------------------------------- */

function stripFilePrefix(value: string): string {
  return value.replace(/^[@<]/, "");
}

/** curlconverter 3.x `files` shape: `{ field: "@path" }` or `{ field: { file: "path" } }`. */
function jsonFormFields(
  files: unknown,
  data: unknown,
): FormField[] | undefined {
  const fields: FormField[] = [];

  if (isRecord(files)) {
    for (const [name, value] of Object.entries(files)) {
      if (isString(value))
        fields.push({ name, fileName: stripFilePrefix(value) });
      else if (isRecord(value)) {
        const file = isString(value.file)
          ? value.file
          : isString(value.filename)
            ? value.filename
            : undefined;
        const contentType = isString(value.content_type)
          ? value.content_type
          : undefined;
        fields.push({
          name,
          ...(file ? { fileName: stripFilePrefix(file) } : {}),
          ...(isString(value.content) ? { value: value.content } : {}),
          ...(contentType ? { contentType } : {}),
        });
      }
    }
  }

  // Multipart text parts sometimes land in `data` alongside `files`.
  if (isRecord(data)) {
    for (const [name, value] of Object.entries(data)) {
      if (isString(value)) fields.push({ name, value });
    }
  }

  return fields.length > 0 ? fields : undefined;
}

function jsonBodyText(data: unknown): string | undefined {
  if (isString(data)) return data.length > 0 ? data : undefined;

  if (isRecord(data)) {
    const entries = Object.entries(data);
    // `{ "{\"a\":1}": null }` is how the JSON generator represents a raw body.
    if (
      entries.length === 1 &&
      entries[0]![1] === null &&
      isString(entries[0]![0])
    )
      return entries[0]![0];

    try {
      return JSON.stringify(data);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function fromJson(output: unknown): RawRequest {
  const parsed = isString(output) ? (JSON.parse(output) as unknown) : output;

  if (!isRecord(parsed))
    throw new Error("curlconverter JSON output was not an object");

  // Some versions key the result by URL; unwrap a single-entry envelope.
  const record = "url" in parsed || "raw_url" in parsed ? parsed : undefined;
  const inner =
    record ??
    (Object.values(parsed).find(
      (value) => isRecord(value) && "url" in value,
    ) as UnknownRecord | undefined);

  if (!inner) throw new Error("curlconverter JSON output contained no url");

  const headers = toHeaders(inner.headers);
  const formFields = jsonFormFields(
    inner.files,
    inner.multipart_data ?? (inner.files ? inner.data : undefined),
  );
  const bodyText = formFields ? undefined : jsonBodyText(inner.data);

  const auth = inner.auth;
  const bearer = isString(inner.oauth2_bearer)
    ? inner.oauth2_bearer
    : undefined;

  const queries = isRecord(inner.queries) ? inner.queries : undefined;
  const query = queries
    ? Object.entries(queries).flatMap(([name, value]) =>
        Array.isArray(value)
          ? value.map((item) => ({ name, value: String(item) }))
          : [{ name, value: String(value ?? "") }],
      )
    : undefined;

  return {
    method: isString(inner.method) ? inner.method : undefined,
    url: isString(inner.url)
      ? inner.url
      : isString(inner.raw_url)
        ? inner.raw_url
        : undefined,
    headers,
    query: query && query.length > 0 ? query : undefined,
    bodyText,
    mimeType: headerValue(headers, "content-type"),
    formFields,
    basicAuth: Array.isArray(auth) && auth.length > 0 ? true : undefined,
    bearerToken: bearer,
  };
}

/* -------------------------------- resolver -------------------------------- */

let cached: CurlBackend | null | undefined;

export function resolveBackend(): CurlBackend | undefined {
  if (cached !== undefined) return cached ?? undefined;

  const har = findFunction(["toHar", "toHarString"]);

  if (har) {
    cached = { kind: "har", convert: (command) => fromHar(har.fn(command)) };
    return cached;
  }

  const json = findFunction(["toJsonString", "toJson", "toJsonObject"]);

  if (json) {
    cached = { kind: "json", convert: (command) => fromJson(json.fn(command)) };
    return cached;
  }

  cached = null;
  return undefined;
}

/** Test-only: clears the memoized backend. */
export function resetBackend(): void {
  cached = undefined;
}
