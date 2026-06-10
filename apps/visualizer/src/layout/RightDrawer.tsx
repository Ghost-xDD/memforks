import { useUiStore } from "../state/uiStore.js";
import { useDagStore } from "../state/dagStore.js";
import CommitInspector  from "../drawers/CommitInspector.js";
import ProposalInspector from "../drawers/ProposalInspector.js";
import "./RightDrawer.css";

export default function RightDrawer() {
  const panel       = useUiStore((s) => s.panel);
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const proposals   = useDagStore((s) => s.proposals);

  const isOpen = panel !== null;

  return (
    <aside className={`right-drawer ${isOpen ? "open" : ""}`} aria-label="Commit inspector">
      <div className="drawer-toolbar">
        <span className="drawer-title">
          {panel?.kind === "anchor"   && "Merge Anchor"}
          {panel?.kind === "proposal" && "Merge Proposal"}
          {!panel && "Inspector"}
        </span>
        <button className="icon-btn" onClick={closeDrawer} aria-label="Close inspector" title="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <line x1="1" y1="1" x2="13" y2="13" />
            <line x1="13" y1="1" x2="1" y2="13" />
          </svg>
        </button>
      </div>

      <div className="drawer-body">
        {panel?.kind === "anchor" && (
          <CommitInspector anchor={panel.anchor} />
        )}
        {panel?.kind === "proposal" && (
          <ProposalInspector proposal={panel.proposal} />
        )}
      </div>

      {/* Proposal quick-access list at the bottom when drawer is open */}
      {panel?.kind === "anchor" && proposals.size > 0 && (
        <div className="drawer-proposals-footer">
          <p className="drawer-proposals-label">Open proposals</p>
          <ul className="drawer-proposals-list">
            {Array.from(proposals.values())
              .filter((p) => p.status === "pending")
              .map((p) => (
                <li key={p.id}>
                  <button
                    className="drawer-proposal-chip"
                    onClick={() => useUiStore.getState().openProposal(p)}
                  >
                    <span className="chip orange">PENDING</span>
                    <span>{p.from_branch} → {p.into_branch}</span>
                    <span>{p.attestations.length} attest</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
