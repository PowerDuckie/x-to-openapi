# @powerduck/x-to-openapi

Production-grade, extensible TypeScript framework that converts source formats (**curl commands** and **Postman Collections v2.0/v2.1.0**) into valid **OpenAPI 3.2** documents. Built for CI pipelines, API documentation generation, and reverse-engineering HTTP traffic.

The canonical source for OpenAPI types and validation across all `@powerduck/*` libraries.

---

## Features

- **Two source adapters** — curl commands (single/batch/browser export) and Postman Collections (v2.0 and v2.1.0, nested folders, auth inheritance)
- **Postman test script preservation** — `pm.test()` / `pm.expect()` scripts are emitted as `x-postman-scripts` on each operation, directly consumable by `@powerduck/request`
- **All body types** — JSON, XML, form-urlencoded, multipart/form-data (text + file fields), GraphQL, text, binary
- **Multi-request merging** — same method+path operations are merged; query/header/cookie parameters and body schemas are structurally combined
- **Path parameter inference** — numeric IDs, UUIDs, ULIDs, and long hex segments are templated (`/users/{userId}`) when they vary across at least N samples
- **Security inference** — Bearer, Basic, and API key (header / query / cookie) detection with proper OpenAPI security schemes; Postman auth blocks are resolved with folder/collection inheritance
- **Header filtering** — transport headers and browser noise are excluded by default; configurable
- **Non-standard HTTP methods** — `PURGE`, `LINK`, etc. are routed to OpenAPI 3.2 `additionalOperations`
- **Schema inference** — scalar type detection (boolean, integer, number, uuid, date, date-time), JSON schema generation, and structural merging with optional-property detection
- **Validation** — output is validated against the OpenAPI 3.2 schema using `@scalar/openapi-parser`
- **Diagnostics** — every issue (parse failure, malformed JSON, unsupported scheme, path merge conflict) is collected with severity, code, and source index; strict mode throws on errors
- **Extensible adapter architecture** — implement `SourceAdapter` to add HAR files, HTTPie commands, Insomnia exports, etc.

---

## Installation

```bash
npm install @powerduck/x-to-openapi
```

**Requirements:** Node.js >= 18.

---

## Quick Start

### Single curl command

```ts
import { curlToOpenApi } from "@powerduck/x-to-openapi";

const result = await curlToOpenApi(
  `curl -X POST https://api.example.com/users \
    -H 'Content-Type: application/json' \
    --data '{"name":"Ada","age":36}'`,
);

console.log(JSON.stringify(result.document, null, 2));
// {
//   "openapi": "3.2.0",
//   "info": { "title": "Generated API", "version": "1.0.0" },
//   "servers": [{ "url": "https://api.example.com" }],
//   "paths": {
//     "/users": {
//       "post": {
//         "operationId": "postUsers",
//         "tags": ["users"],
//         "requestBody": {
//           "required": true,
//           "content": {
//             "application/json": {
//               "schema": {
//                 "type": "object",
//                 "properties": { "name": { "type": "string" }, "age": { "type": "integer" } },
//                 "required": ["name", "age"]
//               }
//             }
//           }
//         },
//         "responses": { "default": { "description": "Successful response" } }
//       }
//     }
//   }
// }
```

### Batch of commands

```ts
import { curlToOpenApi } from "@powerduck/x-to-openapi";

const result = await curlToOpenApi([
  "curl https://api.example.com/users",
  "curl https://api.example.com/users/123",
  "curl -X POST https://api.example.com/users -H 'Content-Type: application/json' --data '{\"name\":\"Ada\"}'",
], {
  title: "User API",
  version: "2.0.0",
  useServerBasePath: true,
});
```

### Postman Collection

```ts
import { postmanToOpenApi } from "@powerduck/x-to-openapi";
import collection from "./postman_collection.json" with { type: "json" };

// Postman test scripts are preserved as x-postman-scripts on each operation.
const result = await postmanToOpenApi(collection, {
  title: collection.info.name,
  inferPathParameters: true,
});

console.log(result.document.paths["/users"]?.post?.["x-postman-scripts"]);
// { test: "pm.test('status is 201', () => ...)" }
```

Postman Collections can also be passed as a JSON string. Both v2.0 and v2.1.0 schema URLs are accepted; collections without a schema URL are accepted when they have the expected `info` + `item` shape.

### Full API with custom options

