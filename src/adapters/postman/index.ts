import type {
  AdapterContext,
  Header,
  NormalizedRequest,
  ParameterValue,
  RequestAuth,
  RequestBody,
  SourceAdapter,
} from "../../core/types.js";
import {
  isFolder,
  isRequestItem,
  type PostmanAuth,
  type PostmanBody,
  type PostmanCollection,
  type PostmanEvent,
  type PostmanFormDataParam,
  type PostmanHeader,
  type PostmanItem,
  type PostmanQueryParam,
  type PostmanRequest,
  type PostmanUrl,
  type PostmanUrlEncodedParam,
} from "./types.js";

const POSTMAN_SCHEMA_V21 =
  "https://schema.postman.com/json/collection/v2.1.0/collection.json";
const POSTMAN_SCHEMA_V20 =
  "https://schema.getpostman.com/json/collection/v2.0.0/collection.json";

/**
 * Adapter that converts a Postman Collection (v2.0 / v2.1.0) into
 * {@link NormalizedRequest} instances.
 *
 * Test scripts (`event.listen === "test"`) are preserved on the generated
 * operation as the `x-postman-scripts` extension, which is consumed by
 * `@powerduck/request`'s Postman-compatible script runner.
 *
 * Body modes supported:
 * - `raw`       → JSON / XML / text / binary based on Content-Type or language hint
 * - `urlencoded` → application/x-www-form-urlencoded with structured fields
 * - `formdata`  → multipart/form-data with text + file fields
 * - `file`      → binary upload (documented as string/binary)
 * - `graphql`   → application/json with the GraphQL query+variables payload
 *
 * Auth is resolved with inheritance: item > folder > collection.
 * Variables (`{{name}}`) are left verbatim in URLs and values; callers that
 * need resolution should pre-process the collection.
 */
