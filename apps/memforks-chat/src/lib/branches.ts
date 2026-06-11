const STORAGE_KEY = "memforks-chat:branches";

export function loadBranches(): string[] {
  if (typeof window === "undefined") return ["main"];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : ["main"];
    return list.includes("main") ? list : ["main", ...list];
  } catch {
    return ["main"];
  }
}

export function saveBranches(branches: string[]): void {
  if (typeof window === "undefined") return;
  const unique = Array.from(new Set(["main", ...branches]));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(unique));
}

export function addBranch(name: string): string[] {
  const next = Array.from(new Set([...loadBranches(), name]));
  saveBranches(next);
  return next;
}