```ts
import { XToOpenApi, CurlAdapter } from "@powerduck/x-to-openapi";

const converter = new XToOpenApi()
  .register(new CurlAdapter());

const result = await converter.convert("curl", input, {
  title: "My API",
  version: "1.0.0",
  description: "Generated from curl commands",
  inferPathParameters: true,
  pathParameterMinSamples: 2,
  inferSecurity: true,
  includeCommonHeaders: false,
  includeCookies: false,
  includeExamples: false,
  useServerBasePath: false,
  validate: true,
  strict: false,
});

if (!result.ok) {
  for (const d of result.diagnostics) {
    console.error(`[${d.severity}] ${d.code}: ${d.message}`);
  }
}
```

---

## ConvertOptions Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | `string` | `"Generated API"` | API title in `info.title`. Must be non-empty. |
| `version` | `string` | `"1.0.0"` | API version in `info.version`. |
| `description` | `string` | `""` | API description in `info.description`. Omitted when empty. |
| `openapiVersion` | `"3.2.0"` | `"3.2.0"` | OpenAPI version. Only 3.2.0 is supported. |
| `inferPathParameters` | `boolean` | `true` | When true, segments that vary across requests and look like identifiers (numeric, UUID, ULID, hex >= 8 chars) are templated as path parameters. |
| `pathParameterMinSamples` | `number` | `2` | Minimum number of requests in a group before a varying segment is templated. Must be a positive integer. |
| `inferSecurity` | `boolean` | `true` | When true, detects Bearer/Basic/API-key auth and emits `components.securitySchemes` + per-operation `security`. |
| `includeCommonHeaders` | `boolean` | `false` | When false, browser noise headers (Accept, User-Agent, Sec-*, Origin, Referer, etc.) are excluded. Transport headers (Host, Content-Length, Connection, Content-Type, Authorization, Cookie) are always excluded. |
| `includeCookies` | `boolean` | `false` | When false, Cookie header values are not emitted as parameters. Cookies usually carry live session state. |
| `includeExamples` | `boolean` | `false` | When true, parameter and body schema examples are populated from observed values. |
| `useServerBasePath` | `boolean` | `false` | When true and all requests share one origin, the common path prefix (e.g. `/api/v1`) is collapsed into `servers[0].url` and stripped from operation paths. |
| `validate` | `boolean` | `true` | When true, the generated document is validated against the OpenAPI 3.2 schema. Validation failures are reported as diagnostics but do not throw. |
| `strict` | `boolean` | `false` | When true, any error-severity diagnostic throws a `ConversionError` immediately. |

---

## ConvertResult Reference

```ts
interface ConvertResult {
  /** The generated OpenAPI 3.2 document. */
  document: OpenApiDocument;
  /** Normalized requests parsed from the input (with urlString for JSON serialization). */
  requests: NormalizedRequest[];
  /** All diagnostics produced during conversion. */
  diagnostics: Diagnostic[];
  /** True when no error-severity diagnostic was produced. */
  ok: boolean;
  /** True when the document passed validation (or validation was skipped). */
  documentValid: boolean;
}
```

### Diagnostic

```ts
interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  severity: "info" | "warning" | "error";
  source?: string;      // adapter id, e.g. "curl"
  index?: number;       // source command index
  path?: string;        // affected OpenAPI path
  cause?: unknown;      // underlying error
}
```

### Diagnostic Codes

| Code | Severity | Meaning |
|------|----------|---------|
| `CURL_PARSE_FAILED` | error | A curl command could not be parsed. |
| `CURL_EMPTY_INPUT` | warning | No curl commands found in the input. |
| `CURL_CAPABILITY_MISSING` | error | No usable curlconverter generator is available. |
| `CURL_BACKEND_JSON_FALLBACK` | info | Using the HAR generator as fallback (multipart may be incomplete). |
| `CURL_UNSUPPORTED_SCHEME` | warning | A non-HTTP(S) URL was skipped. |
| `POSTMAN_INVALID_COLLECTION` | error / warning | Input is not a valid Postman collection, or an item has an unresolvable/invalid URL. |
| `POSTMAN_EMPTY_COLLECTION` | warning | Postman collection contains no items. |
| `POSTMAN_UNSUPPORTED_BODY_MODE` | warning | A Postman body mode is not supported; documented as text/plain. |
| `POSTMAN_VARIABLE_UNRESOLVED` | info | A Postman variable (`{{name}}`) was left verbatim. |
| `BODY_JSON_INVALID` | warning | A body declared as JSON is not valid JSON; documented as text/plain. |
| `PATH_MERGE_CONFLICT` | warning | The same method+path is served by multiple origins; samples were merged. |
| `OPERATION_ID_COLLISION` | info | An operationId was already used; a numeric suffix was appended. |
| `PSEUDO_HEADER_DROPPED` | info | An HTTP/2 pseudo-header (`:authority`, etc.) was dropped. |
| `MULTIPLE_SERVERS` | warning | Requests span multiple origins; all are listed in `servers`. |
| `NO_REQUESTS` | warning | No requests were converted; emitting an empty document. |
| `OAS_VALIDATION_ERROR` | error | The generated document failed OpenAPI 3.2 validation. |
| `OAS_VALIDATOR_FAILED` | warning | The validator itself threw an error. |

