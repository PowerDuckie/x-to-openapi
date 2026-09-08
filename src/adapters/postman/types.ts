/**
 * Type definitions for Postman Collection v2.1.0.
 * Reference: https://schema.postman.com/json/collection/v2.1.0/collection.json
 *
 * Only the fields needed for conversion are typed; everything else is
 * intentionally loose so forward-compatible additions do not break parsing.
 */

export interface PostmanCollection {
  info: PostmanInfo;
  item: PostmanItem[];
  /** Collection-level auth, inherited by items that do not override it. */
  auth?: PostmanAuth;
  variable?: PostmanVariable[];
  event?: PostmanEvent[];
  [key: string]: unknown;
}

export interface PostmanInfo {
  name: string;
  /** Should be the v2.1.0 schema URL, but we accept v2.0 as well. */
  schema?: string;
  description?: PostmanDescription | string;
  version?: string | PostmanVersion;
  [key: string]: unknown;
}

export interface PostmanVersion {
  major: number;
  minor: number;
  patch: number;
  identifier?: string;
  [key: string]: unknown;
}

export type PostmanItem = PostmanRequestItem | PostmanFolder;

export interface PostmanFolder {
  name: string;
  description?: PostmanDescription | string;
  item: PostmanItem[];
  event?: PostmanEvent[];
  auth?: PostmanAuth;
  variable?: PostmanVariable[];
  [key: string]: unknown;
}

export interface PostmanRequestItem {
  name: string;
  description?: PostmanDescription | string;
  request: PostmanRequest;
  response?: unknown[];
  event?: PostmanEvent[];
  auth?: PostmanAuth;
  variable?: PostmanVariable[];
  [key: string]: unknown;
}

export interface PostmanRequest {
  method: string;
  header?: PostmanHeader[];
  body?: PostmanBody;
  url?: PostmanUrl | string;
  auth?: PostmanAuth;
  description?: PostmanDescription | string;
  [key: string]: unknown;
}

export interface PostmanHeader {
  key: string;
  value?: string;
  type?: string;
  description?: PostmanDescription | string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string | string[];
  path?: string | string[];
  port?: string;
  query?: PostmanQueryParam[];
  hash?: string;
  variable?: PostmanVariable[];
  [key: string]: unknown;
}

export interface PostmanQueryParam {
  key: string;
  value?: string;
  description?: PostmanDescription | string;
  disabled?: boolean;
  [key: string]: unknown;
}

export type PostmanBodyMode =
  | "raw"
  | "urlencoded"
  | "formdata"
  | "file"
  | "graphql"
  | string;

export interface PostmanBody {
  mode?: PostmanBodyMode;
  raw?: string;
  urlencoded?: PostmanUrlEncodedParam[];
  formdata?: PostmanFormDataParam[];
  file?: PostmanFileParam;
  graphql?: PostmanGraphQLBody;
  options?: Record<string, unknown>;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanUrlEncodedParam {
  key: string;
  value?: string;
  description?: PostmanDescription | string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanFormDataParam {
  key: string;
  value?: string;
  type?: "text" | "file" | string;
  src?: string | string[];
  contentType?: string;
  description?: PostmanDescription | string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanFileParam {
  src?: string | string[];
  content?: string;
  [key: string]: unknown;
}

export interface PostmanGraphQLBody {
  query?: string;
  variables?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export type PostmanAuthType =
  | "apikey"
  | "basic"
  | "bearer"
  | "noauth"
  | "oauth1"
  | "oauth2"
  | "hawk"
  | "awsv4"
  | "ntlm"
  | "digest"
  | string;

export interface PostmanAuth {
  type: PostmanAuthType;
  apikey?: PostmanAuthParam[];
  basic?: PostmanAuthParam[];
  bearer?: PostmanAuthParam[];
  oauth2?: PostmanAuthParam[];
  [key: string]: unknown;
}

export interface PostmanAuthParam {
  key: string;
  value?: string;
  type?: string;
  [key: string]: unknown;
}

export interface PostmanEvent {
  listen: string; // "test" | "prerequest"
  script?: PostmanScript;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanScript {
  type?: string;
  exec?: string | string[];
  src?: PostmanUrl | string;
  name?: string;
  [key: string]: unknown;
}

export interface PostmanVariable {
  key: string;
  value?: unknown;
  type?: string;
  description?: PostmanDescription | string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanDescription {
  content?: string;
  type?: string;
  version?: string;
  [key: string]: unknown;
}

/** Type guard: a Postman item is a folder when it has a nested `item` array. */
export function isFolder(item: PostmanItem): item is PostmanFolder {
  return (
    typeof item === "object" &&
    item !== null &&
    Array.isArray((item as PostmanFolder).item)
  );
}

/** Type guard: a Postman item is a request when it has a `request` object. */
export function isRequestItem(item: PostmanItem): item is PostmanRequestItem {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as PostmanRequestItem).request === "object" &&
    (item as PostmanRequestItem).request !== null
  );
}