export class PostmanAdapter
  implements SourceAdapter<PostmanCollection | string>
{
  readonly id = "postman";

  canHandle(input: unknown): boolean {
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
      try {
        return this.canHandle(JSON.parse(trimmed));
      } catch {
        return false;
      }
    }
    if (typeof input !== "object" || input === null) return false;
    const obj = input as Record<string, unknown>;
    if (typeof obj.info !== "object" || obj.info === null) return false;
    if (!Array.isArray(obj.item)) return false;
    const info = obj.info as Record<string, unknown>;
    const schema = typeof info.schema === "string" ? info.schema : "";
    return (
      schema === POSTMAN_SCHEMA_V21 ||
      schema === POSTMAN_SCHEMA_V20 ||
      // Accept collections that omit the schema URL but have the right shape.
      typeof info.name === "string"
    );
  }

  async parse(
    input: PostmanCollection | string,
    context: AdapterContext,
  ): Promise<NormalizedRequest[]> {
    const collection =
      typeof input === "string" ? this.parseJson(input, context) : input;

    if (!collection || typeof collection !== "object") {
      context.report({
        code: "POSTMAN_INVALID_COLLECTION",
        severity: "error",
        source: this.id,
        message: "Input is not a valid Postman collection object.",
      });
      return [];
    }

    if (!Array.isArray(collection.item) || collection.item.length === 0) {
      context.report({
        code: "POSTMAN_EMPTY_COLLECTION",
        severity: "warning",
        source: this.id,
        message: "Postman collection contains no items.",
      });
      return [];
    }

    const requests: NormalizedRequest[] = [];
    let index = 0;

    const walk = (
      items: PostmanItem[],
      inheritedAuth: PostmanAuth | undefined,
      inheritedEvents: PostmanEvent[],
    ): void => {
      for (const item of items) {
        if (isFolder(item)) {
          const folderAuth = item.auth ?? inheritedAuth;
          const folderEvents = [
            ...inheritedEvents,
            ...(item.event ?? []),
          ];
          walk(item.item, folderAuth, folderEvents);
          continue;
        }

        if (!isRequestItem(item)) continue;

        const request = item.request;
        const method = (request.method ?? "GET").toLowerCase();
        const urlString = this.resolveUrl(request.url, context);

        if (!urlString) {
          context.report({
            code: "POSTMAN_INVALID_COLLECTION",
            severity: "warning",
            source: this.id,
            index,
            message: `Item "${item.name}" has no resolvable URL; skipped.`,
          });
          index += 1;
          continue;
        }

        let url: URL;
        try {
          url = new URL(urlString);
        } catch (cause) {
          context.report({
            code: "POSTMAN_INVALID_COLLECTION",
            severity: "warning",
            source: this.id,
            index,
            message: `Item "${item.name}" has an invalid URL: ${urlString}`,
            cause,
          });
          index += 1;
          continue;
        }

        const headers = this.collectHeaders(request, context);
        const query = this.collectQuery(request.url, url, context);
        const cookies = this.collectCookies(headers);
        const body = this.resolveBody(request, headers, context, index);
        const auth = this.resolveAuth(
          request.auth ?? item.auth ?? inheritedAuth,
          headers,
          query,
        );

        const extensions = this.buildExtensions(item, inheritedEvents);

        requests.push({
          source: this.id,
          sourceIndex: index,
          method,
          url,
          urlString: url.href,
          headers,
          query,
          cookies,
          ...(body ? { body } : {}),
          ...(auth ? { auth } : {}),
          ...(Object.keys(extensions).length > 0
            ? { extensions }
            : {}),
        });

        index += 1;
      }
    };

    walk(
      collection.item,
      collection.auth,
      collection.event ?? [],
    );

    return requests;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private parseJson(
    text: string,
    context: AdapterContext,
  ): PostmanCollection | null {
    try {
      return JSON.parse(text) as PostmanCollection;
    } catch (cause) {
      context.report({
        code: "POSTMAN_INVALID_COLLECTION",
        severity: "error",
        source: this.id,
        message: "Failed to parse Postman collection JSON.",
        cause,
      });
      return null;
    }
  }

  private resolveUrl(
    url: PostmanUrl | string | undefined,
    context: AdapterContext,
  ): string | null {
    if (!url) return null;
    if (typeof url === "string") return url.trim();

    // Prefer raw when present; it preserves variables and query strings.
    if (url.raw && typeof url.raw === "string" && url.raw.trim()) {
      return url.raw.trim();
    }

    // Reconstruct from structured parts.
    const protocol = url.protocol ?? "https";
    const host = Array.isArray(url.host)
      ? url.host.join(".")
      : url.host ?? "";
    if (!host) return null;

    const port = url.port ? `:${url.port}` : "";
    const path = Array.isArray(url.path)
      ? url.path.map(encodeURIComponent).join("/")
      : url.path ?? "";
    const queryString = Array.isArray(url.query)
      ? url.query
          .filter((q) => !q.disabled)
          .map(
            (q) =>
              `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? "")}`,
          )
          .join("&")
      : "";
    const hash = url.hash ? `#${url.hash}` : "";

    return `${protocol}://${host}${port}/${path}${queryString ? `?${queryString}` : ""}${hash}`;
  }

  private collectHeaders(
    request: PostmanRequest,
    context: AdapterContext,
  ): Header[] {
    if (!Array.isArray(request.header)) return [];
    const headers: Header[] = [];
    for (const h of request.header) {
      if (!h || h.disabled) continue;
      const name = (h.key ?? "").trim();
      if (!name) continue;
      headers.push({ name, value: h.value ?? "" });
    }
    return headers;
  }

  private collectQuery(
    url: PostmanUrl | string | undefined,
    parsed: URL,
    context: AdapterContext,
  ): ParameterValue[] {
    const params: ParameterValue[] = [];

    // From structured URL object.
    if (typeof url === "object" && url !== null && Array.isArray(url.query)) {
      for (const q of url.query) {
        if (!q || q.disabled) continue;
        const name = (q.key ?? "").trim();
        if (!name) continue;
        params.push({ name, value: q.value ?? "" });
      }
      return params;
    }

    // From parsed URL search params.
    for (const [name, value] of parsed.searchParams) {
      params.push({ name, value });
    }
    return params;
  }

  private collectCookies(headers: Header[]): ParameterValue[] {
    const cookieHeader = headers.find(
      (h) => h.name.toLowerCase() === "cookie",
    );
    if (!cookieHeader) return [];
    return cookieHeader.value
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq === -1) return { name: pair, value: "" };
        return {
          name: pair.slice(0, eq).trim(),
          value: pair.slice(eq + 1).trim(),
        };
      });
  }

  private resolveBody(
    request: PostmanRequest,
    headers: Header[],
    context: AdapterContext,
    index: number,
  ): RequestBody | undefined {
    const body = request.body;
    if (!body || body.disabled) return undefined;

    const mode = body.mode ?? "raw";
    const contentType = this.findHeader(headers, "content-type");

    switch (mode) {
      case "raw":
        return this.rawBody(body.raw ?? "", contentType, body.options, context, index);

      case "urlencoded":
        return this.urlEncodedBody(body.urlencoded ?? [], context, index);

      case "formdata":
        return this.formDataBody(body.formdata ?? [], context, index);

      case "file":
        return {
          kind: "binary",
          mediaType: contentType ?? "application/octet-stream",
          raw: typeof body.file?.src === "string" ? body.file.src : undefined,
        };

      case "graphql":
        return this.graphqlBody(body.graphql, context, index);

      default:
        context.report({
          code: "POSTMAN_UNSUPPORTED_BODY_MODE",
          severity: "warning",
          source: this.id,
          index,
          message: `Unsupported Postman body mode "${mode}"; documented as text/plain.`,
        });
        return {
          kind: "text",
          mediaType: contentType ?? "text/plain",
          raw: body.raw ?? "",
        };
    }
  }

  private rawBody(
    raw: string,
    contentType: string | undefined,
    options: Record<string, unknown> | undefined,
    context: AdapterContext,
    index: number,
  ): RequestBody {
    // Postman stores the language hint in options.raw.language.
    const language =
      (options?.raw as Record<string, unknown> | undefined)?.language;
    const detected = this.detectMediaType(contentType, language as string | undefined);

    if (detected === "json") {
      return { kind: "json", mediaType: contentType ?? "application/json", raw };
    }
    if (detected === "xml") {
      return { kind: "xml", mediaType: contentType ?? "application/xml", raw };
    }
    if (detected === "binary") {
      return { kind: "binary", mediaType: contentType ?? "application/octet-stream", raw };
    }
    return { kind: "text", mediaType: contentType ?? "text/plain", raw };
  }

  private detectMediaType(
    contentType: string | undefined,
    language: string | undefined,
  ): "json" | "xml" | "binary" | "text" {
    const ct = (contentType ?? "").toLowerCase();
    if (ct.includes("json") || language === "json") return "json";
    if (ct.includes("xml") || language === "xml") return "xml";
    if (
      ct.includes("octet-stream") ||
      ct.includes("pdf") ||
      ct.includes("image/") ||
      ct.includes("video/") ||
      ct.includes("audio/")
    )
      return "binary";
    return "text";
  }

  private urlEncodedBody(
    params: PostmanUrlEncodedParam[],
    context: AdapterContext,
    index: number,
  ): RequestBody {
    const fields = params
      .filter((p) => p && !p.disabled)
      .map((p) => ({
        name: (p.key ?? "").trim(),
        value: p.value ?? "",
      }))
      .filter((f) => f.name);

    return {
      kind: "form-urlencoded",
      mediaType: "application/x-www-form-urlencoded",
      fields,
    };
  }

  private formDataBody(
    params: PostmanFormDataParam[],
    context: AdapterContext,
    index: number,
  ): RequestBody {
    const fields = params
      .filter((p) => p && !p.disabled)
      .map((p) => {
        const name = (p.key ?? "").trim();
        if (p.type === "file" || p.src) {
          const fileName = Array.isArray(p.src) ? p.src[0] : p.src;
          return {
            name,
            fileName: fileName ?? "file",
            ...(p.contentType ? { contentType: p.contentType } : {}),
          };
        }
        return { name, value: p.value ?? "" };
      })
      .filter((f) => f.name);

    return {
      kind: "multipart",
      mediaType: "multipart/form-data",
      fields,
    };
  }

  private graphqlBody(
    graphql: PostmanBody["graphql"],
    context: AdapterContext,
    index: number,
  ): RequestBody {
    if (!graphql) {
      return {
        kind: "json",
        mediaType: "application/json",
        raw: JSON.stringify({ query: "" }),
      };
    }
    const payload: Record<string, unknown> = { query: graphql.query ?? "" };
    if (graphql.variables !== undefined) {
      try {
        payload.variables =
          typeof graphql.variables === "string"
            ? JSON.parse(graphql.variables)
            : graphql.variables;
      } catch {
        payload.variables = graphql.variables;
      }
    }
    return {
      kind: "json",
      mediaType: "application/json",
      raw: JSON.stringify(payload),
    };
  }

  private resolveAuth(
    auth: PostmanAuth | undefined,
    headers: Header[],
    query: ParameterValue[],
  ): RequestAuth | undefined {
    // Explicit Postman auth block takes precedence.
    if (auth && auth.type && auth.type !== "noauth") {
      switch (auth.type) {
        case "bearer": {
          const token = this.authParam(auth.bearer, "token");
          if (token) return { type: "bearer" };
          break;
        }
        case "basic": {
          const user = this.authParam(auth.basic, "username");
          if (user) return { type: "basic" };
          break;
        }
        case "apikey": {
          const keyParam = this.authParam(auth.apikey, "key");
          const inParam = this.authParam(auth.apikey, "in");
          if (keyParam) {
            return {
              type: "apiKey",
              in: inParam === "query" ? "query" : "header",
              name: keyParam,
            };
          }
          break;
        }
        default:
          // oauth1/oauth2/hawk/etc. — fall through to header detection.
          break;
      }
    }

    // Detect from Authorization header.
    const authHeader = headers.find(
      (h) => h.name.toLowerCase() === "authorization",
    );
    if (authHeader) {
      const value = authHeader.value.trim();
      if (/^bearer\s+/i.test(value)) return { type: "bearer" };
      if (/^basic\s+/i.test(value)) return { type: "basic" };
    }

    // Detect apiKey from common header names.
    const apiKeyHeader = headers.find((h) =>
      /^(x-api-key|api-key|apikey|x-auth-token)$/i.test(h.name),
    );
    if (apiKeyHeader) {
      return { type: "apiKey", in: "header", name: apiKeyHeader.name };
    }

    // Detect apiKey from common query params.
    const apiKeyQuery = query.find((q) =>
      /^(api_key|apikey|api-key|access_token|token)$/i.test(q.name),
    );
    if (apiKeyQuery) {
      return { type: "apiKey", in: "query", name: apiKeyQuery.name };
    }

    return undefined;
  }

  private authParam(
    params: PostmanAuth["apikey"] | undefined,
    key: string,
  ): string | undefined {
    if (!Array.isArray(params)) return undefined;
    const found = params.find((p) => p?.key === key);
    return found?.value;
  }

  private findHeader(headers: Header[], name: string): string | undefined {
    const found = headers.find((h) => h.name.toLowerCase() === name);
    return found?.value;
  }

  private buildExtensions(
    item: PostmanItem & { event?: PostmanEvent[] },
    inheritedEvents: PostmanEvent[],
  ): Record<string, unknown> {
    const extensions: Record<string, unknown> = {};

    // Collect test scripts: item-level events override folder/collection-level.
    const testEvents = [
      ...inheritedEvents.filter((e) => e.listen === "test" && !e.disabled),
      ...(item.event ?? []).filter((e) => e.listen === "test" && !e.disabled),
    ];

    if (testEvents.length > 0) {
      const scripts = testEvents
        .map((e) => this.scriptToText(e.script))
        .filter(Boolean);
      if (scripts.length > 0) {
        extensions["x-postman-scripts"] = {
          test: scripts.join("\n"),
        };
      }
    }

    // Collect pre-request scripts.
    const preRequestEvents = (item.event ?? []).filter(
      (e) => e.listen === "prerequest" && !e.disabled,
    );
    if (preRequestEvents.length > 0) {
      const scripts = preRequestEvents
        .map((e) => this.scriptToText(e.script))
        .filter(Boolean);
      if (scripts.length > 0) {
        extensions["x-postman-scripts"] = {
          ...(extensions["x-postman-scripts"] as Record<string, unknown>),
          prerequest: scripts.join("\n"),
        };
      }
    }

    return extensions;
  }

  private scriptToText(
    script: PostmanEvent["script"],
  ): string {
    if (!script) return "";
    if (Array.isArray(script.exec)) return script.exec.join("\n");
    if (typeof script.exec === "string") return script.exec;
    return "";
  }
}