---

## Body Type Handling

### JSON

Detected from `Content-Type: application/json` or any `+json` suffix. The body is parsed and converted to a JSON Schema. Invalid JSON falls back to `text/plain` with a `BODY_JSON_INVALID` warning.

```bash
curl -X POST https://api.example.com/users \
  -H 'Content-Type: application/json' \
  --data '{"name":"Ada","age":36,"tags":["admin","user"]}'
```

Produces:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "age": { "type": "integer" },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["name", "age", "tags"]
}
```

### form-urlencoded

Detected from `Content-Type: application/x-www-form-urlencoded`. Fields are parsed into an object schema with per-field type inference.

```bash
curl -X POST https://api.example.com/login \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'username=ada&password=secret&remember_me=true'
```

Produces:
```json
{
  "type": "object",
  "properties": {
    "username": { "type": "string" },
    "password": { "type": "string" },
    "remember_me": { "type": "boolean" }
  },
  "required": ["username", "password", "remember_me"]
}
```

### multipart/form-data

Detected from `-F` / `--form` flags or `Content-Type: multipart/form-data`. Text fields become string/integer/boolean schemas; file fields become `{ "type": "string", "format": "binary" }` with optional `contentMediaType`.

```bash
curl -X POST https://api.example.com/upload \
  -F 'title=Hello World' \
  -F 'file=@document.pdf'
