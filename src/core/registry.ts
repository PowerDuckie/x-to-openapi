import type { SourceAdapter } from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export class AdapterRegistry {
  readonly #adapters = new Map<string, SourceAdapter<unknown>>();

  register<I>(adapter: SourceAdapter<I>): this {
    if (!adapter || typeof adapter !== "object")
      throw new TypeError("Adapter must be an object");
    if (!ID_PATTERN.test(adapter.id ?? ""))
      throw new TypeError(`Invalid adapter id: ${String(adapter?.id)}`);
    if (typeof adapter.parse !== "function")
      throw new TypeError(`Adapter ${adapter.id} must implement parse()`);
    if (this.#adapters.has(adapter.id))
      throw new Error(`Adapter already registered: ${adapter.id}`);

    this.#adapters.set(adapter.id, adapter as SourceAdapter<unknown>);
    return this;
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get(id: string): SourceAdapter<unknown> {
    const adapter = this.#adapters.get(id);
    if (!adapter)
      throw new Error(
        `Unknown source adapter: ${id}. Registered: ${this.ids().join(", ") || "(none)"}`,
      );
    return adapter;
  }

  /** Picks the first adapter whose canHandle() accepts the input. */
  detect(input: unknown): SourceAdapter<unknown> | undefined {
    for (const adapter of this.#adapters.values()) {
      try {
        if (adapter.canHandle?.(input)) return adapter;
      } catch {
        /* a throwing predicate must never break detection */
      }
    }
    return undefined;
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }
}
