import type { UIMessage } from "ai";

const PREFIX = "memforks:thread:";

export function saveThread(branch: string, messages: UIMessage[]): void {
  if (typeof window === "undefined" || messages.length === 0) {
    if (typeof window !== "undefined") localStorage.removeItem(PREFIX + branch);
    return;
  }
  try {
    localStorage.setItem(PREFIX + branch, JSON.stringify(messages));
  } catch {
    // quota exceeded — silently skip
  }
}

export function loadThread(branch: string): UIMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PREFIX + branch);
    return raw ? (JSON.parse(raw) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

export function clearThread(branch: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(PREFIX + branch);
}
