import styles from "./prompt-pills.module.css";

const PROMPTS = [
  "What do you remember from past sessions?",
  "Recap decisions made on this branch",
  "What should we focus on next?",
  "What patterns have you noticed in my work?",
];

interface Props {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}

export function PromptPills({ onSelect, disabled }: Props) {
  return (
    <div className={styles.pills}>
      {PROMPTS.map((p) => (
        <button
          key={p}
          type="button"
          className={styles.pill}
          onClick={() => onSelect(p)}
          disabled={disabled}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
