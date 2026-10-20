/**
 * Download deadline helpers.
 *
 * Problem they solve: a read_skill call on a huge skill can legitimately
 * run for minutes, and on pathological networks the per-file node timeouts
 * (up to 30s+) multiplied across a large file tree can hang a single call
 * for an hour. Clients that did NOT opt into progress notifications use a
 * ~60s request timeout, so the model never learns what happened — the call
 * just dies silently mid-download.
 *
 * Strategy (see Config.softDeadlineMs / hardDeadlineMs):
 *  - soft deadline (default 55s, no-progressToken clients only): return a
 *    structured partial-progress response just before typical client
 *    timeouts. The download KEEPS RUNNING in the background and writes
 *    into the cache; the next read_skill call resumes from it and usually
 *    returns complete.
 *  - hard deadline (default 285s, everyone): absolute guard against
 *    pathological hangs, and deliberately below common 300s client
 *    timeouts (e.g. Codex) so our partial response always lands first.
 */

export class DownloadDeadlineExceeded extends Error {
  constructor(
    public readonly kind: "soft" | "hard",
    public readonly deadlineMs: number
  ) {
    super(`download ${kind} deadline exceeded (${Math.round(deadlineMs / 1000)}s)`);
    this.name = "DownloadDeadlineExceeded";
  }
}

/**
 * Race a download promise against a deadline. On deadline the returned
 * promise rejects with DownloadDeadlineExceeded while the original download
 * continues unmanaged in the background (its later settlement is swallowed
 * here, so it never surfaces as an unhandled rejection).
 */
export function raceDownloadDeadline<T>(
  download: Promise<T>,
  deadlineMs: number,
  kind: "soft" | "hard"
): Promise<T> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return download;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DownloadDeadlineExceeded(kind, deadlineMs));
    }, deadlineMs);
    // Attach AFTER creating the timer: when the timer fires first, these
    // handlers still run later and are thereby "handled" (no-op on the
    // already-rejected outer promise).
    download.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        // Outer promise may already be rejected by the timer — rejecting
        // again is a no-op, and the error counts as handled either way.
        reject(error);
      }
    );
  });
}
