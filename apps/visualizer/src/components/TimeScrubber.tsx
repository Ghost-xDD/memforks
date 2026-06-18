/**
 * TimeScrubber — a horizontal range slider that scrubs through the off-chain
 * commit history of the active branch.
 *
 * - Dragging the thumb shows memory state as-of that commit (time-travel).
 * - Sliding to the rightmost position restores the live/tip view.
 * - The selected commit's timestamp and message are shown as a label.
 */

import type { OffChainCommit } from "../sui/types.js";
import "./TimeScrubber.css";

interface TimeScrubberProps {
  /** Total number of commits on this branch. */
  total:    number;
  /** Currently selected index (null = live/tip). */
  current:  number | null;
  /** Called when the user moves the thumb. null = live. */
  onChange: (idx: number | null) => void;
  /** Ordered commits oldest-first (used for the label). */
  commits:  OffChainCommit[];
  /** Whether the panel is visible. When false nothing is rendered. */
  open:     boolean;
}

function absTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function TimeScrubber({
  total,
  current,
  onChange,
  commits,
  open,
}: TimeScrubberProps) {
  if (!open) return null;
  // Slider value: 0..total. `total` means "live tip".
  const sliderVal = current === null ? total : current;
  const isLive    = current === null;
  const fillPct   = total > 0 ? (sliderVal / total) * 100 : 100;

  const commit = !isLive && commits[current ?? 0] ? commits[current!] : null;

  const label = isLive
    ? "Live"
    : commit
      ? `${absTime(commit.ts_ms)}  ·  ${commit.message.slice(0, 60)}`
      : `commit ${sliderVal + 1} of ${total}`;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = Number(e.target.value);
    onChange(val >= total ? null : val);
  }

  return (
    <div className="time-scrubber" role="group" aria-label="Time-travel scrubber">
      <div className="time-scrubber-track-row">
        <span className="time-scrubber-past-label">oldest</span>
        <input
          type="range"
          className="time-scrubber-input"
          min={0}
          max={total}
          step={1}
          value={sliderVal}
          onChange={handleChange}
          aria-label="Scrub to a point in history"
          style={{ ["--fill-pct" as string]: String(fillPct) }}
        />
        <span className={`time-scrubber-live-label ${isLive ? "active" : ""}`}>live</span>
      </div>
      <div className={`time-scrubber-label ${isLive ? "time-scrubber-label--live" : ""}`}>
        {isLive ? (
          <>
            <span className="time-scrubber-live-dot" aria-hidden />
            Showing live tip
          </>
        ) : (
          <>
            <span className="time-scrubber-at-glyph" aria-hidden>◷</span>
            {label}
          </>
        )}
      </div>
    </div>
  );
}
