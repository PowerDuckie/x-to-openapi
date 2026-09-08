import type { Document as OpenApi32Document } from "@scalar/openapi-types/3.2";

export type OpenApiDocument = OpenApi32Document;
export type JsonObject = Record<string, unknown>;
export type Severity = "info" | "warning" | "error";

export type DiagnosticCode =
  | "ADAPTER_PARSE_FAILED"
  | "CURL_PARSE_FAILED"
  | "CURL_EMPTY_INPUT"
  | "CURL_CAPABILITY_MISSING"
  | "CURL_BACKEND_JSON_FALLBACK"
  | "CURL_UNSUPPORTED_SCHEME"
  | "POSTMAN_INVALID_COLLECTION"
  | "POSTMAN_EMPTY_COLLECTION"
  | "POSTMAN_UNSUPPORTED_BODY_MODE"
  | "POSTMAN_VARIABLE_UNRESOLVED"
  | "BODY_JSON_INVALID"
  | "PATH_MERGE_CONFLICT"
  | "OPERATION_ID_COLLISION"
  | "PSEUDO_HEADER_DROPPED"
  | "MULTIPLE_SERVERS"
  | "NO_REQUESTS"
  | "OAS_VALIDATION_ERROR"
  | "OAS_VALIDATOR_FAILED";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  severity: Severity;
  source?: string;
  index?: number;
  path?: string;
  cause?: unknown;
}

export interface Header {
  readonly name: string;
  readonly value: string;
}

export interface ParameterValue {
  readonly name: string;
  readonly value: string;
}

export interface FormField {
  readonly name: string;
  readonly value?: string;
  readonly fileName?: string;
  readonly contentType?: string;
}

export type BodyKind =
  | "json"
  | "xml"
  | "form-urlencoded"
  | "multipart"
  | "text"
  | "binary";

export interface RequestBody {
  readonly kind: BodyKind;
  readonly mediaType: string;
  readonly raw?: string;
  readonly fields?: readonly FormField[];
}

/** Credentials recovered from the source, independent of header shape. */
export type RequestAuth =
  | { readonly type: "basic" }
  | { readonly type: "bearer" }
  | {
      readonly type: "apiKey";
      readonly in: "header" | "query" | "cookie";
      readonly name: string;
    };

export interface NormalizedRequest {
  readonly source: string;
  readonly sourceIndex: number;
  /** Lowercase token, e.g. "get", "post", "purge". */
  readonly method: string;
  readonly url: URL;
  /** String form of `url`, populated for JSON-safe serialization. */
  readonly urlString?: string;
  readonly headers: readonly Header[];
  readonly query: readonly ParameterValue[];
  readonly cookies: readonly ParameterValue[];
  readonly body?: RequestBody;
  readonly auth?: RequestAuth;
  /**
   * OpenAPI extensions (x-*) to merge onto the generated operation.
   * Keys should start with "x-" (e.g. "x-postman-scripts").
   * When multiple requests map to the same operation, extensions are
   * shallow-merged; later requests do not overwrite earlier keys.
   */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface AdapterContext {
  readonly report: (diagnostic: Diagnostic) => void;
  readonly strict: boolean;
}

export interface SourceAdapter<I = unknown> {
  readonly id: string;
  canHandle?(input: unknown): boolean;
  parse(input: I, context: AdapterContext): Promise<NormalizedRequest[]>;
}

export interface ConvertOptions {
  openapiVersion?: "3.2.0";
  title?: string;
  version?: string;
  description?: string;
  inferPathParameters?: boolean;
  pathParameterMinSamples?: number;
  inferSecurity?: boolean;
  includeCommonHeaders?: boolean;
  /** Default false: cookies usually carry live session state. */
  includeCookies?: boolean;
  includeExamples?: boolean;
  /** Collapse the single common origin into servers[0] and strip it from paths. */
  useServerBasePath?: boolean;
  validate?: boolean;
  strict?: boolean;
}

export type ResolvedConvertOptions = Required<ConvertOptions> & {
  openapiVersion: "3.2.0";
};

export interface ConvertResult {
  document: OpenApiDocument;
  requests: NormalizedRequest[];
  diagnostics: Diagnostic[];
  /** True when no error-severity diagnostic was produced. */
  ok: boolean;
  /** True when the emitted document passed schema validation (or validation was skipped). */
  documentValid: boolean;
}
