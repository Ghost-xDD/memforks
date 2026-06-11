import type { UIMessage } from "ai";
import type { RecalledFact } from "@/lib/memfork";
import { RecalledContext } from "./recalled-context";
import styles from "./message-list.module.css";

interface Props {
  messages: UIMessage[];
  recalledByMessageId: Record<string, RecalledFact[]>;
  branch: string;
  isLoading: boolean;
  onBranchFrom: (messageIndex: number) => void;
  branchingIndex: number | null;
}

function messageText(message: UIMessage): string {
  if (typeof message.content === "string") return message.content;
  const parts = message.parts?.filter((p) => p.type === "text") ?? [];
  return parts.map((p) => p.text).join("");
}

export function MessageList({
  messages,
  recalledByMessageId,
  branch,
  isLoading,
  onBranchFrom,
  branchingIndex,
}: Props) {
  if (messages.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>Start a conversation</p>
        <p className={styles.emptyHint}>
          Memory persists across sessions on branch <code>{branch}</code>.
          Branch from any reply to explore alternatives.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      {messages.map((message, index) => {
        const isUser = message.role === "user";
        const recalled = !isUser ? recalledByMessageId[message.id] : undefined;

        return (
          <div
            key={message.id}
            className={`${styles.message} ${isUser ? styles.user : styles.assistant}`}
          >
            <div className={styles.role}>{isUser ? "You" : "Agent"}</div>

            {!isUser && recalled && recalled.length > 0 && (
              <RecalledContext branch={branch} facts={recalled} />
            )}

            <div className={styles.content}>{messageText(message)}</div>

            {!isUser && (
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.branchBtn}
                  onClick={() => onBranchFrom(index)}
                  disabled={branchingIndex !== null}
                >
                  {branchingIndex === index ? "Branching…" : "Branch ↗"}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {isLoading && (
        <div className={`${styles.message} ${styles.assistant}`}>
          <div className={styles.role}>Agent</div>
          <div className={styles.typing}>Thinking…</div>
        </div>
      )}
    </div>
  );
}
