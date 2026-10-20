/** Classifies admission; every class still shares the same process-wide cap. */
export type HttpRequestKind = "data" | "metadata" | "manifest";

export interface HttpBudgetLimits {
  /** Maximum operations from admission through complete body consumption. */
  capacity: number;
  /** Slots unavailable to data, including the manifest reservation below. */
  metadataReserve: number;
  /** Slots unavailable to both data and other metadata. */
  manifestReserve: number;
}

export interface HttpRequestAdmission {
  kind: HttpRequestKind;
  /** A skill/source identity, not an individual URL or credential. */
  group: string;
  /** The caller starts its deadline BEFORE admission so queue time counts. */
  signal: AbortSignal;
}

export type HttpRequestContext = Pick<HttpRequestAdmission, "kind" | "group">;

interface Pending {
  admission: HttpRequestAdmission;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

interface Group {
  kind: HttpRequestKind;
  requests: Set<Pending>;
}

/**
 * Work-conserving HTTP admission with reserved control capacity and round-robin
 * groups. It does not alter a downloader's hedge timers, retry policy or hashes.
 * Reservations only affect admission while the shared budget is occupied.
 */
export class HttpRequestBudget {
  private readonly groups = new Map<string, Group>();
  private readonly activeByKind: Record<HttpRequestKind, number> = { data: 0, metadata: 0, manifest: 0 };
  private active = 0;
  private queued = 0;
  private draining = false;

  constructor(private readonly limits: HttpBudgetLimits) {
    const { capacity, metadataReserve, manifestReserve } = limits;
    if (![capacity, metadataReserve, manifestReserve].every(Number.isSafeInteger) ||
        capacity < 1 || manifestReserve < 0 || metadataReserve < manifestReserve || metadataReserve >= capacity) {
      throw new Error("Invalid HTTP budget: 0 <= manifestReserve <= metadataReserve < capacity is required");
    }
    // The caller cannot mutate live limits through its original object.
    this.limits = { ...limits };
  }

  snapshot(): Readonly<{ active: number; queued: number; queuedGroups: number;
    activeByKind: Readonly<Record<HttpRequestKind, number>>; limits: Readonly<HttpBudgetLimits> }> {
    return { active: this.active, queued: this.queued, queuedGroups: this.groups.size,
      activeByKind: { ...this.activeByKind }, limits: { ...this.limits } };
  }

  /** A larger configured single-skill fan-out may expand, never reset, the cap. */
  expandCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("HTTP capacity must be a positive integer");
    if (capacity <= this.limits.capacity) return;
    this.limits.capacity = capacity;
    this.drain();
  }

  /**
   * The operation must consume/cancel its body before it settles. An abort does
   * not free an active permit until the transport settles: otherwise a slow
   * cancellation could let actual in-flight HTTP exceed the budget.
   */
  async run<T>(admission: HttpRequestAdmission, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(admission);
    try {
      // Cancellation can occur between synchronous admission and this microtask.
      admission.signal.throwIfAborted();
      return await operation();
    } finally { release(); }
  }

  private canAdmit(kind: HttpRequestKind): boolean {
    if (this.active >= this.limits.capacity) return false;
    if (kind === "data" && this.activeByKind.data >= this.limits.capacity - this.limits.metadataReserve) return false;
    return kind === "manifest" ||
      this.activeByKind.data + this.activeByKind.metadata < this.limits.capacity - this.limits.manifestReserve;
  }

  private acquire(admission: HttpRequestAdmission): Promise<() => void> {
    if (admission.signal.aborted) return Promise.reject(admission.signal.reason);
    return new Promise((resolve, reject) => {
      const key = JSON.stringify([admission.kind, admission.group]);
      const group = this.groups.get(key) ?? { kind: admission.kind, requests: new Set<Pending>() };
      const request: Pending = { admission, resolve, reject, onAbort: () => {
        if (!group.requests.delete(request)) return;
        this.queued--;
        if (!group.requests.size) this.groups.delete(key);
        admission.signal.removeEventListener("abort", request.onAbort);
        reject(admission.signal.reason);
        this.drain();
      } };
      group.requests.add(request);
      this.groups.set(key, group);
      this.queued++;
      admission.signal.addEventListener("abort", request.onAbort, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active < this.limits.capacity) {
        let selected: [string, Group] | undefined;
        // Map order is the round-robin ring. Skip blocked classes so data
        // waiting on its ceiling cannot block a reserved metadata slot.
        for (const entry of this.groups) {
          if (this.canAdmit(entry[1].kind)) { selected = entry; break; }
        }
        if (!selected) break;
        const [key, group] = selected;
        const request = group.requests.values().next().value!;
        group.requests.delete(request);
        this.groups.delete(key);
        if (group.requests.size) this.groups.set(key, group);
        this.queued--;
        request.admission.signal.removeEventListener("abort", request.onAbort);
        this.active++;
        this.activeByKind[group.kind]++;
        let released = false;
        request.resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.activeByKind[group.kind]--;
          this.drain();
        });
      }
    } finally { this.draining = false; }
  }
}

const processBudget = new HttpRequestBudget({ capacity: 88, metadataReserve: 8, manifestReserve: 4 });

/**
 * Share one budget across file, catalog/API, and manifest transports. The
 * highest valid configured concurrency controls capacity; concurrent skills
 * never add capacities together. Invalid values cannot enlarge the ceiling.
 */
export function runHttpRequest<T>(
  admission: HttpRequestAdmission, operation: () => Promise<T>, downloadConcurrency?: number,
): Promise<T> {
  if (Number.isSafeInteger(downloadConcurrency) && downloadConcurrency! > 16 && downloadConcurrency! <= 64) {
    processBudget.expandCapacity(downloadConcurrency! * 5 + 8);
  }
  return processBudget.run(admission, operation);
}

/** Counts only: no source keys, URLs, paths, or credentials are exposed. */
export function readHttpBudgetState(): ReturnType<HttpRequestBudget["snapshot"]> {
  return processBudget.snapshot();
}
