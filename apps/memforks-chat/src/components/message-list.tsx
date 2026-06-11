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
  if (messages.length === 0) return null;

  return (
    <div className={styles.thread}>
      {messages.map((message, index) => {
        const isUser = message.role === "user";

        if (isUser) {
          return (
            <div key={message.id} className={styles.userRow}>
              <div className={styles.userBubble}>{messageText(message)}</div>
            </div>
          );
        }

        const recalled = recalledByMessageId[message.id];

        return (
          <div key={message.id} className={styles.assistantRow}>
            {recalled && recalled.length > 0 && (
              <RecalledContext branch={branch} facts={recalled} />
            )}

            <div className={styles.assistantText}>{messageText(message)}</div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.branchBtn}
                onClick={() => onBranchFrom(index)}
                disabled={branchingIndex !== null}
                title="Start a new branch from this reply"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M6 3v12M6 15a6 6 0 0 0 6 6M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {branchingIndex === index ? "Branching…" : "Branch from here"}
              </button>
            </div>
          </div>
        );
      })}

      {isLoading && (
        <div className={styles.assistantRow}>
          <div className={styles.typing}>
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
    </div>
  );
}
