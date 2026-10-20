export interface SkillDownloadProgress {
  name: string;
  done: number;
  total: number;
  message: string;
  updated_at: number;
  active: boolean;
}

const activeDownloads = new Map<string, SkillDownloadProgress>();

export function reportSkillDownloadProgress(name: string, done: number, total: number, message: string): void {
  const safeTotal = Math.max(1, Number.isFinite(total) ? total : 0);
  const safeDone = Math.max(0, Math.min(safeTotal, Number.isFinite(done) ? done : 0));
  activeDownloads.set(name, {
    name,
    done: safeDone,
    total: safeTotal,
    message,
    updated_at: Date.now(),
    active: true,
  });
}

export function readSkillDownloadProgress(name: string): SkillDownloadProgress | null {
  const progress = activeDownloads.get(name);
  if (!progress) return null;
  // A request may have disappeared without a terminal callback. Expose the
  // last snapshot briefly but never retain it indefinitely.
  if (Date.now() - progress.updated_at > 120_000) {
    activeDownloads.delete(name);
    return null;
  }
  return { ...progress };
}

export function finishSkillDownloadProgress(name: string): void {
  const progress = activeDownloads.get(name);
  if (!progress) return;
  const finishedAt = Date.now();
  activeDownloads.set(name, {
    ...progress,
    done: progress.total,
    updated_at: finishedAt,
    active: false,
  });
  const timer = setTimeout(() => {
    if (activeDownloads.get(name)?.updated_at === finishedAt) activeDownloads.delete(name);
  }, 10_000);
  timer.unref?.();
}
