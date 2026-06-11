import type { Theme } from "@/lib/theme";
import styles from "./header.module.css";

interface Props {
  branch: string;
  branches: string[];
  onBranchChange: (branch: string) => void;
  onNewChat: () => void;
  onThemeToggle: () => void;
  theme: Theme;
  isForked: boolean;
  onShowDiff?: () => void;
  onMerge?: () => void;
  isMerging?: boolean;
}

export function Header({
  branch,
  branches,
  onBranchChange,
  onNewChat,
  onThemeToggle,
  theme,
  isForked,
  onShowDiff,
  onMerge,
  isMerging,
}: Props) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <span className={styles.mark} aria-hidden>
          ⑂
        </span>
        <span className={styles.logo}>MemForks Chat</span>
      </div>

      <div className={styles.right}>
        <div className={styles.branchPicker}>
          {isForked ? (
            <span className={styles.forkDot} title="On a forked branch" />
          ) : (
            <span className={styles.branchIcon} aria-hidden>
              ⑂
            </span>
          )}
          <select
            className={styles.branchSelect}
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
            aria-label="Active branch"
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <span className={styles.caret} aria-hidden>
            ▾
          </span>
        </div>

        {branch !== "main" && (
          <>
            <button
              type="button"
              className={styles.diffBtn}
              onClick={onShowDiff}
              title="Compare memory between this branch and main"
            >
              Diff
            </button>
            <button
              type="button"
              className={styles.mergeBtn}
              onClick={onMerge}
              disabled={isMerging}
              title="Merge this branch's memory into main"
            >
              {isMerging ? "Merging…" : "Merge → main"}
            </button>
          </>
        )}

        <button
          type="button"
          className={styles.themeBtn}
          onClick={onThemeToggle}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? (
            // Sun
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="2" />
              <path
                d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            // Moon
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>

        <button type="button" className={styles.newChatBtn} onClick={onNewChat}>
          New chat
        </button>
      </div>
    </header>
  );
}
