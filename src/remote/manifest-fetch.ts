import { createHash } from "node:crypto";
import type { Config, ManifestEntry } from "../config.js";
import { parseManifest } from "../config.js";
import { runHttpRequest } from "./http-budget.js";

export type ManifestEndpoint = "raw" | "contents";

export interface ManifestValidator {
  url: string;
  bodySha256: string;
  etag?: string;
  lastModified?: string;
}

export type ManifestValidators = Partial<Record<ManifestEndpoint, ManifestValidator>>;

export interface ManifestCacheSnapshot {
  /** The caller must only supply a cache belonging to the configured source. */
  text: string;
  validators?: ManifestValidators;
}

export interface ManifestFetchOptions {
  cached?: ManifestCacheSnapshot;
  /** Shared by raw and Contents API, including the complete response bodies. */
  authoritativeTimeoutMs: number;
  /** Raw gets this head start; explicit failure starts the API immediately. */
  hedgeDelayMs?: number;
  /** Only applies when there is no structurally valid same-source cache. */
  allowMirrors?: boolean;
}

export interface ManifestFetchResult {
  text: string;
  entries: ManifestEntry[];
  source: ManifestEndpoint | "mirror";
  notModified: boolean;
  /** Validators are endpoint-specific and tied to the returned body bytes. */
  validators: ManifestValidators;
}

interface Candidate {
  name: string;
  url: string;
  endpoint?: ManifestEndpoint;
}

interface ValidCache {
  text: string;
  entries: ManifestEntry[];
  sha256: string;
  validators: ManifestValidators;
}

// Preserve the previous downloader's manifest body limit for custom libraries.
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function manifestUrls(config: Config): Record<ManifestEndpoint, string> {
  const repo = config.githubRepo?.split("/");
  if (!repo || repo.length !== 2 || repo.some(part => !part || part === "." || part === "..")) {
    throw new Error("A GitHub owner/repository is required to fetch the manifest");
  }
  const encodedRepo = repo.map(encodeURIComponent).join("/");
  const prefix = config.githubPath.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  const path = `${prefix && prefix !== "." ? `${prefix}/` : ""}skills_manifest.json`;
  const segments = path.split("/");
  if (segments.some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid GitHub manifest path");
  }
  const encodedPath = segments.map(encodeURIComponent).join("/");
  const branch = config.githubBranch ?? "main";
  return {
    raw: `https://raw.githubusercontent.com/${encodedRepo}/${encodeURIComponent(branch)}/${encodedPath}`,
    contents: `https://api.github.com/repos/${encodedRepo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
  };
}

function parseText(text: string): ManifestEntry[] {
  try { return parseManifest(JSON.parse(text)); } catch (error) {
    throw new Error(`Fetched manifest failed validation: ${message(error)}`);
  }
}

function readCache(snapshot: ManifestCacheSnapshot | undefined, urls: Record<ManifestEndpoint, string>): ValidCache | undefined {
  if (!snapshot) return undefined;
  try {
    if (Buffer.byteLength(snapshot.text) > MAX_MANIFEST_BYTES) return undefined;
    const entries = parseText(snapshot.text);
    const sha256 = digest(snapshot.text);
    const validators: ManifestValidators = {};
    for (const endpoint of ["raw", "contents"] as const) {
      const value = snapshot.validators?.[endpoint];
      if (!value || value.url !== urls[endpoint] || value.bodySha256 !== sha256) continue;
      const etag = typeof value.etag === "string" && value.etag ? value.etag : undefined;
      const lastModified = typeof value.lastModified === "string" && value.lastModified ? value.lastModified : undefined;
      if (etag || lastModified) validators[endpoint] = { url: value.url, bodySha256: sha256, etag, lastModified };
    }
    return { text: snapshot.text, entries, sha256, validators };
  } catch {
    // A corrupt cache supplies neither validators nor downgrade protection.
    return undefined;
  }
}

/** Read under the race's deadline, including a stalled body after headers. */
async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_MANIFEST_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new Error("Manifest response exceeds the 64 MiB limit");
  }
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancelBody = (reason: unknown) => cancellation ??= reader.cancel(reason).catch(() => {});
  const cancel = () => { void cancelBody(signal.reason); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_MANIFEST_BYTES) throw new Error("Manifest response exceeds the 64 MiB limit");
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch (error) {
    await cancelBody(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function fetchCandidate(
  candidate: Candidate, config: Config, cache: ValidCache | undefined, signal: AbortSignal,
): Promise<ManifestFetchResult> {
  const group = JSON.stringify([config.manifestPath, config.githubRepo, config.githubBranch ?? "main", config.githubPath]);
  return runHttpRequest({ kind: "manifest", group, signal }, async () => {
    const endpoint = candidate.endpoint;
    const validator = endpoint ? cache?.validators[endpoint] : undefined;
    const headers: Record<string, string> = {};
    if (endpoint && config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    if (endpoint === "contents") headers.Accept = "application/vnd.github.raw+json";
    if (validator?.etag) headers["If-None-Match"] = validator.etag;
    else if (validator?.lastModified) headers["If-Modified-Since"] = validator.lastModified;
    const response = await fetch(candidate.url, { headers, signal });
    if (signal.aborted) await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    if (response.status === 304 || !response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status !== 304) throw new Error(`HTTP ${response.status}`);
      if (!endpoint || !cache || !validator) throw new Error("Unexpected 304 without a matching endpoint and cached body");
      return { text: cache.text, entries: cache.entries, source: endpoint, notModified: true,
        validators: { ...cache.validators, [endpoint]: { ...validator,
          etag: response.headers.get("etag") ?? validator.etag,
          lastModified: response.headers.get("last-modified") ?? validator.lastModified,
        } } };
    }
    const text = await responseText(response, signal);
    const entries = parseText(text);
    const sha256 = digest(text);
    const validators: ManifestValidators = cache?.sha256 === sha256 ? { ...cache.validators } : {};
    if (endpoint) {
      // A full response replaces this endpoint's validators, including removing
      // obsolete ones when the server no longer sends either header.
      delete validators[endpoint];
      const etag = response.headers.get("etag") ?? undefined;
      const lastModified = response.headers.get("last-modified") ?? undefined;
      if (etag || lastModified) validators[endpoint] = { url: candidate.url, bodySha256: sha256, etag, lastModified };
    }
    return { text, entries, source: endpoint ?? "mirror", notModified: false, validators };
  }, config.downloadConcurrency);
}

/** First valid complete body wins; every failure advances all remaining nodes. */
function raceCandidates(
  candidates: Candidate[], timeoutMs: number, hedgeDelayMs: number | undefined,
  config: Config, cache: ValidCache | undefined,
): Promise<ManifestFetchResult> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const failures: string[] = [];
    let settled = false;
    let next = 0;
    let pending = 0;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (winner?: AbortController) => {
      if (hedgeTimer !== undefined) clearTimeout(hedgeTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      for (const controller of controllers) if (controller !== winner) controller.abort();
    };
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${reason}${failures.length ? ` ${failures.join("; ")}` : ""}`));
    };
    const launch = () => {
      if (settled || next === candidates.length) return;
      const candidate = candidates[next++];
      const controller = new AbortController();
      controllers.push(controller);
      pending++;
      void fetchCandidate(candidate, config, cache, controller.signal).then(result => {
        if (settled) return;
        settled = true;
        cleanup(controller);
        resolve(result);
      }, error => {
        if (settled) return;
        pending--;
        failures.push(`[${candidate.name}] ${message(error)}`);
        launchRest();
        if (!pending) fail("All download nodes failed to fetch manifest.");
      });
    };
    const launchRest = () => {
      if (settled) return;
      if (hedgeTimer !== undefined) clearTimeout(hedgeTimer);
      while (next < candidates.length) launch();
    };
    deadlineTimer = setTimeout(() => fail(`Manifest fetch timed out after ${timeoutMs}ms.`), timeoutMs);
    if (hedgeDelayMs === undefined) launchRest();
    else {
      launch();
      if (next < candidates.length) hedgeTimer = setTimeout(launchRest, Math.min(hedgeDelayMs, timeoutMs / 4));
    }
  });
}

