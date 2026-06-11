import styles from "./header.module.css";

interface Props {
  branch: string;
  branches: string[];
  onBranchChange: (branch: string) => void;
  onNewChat: () => void;
  isForked: boolean;
}

export function Header({ branch, branches, onBranchChange, onNewChat, isForked }: Props) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <span className={styles.logo}>MemForks Chat</span>
        {isForked && <span className={styles.forkBadge} title="On a forked branch">⚡</span>}
      </div>

      <div className={styles.right}>
        <label className={styles.branchLabel}>
          branch:
          <select
            className={styles.branchSelect}
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        {branch !== "main" && (
          <button type="button" className={styles.mergeBtn} disabled title="Coming soon">
            Merge into main →
          </button>
        )}

        <button type="button" className={styles.newChatBtn} onClick={onNewChat}>
          New chat
        </button>
      </div>
    </header>
  );
}
