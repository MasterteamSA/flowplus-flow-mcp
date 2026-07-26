/**
 * Catalog access with progressive disclosure.
 *
 * GET builder/catalog returns the entire flow vocabulary in one response:
 * ~52 node types, each carrying a full JSON Schema for its config plus a UI
 * schema. Handing that to a model wholesale costs tens of thousands of tokens
 * and buries the useful signal.
 *
 * So the catalog is fetched once, cached, and served two ways:
 *   - summarise()   one line per node type. Enough to choose.
 *   - detail(keys)  the full schemas, only for the types actually chosen.
 *
 * The model reads the summary, picks three or four node types, then asks for
 * exactly those. That is the difference between a session that can build a flow
 * and one that runs out of context first.
 */

import type { FlowPlusClient } from "./client.js";

export interface NodeTypeDescriptor {
  nodeType: string;
  key: string;
  displayName?: string;
  category?: string;
  description?: string;
  configSchema?: unknown;
  configUiSchema?: unknown;
  outputs?: unknown;
  [key: string]: unknown;
}

export interface TriggerTypeDescriptor {
  triggerType: string;
  key: string;
  displayName?: string;
  category?: string;
  description?: string;
  configSchema?: unknown;
  payloadSchema?: unknown;
  [key: string]: unknown;
}

export interface BuilderCatalog {
  triggerTypes: TriggerTypeDescriptor[];
  nodeTypes: NodeTypeDescriptor[];
  routeTypes: string[];
  sideEffectPolicies: string[];
  [key: string]: unknown;
}

/** Catalog changes only when the server is redeployed; five minutes is ample. */
const CACHE_TTL_MS = 5 * 60_000;

export class CatalogService {
  private cache?: { at: number; catalog: BuilderCatalog };
  private inFlight?: Promise<BuilderCatalog>;

  constructor(private readonly client: FlowPlusClient) {}

  async get(force = false): Promise<BuilderCatalog> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.catalog;
    }
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<BuilderCatalog> {
    const catalog = await this.client.request<BuilderCatalog>(
      "/api/control-panel/automation-engine/builder/catalog",
    );
    const normalised: BuilderCatalog = {
      ...catalog,
      triggerTypes: catalog?.triggerTypes ?? [],
      nodeTypes: catalog?.nodeTypes ?? [],
      routeTypes: catalog?.routeTypes ?? [],
      sideEffectPolicies: catalog?.sideEffectPolicies ?? [],
    };
    this.cache = { at: Date.now(), catalog: normalised };
    return normalised;
  }

  /** Compact overview: node types grouped by category, one line each. */
  async summarise(categoryFilter?: string): Promise<{
    triggerTypes: Array<{ key: string; triggerType: string; description?: string }>;
    nodeTypesByCategory: Record<string, Array<{ key: string; nodeType: string; description?: string }>>;
    routeTypes: string[];
    sideEffectPolicies: string[];
    totalNodeTypes: number;
    note: string;
  }> {
    const catalog = await this.get();

    const wanted = categoryFilter?.trim().toLowerCase();
    const byCategory: Record<string, Array<{ key: string; nodeType: string; description?: string }>> = {};

    for (const node of catalog.nodeTypes) {
      const category = node.category ?? "other";
      if (wanted && category.toLowerCase() !== wanted) continue;
      (byCategory[category] ??= []).push({
        key: node.key,
        nodeType: node.nodeType,
        description: node.description,
      });
    }
    for (const list of Object.values(byCategory)) {
      list.sort((a, b) => a.key.localeCompare(b.key));
    }

    return {
      triggerTypes: catalog.triggerTypes.map((t) => ({
        key: t.key,
        triggerType: t.triggerType,
        description: t.description,
      })),
      nodeTypesByCategory: byCategory,
      routeTypes: catalog.routeTypes,
      sideEffectPolicies: catalog.sideEffectPolicies,
      totalNodeTypes: catalog.nodeTypes.length,
      note:
        "Config schemas are omitted here on purpose. Call flow_node_schema with the keys you intend " +
        "to use to get their configSchema, and use the PascalCase `nodeType` (not `key`) in the " +
        "definition document you build.",
    };
  }

  /** Full descriptors for named node types. Accepts either key or nodeType. */
  async detail(keys: string[]): Promise<{
    found: NodeTypeDescriptor[];
    notFound: string[];
    suggestions: Record<string, string[]>;
  }> {
    const catalog = await this.get();
    const found: NodeTypeDescriptor[] = [];
    const notFound: string[] = [];
    const suggestions: Record<string, string[]> = {};

    for (const requested of keys) {
      const needle = requested.trim().toLowerCase();
      const match = catalog.nodeTypes.find(
        (n) => n.key.toLowerCase() === needle || n.nodeType.toLowerCase() === needle,
      );
      if (match) {
        found.push(match);
        continue;
      }
      notFound.push(requested);
      // Cheap substring similarity is enough to recover from a near miss.
      const close = catalog.nodeTypes
        .filter(
          (n) =>
            n.key.toLowerCase().includes(needle) ||
            needle.includes(n.key.toLowerCase()) ||
            (n.displayName ?? "").toLowerCase().includes(needle),
        )
        .slice(0, 5)
        .map((n) => n.key);
      if (close.length) suggestions[requested] = close;
    }

    return { found, notFound, suggestions };
  }

  async triggerDetail(key?: string): Promise<TriggerTypeDescriptor[]> {
    const catalog = await this.get();
    if (!key) return catalog.triggerTypes;
    const needle = key.trim().toLowerCase();
    return catalog.triggerTypes.filter(
      (t) => t.key.toLowerCase() === needle || t.triggerType.toLowerCase() === needle,
    );
  }
}