/**
 * Prefer either authoritative GitHub endpoint before using public mirrors.
 * Mirrors bootstrap fresh/invalid caches only: without a monotonic source
 * revision, a different valid mirror response cannot prove it is newer.
 * This function never persists data or suppresses an explicit refresh error.
 */
export async function fetchRemoteManifest(config: Config, options: ManifestFetchOptions): Promise<ManifestFetchResult> {
  const timeout = options.authoritativeTimeoutMs;
  const hedgeDelay = options.hedgeDelayMs ?? 800;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(hedgeDelay) || hedgeDelay < 0) {
    throw new Error("Manifest timeout must be positive and hedge delay non-negative, both finite");
  }
  const urls = manifestUrls(config);
  const cache = readCache(options.cached, urls);
  let authoritativeError: unknown;
  try {
    return await raceCandidates([
      { name: "GitHub raw", url: urls.raw, endpoint: "raw" },
      { name: "GitHub Contents API", url: urls.contents, endpoint: "contents" },
    ], timeout, hedgeDelay, config, cache);
  } catch (error) {
    authoritativeError = error;
    if (cache || options.allowMirrors === false) throw error;
  }

  const rawPath = urls.raw.slice("https://raw.githubusercontent.com/".length);
  const repo = config.githubRepo!.split("/").map(encodeURIComponent).join("/");
  const branch = encodeURIComponent(config.githubBranch ?? "main");
  const path = rawPath.slice(`${repo}/${branch}/`.length);
  const mirrors: Candidate[] = [
    ...(config.useOfficialMirror ? [{ name: "Official CN", url: `https://gh.251716.xyz/${rawPath}` }] : []),
    { name: "jsDelivr", url: `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}` },
    { name: "gh-proxy.com", url: `https://gh-proxy.com/${urls.raw}` },
    { name: "ghfast.top", url: `https://ghfast.top/${urls.raw}` },
  ];
  const mirrorTimeout = config.downloadTimeout || 30000;
  if (!Number.isFinite(mirrorTimeout) || mirrorTimeout <= 0) throw new Error("Manifest mirror timeout must be positive and finite");
  try {
    return await raceCandidates(mirrors, mirrorTimeout, config.useOfficialMirror && config.hedgeEnabled ? 400 : undefined, config, undefined);
  } catch (error) {
    throw new Error(`${message(authoritativeError)} Mirror fallback: ${message(error)}`);
  }
}
