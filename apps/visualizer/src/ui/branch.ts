/**
 * Branch display tone — calm-pass rule: only `main` gets the accent colour,
 * every other branch is neutral. The active branch context (dropdown, header)
 * provides orientation; per-row colour coding was noise.
 */
export function branchTone(branch: string): string {
  return branch === "main" ? "green" : "muted";
}
