import type { RecalledFact } from "@/lib/memfork";
import styles from "./recalled-context.module.css";

interface Props {
  branch: string;
  facts: RecalledFact[];
}

export function RecalledContext({ branch, facts }: Props) {
  if (facts.length === 0) return null;

  return (
    <div className={styles.callout}>
      <div className={styles.label}>Recalled from {branch}</div>
      <ul className={styles.list}>
        {facts.map((f, i) => (
          <li key={i} className={styles.item}>
            {f.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
