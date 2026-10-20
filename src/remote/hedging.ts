/** Bounded hedging that never postpones the existing fallback schedule. */
export interface HedgeNode {
  name: string;
}

interface HedgeClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

interface HedgeOptions<N extends HedgeNode> {
  nodes: readonly N[];
  /** Source identity only: never include a credential in the key. */
  key: string;
  path: string;
  enabled: boolean;
  /** The attempt must finish size/digest validation before it resolves. */
  verified: boolean;
  /** One deadline for the entire race, including delayed attempts. */
  timeoutMs: number;
}

interface Route {
  winner: string;
  expiresAt: number;
}

const FALLBACK_DELAY_MS = 400;
const ROUTE_TTL_MS = 5 * 60 * 1000;
const MAX_ROUTES = 32;

/**
 * Keep the cold primary and the original 400ms all-node fallback. A verified
 * winner gets an additional immediate attempt, but never displaces or delays
 * the cold primary. Concurrent late completions cannot replace a newer route.
 */
export class DownloadHedger {
  private readonly routes = new Map<string, Route>();

  constructor(private readonly clock: HedgeClock = {
    now: () => performance.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  }) {}

  private route(key: string): Route | undefined {
    const route = this.routes.get(key);
    if (route && route.expiresAt <= this.clock.now()) {
      this.routes.delete(key);
      return undefined;
    }
    return route;
  }

  private remember(key: string, name: string, observedRoute: Route | undefined): void {
    const current = this.route(key);
    if (current && current !== observedRoute && current.winner !== name) return;
    // A fresh identity prevents a late failure from an older attempt from
    // deleting a route another concurrent download has just revalidated.
    const route: Route = {
      winner: name,
      expiresAt: this.clock.now() + ROUTE_TTL_MS,
    };
    this.routes.delete(key);
    this.routes.set(key, route);
    while (this.routes.size > MAX_ROUTES) this.routes.delete(this.routes.keys().next().value!);
  }

  run<T, N extends HedgeNode>(
    options: HedgeOptions<N>,
    attempt: (node: N, signal: AbortSignal, remainingMs: number) => Promise<T>,
  ): Promise<{ value: T; node: N }> {
    const { key, path, enabled, verified, timeoutMs } = options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Download timeout must be positive and finite"));
    if (!options.nodes.length) return Promise.reject(new Error(`No download nodes for ${path}`));

    const learn = enabled && verified;
    const route = learn ? this.route(key) : undefined;
    const preferred = options.nodes.find((node) => node.name === route?.winner);
    const nodes = [...options.nodes];
    // Even a short configured deadline must leave time for every route.
    const hedgeDelay = Math.min(FALLBACK_DELAY_MS, timeoutMs / 4);

    return new Promise((resolve, reject) => {
      const deadlineAt = this.clock.now() + timeoutMs;
      const controllers: AbortController[] = [];
      const failures: string[] = [];
      let settled = false;
      let pending = 0;
      const launched = new Set<N>();
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (winner?: AbortController) => {
        if (hedgeTimer !== undefined) this.clock.clearTimeout(hedgeTimer);
        if (deadlineTimer !== undefined) this.clock.clearTimeout(deadlineTimer);
        for (const controller of controllers) if (controller !== winner) controller.abort();
      };
      const finishFailure = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`${message}${failures.length ? ` ${failures.join("; ")}` : ""}`));
      };
      const fail = (node: N, observedRoute: Route | undefined, error: unknown) => {
        if (settled) return; // Canceled losers must not erase a healthy route.
        pending--;
        failures.push(`[${node.name}] ${error instanceof Error ? error.message : String(error)}`);
        if (learn && observedRoute?.winner === node.name && this.route(key) === observedRoute) this.routes.delete(key);
        launchRest();
        if (!pending) finishFailure(`All download nodes failed to fetch ${path}.`);
      };
      const launch = (node: N) => {
        if (settled || launched.has(node)) return;
        launched.add(node);
        const controller = new AbortController();
        controllers.push(controller);
        pending++;
        const startedAt = this.clock.now();
        const observedRoute = learn ? this.route(key) : undefined;
        // Normalize synchronous throws so all terminal paths use the same cleanup.
        let operation: Promise<T>;
        try { operation = attempt(node, controller.signal, Math.max(1, deadlineAt - startedAt)); }
        catch (error) { operation = Promise.reject(error); }
        Promise.resolve(operation).then((value) => {
          if (settled) return;
          settled = true;
          if (learn) this.remember(key, node.name, route);
          cleanup(controller);
          resolve({ value, node });
        }, (error: unknown) => fail(node, observedRoute, error));
      };
      const launchRest = () => {
        if (settled) return;
        if (hedgeTimer !== undefined) this.clock.clearTimeout(hedgeTimer);
        for (const node of nodes) launch(node);
      };

      deadlineTimer = this.clock.setTimeout(() => {
        // A deadline is a real failure, unlike winner-triggered cancellation.
        if (learn && route && this.route(key) === route && route.winner === preferred?.name) this.routes.delete(key);
        finishFailure(`Download timed out after ${timeoutMs}ms for ${path}.`);
      }, timeoutMs);
      if (enabled) {
        launch(nodes[0]);
        if (preferred) launch(preferred);
        if (launched.size < nodes.length) hedgeTimer = this.clock.setTimeout(launchRest, hedgeDelay);
      } else {
        launchRest();
      }
    });
  }
}