```

Produces:
```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "file": { "type": "string", "format": "binary" }
  },
  "required": ["title", "file"]
}
```

When structured fields are unavailable (e.g. raw multipart body), the boundary is extracted from the media type and parts are parsed manually.

### XML

Detected from `application/xml`, `text/xml`, or any `+xml` suffix. Documented as a string schema (XML is not parsed into a schema).

### Text / Binary

`text/*` content types are documented as strings. `application/octet-stream` and other unknown types are documented as `{ "type": "string", "format": "binary" }`.

---

## Path Parameter Inference

When `inferPathParameters` is true, requests are grouped by method + origin + path shape. Within each group, a segment is templated as a path parameter when:

1. It varies across at least `pathParameterMinSamples` requests in the group, AND
2. Every value in that segment looks like an identifier:
   - Pure numeric (`123`, `0`, `999999`)
   - UUID (`3f1d9a2e-4b7c-4c1a-9d2e-8f6b1c0a7e51`)
   - ULID (`01ARZ3NDEKTSV4RRFFQ69G5FAV`)
   - Hex string >= 8 characters (`deadbeef`, `a1b2c3d4e5f6`)

Parameter names are derived from the preceding static segment, singularized and camelCased:

| Path | Parameter Name |
|------|---------------|
| `/users/{}` | `userId` |
| `/users/{}/posts/{}` | `userId`, `postId` |
| `/categories/{}/items/{}` | `categoryId`, `itemId` |
| `/{}` (no preceding segment) | `param1`, `param2` |

Duplicates within a path get numeric suffixes: `userId`, `userId2`.

---

## Security Inference

When `inferSecurity` is true, the following credentials are detected:

| Pattern | Detection | Security Scheme |
|---------|-----------|-----------------|
| `Authorization: Bearer <token>` | Header | `http` / `bearer` |
| `--oauth2-bearer <token>` | Flag | `http` / `bearer` |
| `Authorization: Basic <creds>` | Header | `http` / `basic` |
| `-u user:pass` | Flag | `http` / `basic` |
| `x-api-key: <value>` | Header | `apiKey` / `header` / `x-api-key` |
| `?api_key=<value>`, `?access_token=<value>`, etc. | Query | `apiKey` / `query` / `<param>` |

API key schemes are named `apiKey_<location>_<name>` (e.g. `apiKey_header_x-api-key`) so distinct keys do not collide.

---

## Schema Merging

When multiple requests map to the same operation, their schemas are structurally merged:

- **Objects**: properties are unioned; a property is `required` only when present in every sample.
- **Arrays**: item schemas are merged recursively.
- **Scalars**: `integer` widens to `number` when mixed; mixed types become a type array (`["string", "integer"]`).
- **Formats**: kept only when every sample declares the same format (e.g. all `uuid`).

---

## Postman Collection Conversion

The `PostmanAdapter` converts Postman Collections (v2.0 and v2.1.0) into OpenAPI 3.2. It supports the full Postman feature set needed for accurate conversion.

### Collection structure

```json
{
  "info": {
    "name": "My API",
    "schema": "https://schema.postman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Users",
      "item": [
        {
          "name": "Get user",
          "request": {
            "method": "GET",
            "url": "https://api.example.com/users/123",
            "header": [{ "key": "Authorization", "value": "Bearer token" }]
          },
          "event": [
            {
              "listen": "test",
              "script": { "type": "text/javascript", "exec": ["pm.test('status is 200', () => pm.response.to.have.status(200));"] }
            }
          ]
        }
      ]
    }
  ],
  "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "{{token}}" }] }
}
```

### Body modes

| Postman `body.mode` | OpenAPI content type | Notes |
|---------------------|---------------------|-------|
| `raw` + JSON language / content-type | `application/json` | Parsed into JSON Schema |
| `raw` + XML language / content-type | `application/xml` | Documented as string |
| `raw` + text | `text/plain` | Documented as string |
| `urlencoded` | `application/x-www-form-urlencoded` | Structured fields with type inference |
| `formdata` (text) | `multipart/form-data` | String/integer/boolean fields |
| `formdata` (file) | `multipart/form-data` | `{ type: "string", format: "binary" }` |
| `file` | content-type or `application/octet-stream` | Binary upload |
| `graphql` | `application/json` | Serialized as `{ query, variables }` |

Disabled params and headers are skipped.

### Auth inheritance

Auth is resolved with precedence: **item > folder > collection**. The `noauth` type explicitly disables inherited auth. Supported types:

| Postman auth type | OpenAPI security scheme |
|-------------------|------------------------|
| `bearer` | `http` / `bearer` |
| `basic` | `http` / `basic` |
| `apikey` (in: header) | `apiKey` / `header` / `<key>` |
| `apikey` (in: query) | `apiKey` / `query` / `<key>` |

If no auth block is present, the adapter also detects credentials from `Authorization` headers, `x-api-key` headers, and `api_key`/`access_token` query params.

### Test scripts

Postman `test` events are preserved on the generated operation as the `x-postman-scripts` extension, which is the exact format consumed by `@powerduck/request`'s Postman-compatible script runner:

```json
{
  "x-postman-scripts": {
    "test": "pm.test('status is 200', () => pm.response.to.have.status(200));",
    "prerequest": "pm.variables.set('x', '1');"
  }
}
```

Collection-level and folder-level test scripts are inherited; item-level scripts are appended. Disabled events are skipped.

### Variables

Postman variables (`{{name}}`) are left verbatim in URLs, headers, and bodies. The adapter does not resolve them — pre-process the collection with a variable resolver if you need concrete values.

---

## Canonical Exports

This library is the single source of truth for OpenAPI types and validation across all `@powerduck/*` packages.

```ts
import {
  // Canonical type — use this instead of @scalar/openapi-types directly
  type OpenApiDocument,
  // Canonical validation — alias of validateOpenApi32
  validateOpenApiDocument,
} from "@powerduck/x-to-openapi";

const doc: OpenApiDocument = { ... };
const { valid, diagnostics } = validateOpenApiDocument(doc);
```

Also available: `OpenApi32Document` (version-specific alias) and `validateOpenApi32` (original name).

---

## Adapter Architecture

The library is built around a simple adapter interface:

```ts
interface SourceAdapter<I = unknown> {
  readonly id: string;           // e.g. "curl", "postman", "har"
  canHandle?(input: unknown): boolean;
  parse(input: I, context: AdapterContext): Promise<NormalizedRequest[]>;
}

interface AdapterContext {
  readonly report: (diagnostic: Diagnostic) => void;
  readonly strict: boolean;
}
```

### Implementing a custom adapter

```ts
import type { SourceAdapter, NormalizedRequest, AdapterContext } from "@powerduck/x-to-openapi";

class PostmanAdapter implements SourceAdapter<PostmanCollection> {
  readonly id = "postman";

  canHandle(input: unknown): boolean {
    return (
      typeof input === "object" &&
      input !== null &&
      "info" in input &&
      "item" in input
    );
  }

  async parse(
    input: PostmanCollection,
    context: AdapterContext,
  ): Promise<NormalizedRequest[]> {
    return input.item.map((item, index) => ({
      source: this.id,
      sourceIndex: index,
      method: item.request.method.toLowerCase(),
      url: new URL(item.request.url.raw),
      headers: item.request.header.map((h) => ({ name: h.key, value: h.value })),
      query: [],
      cookies: [],
      // ... body, auth
    }));
  }
}

// Usage
const converter = new XToOpenApi()
  .register(new PostmanAdapter())
  .register(new CurlAdapter());

const result = await converter.convert("auto", postmanCollection);
```

### AdapterRegistry

- `register(adapter)` — validates the adapter id (`/^[a-z][a-z0-9-]*$/`), checks for `parse()`, rejects duplicates.
- `get(id)` — retrieves a registered adapter; throws with a helpful message listing registered ids.
- `detect(input)` — returns the first adapter whose `canHandle()` accepts the input. Throwing predicates are caught and skipped.
- `has(id)` / `ids()` — membership and listing.

---

## API Reference

### `curlToOpenApi(input, options?)`

Zero-config helper. Registers a `CurlAdapter` and converts.

```ts
function curlToOpenApi(
  input: string | readonly string[],
  options?: ConvertOptions,
): Promise<ConvertResult>;
```

### `postmanToOpenApi(input, options?)`

Zero-config helper. Registers a `PostmanAdapter` and converts. Accepts a parsed Postman Collection object or a JSON string. Test scripts are preserved as `x-postman-scripts`.

```ts
function postmanToOpenApi(
  input: PostmanCollection | string,
  options?: ConvertOptions,
): Promise<ConvertResult>;
```

### `XToOpenApi`

```ts
class XToOpenApi {
  register<I>(adapter: SourceAdapter<I>): this;
  adapters(): string[];
  convert(source: string, input: unknown, options?: ConvertOptions): Promise<ConvertResult>;
}
```

`source` can be an adapter id (`"curl"`, `"postman"`) or `"auto"` to select via `canHandle()`.

### `PostmanAdapter`

Converts Postman Collections v2.0/v2.1.0. Exports `PostmanTypes` namespace for all collection type definitions.

```ts
import { PostmanAdapter, PostmanTypes } from "@powerduck/x-to-openapi";

const adapter = new PostmanAdapter();
const requests = await adapter.parse(collection, { report, strict: false });
```

### `splitCurlCommands(input)`

Splits browser "Copy all as cURL" output into individual commands. Handles quotes, backslash/caret continuations, CRLF, shell prompts (`$`, `#`, `>`, `PS C:\>`), and `curl.exe`.

### `buildOpenApi32(requests, options, report)`

Low-level: builds an OpenAPI document from an array of `NormalizedRequest`.

### Canonical type & validation

```ts
// Canonical OpenAPI document type (single source of truth)
type OpenApiDocument = ...;

// Canonical validation (alias of validateOpenApi32)
function validateOpenApiDocument(doc: OpenApiDocument): { valid: boolean; diagnostics: Diagnostic[] };

// Also available: version-specific names
type OpenApi32Document = ...;
function validateOpenApi32(doc): ...;
```

### `scalar(value, includeExample?)` / `jsonSchema(value, includeExample?)` / `mergeSchemas(schemas)`

Schema inference utilities.

### `ConversionError`

Thrown in strict mode. Carries a `diagnostics` array.

---

## CLI (Optional)

This library does not ship a CLI. For a CI-ready command-line tool that batch-tests OpenAPI documents, see [`@powerduck/cli`](https://www.npmjs.com/package/@powerduck/cli).

---

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Build (ESM + CJS + type declarations, minified)
npm run build

# Run tests (211 tests across 6 files)
npm test

# Watch mode
npx vitest watch
```

### Test Coverage

| File | Tests | Coverage |
|------|-------|----------|
| `framework.test.ts` | 50+ | End-to-end conversion, options validation, registry, diagnostics, serialization |
| `curl-adapter.test.ts` | 44 | Methods, URLs, headers, cookies, JSON/form/multipart/XML/binary bodies, auth, errors |
| `postman-adapter.test.ts` | 72 | canHandle, basic parsing, nested folders, URL formats, headers, query, all body modes, auth inheritance, test scripts (x-postman-scripts), error handling, full OpenAPI integration, canonical exports |
| `builder.test.ts` | 42 | Document structure, methods, query/header/cookie params, all body types, security, useServerBasePath, collisions, extensions passthrough |
| `schema.test.ts` | 34 | Scalar inference, JSON schema, merge logic |
| `paths.test.ts` | 20 | Identifier detection, path templating, edge cases |
| `split.test.ts` | 23 | Command splitting, quotes, continuations, prompts, edge cases |

**Total: 283+ tests across 7 files.**

---

## License

MIT
