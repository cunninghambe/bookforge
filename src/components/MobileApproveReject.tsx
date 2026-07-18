// Amendment A15: the keyboard-driven approval checklists (LockPanel, ImportPanel,
// BibleImportPanel) work by focusing a proposal row and pressing "a" or "r". That
// has no on-screen affordance at all on a phone, so each row also gets this pair
// of 44px tap targets below the breakpoint (sm:hidden), wired to the exact same
// approve/reject setter the keyboard handler calls. Nothing about the gate
// changes: this is a second way to trigger the identical state update, not a new
// code path. Desktop is untouched, since the wrapper is hidden entirely at sm and
// up.
export function MobileApproveReject({
  approved,
  onApprove,
  onReject,
  testidPrefix,
}: {
  approved: boolean;
  onApprove: () => void;
  onReject: () => void;
  testidPrefix: string;
}) {
  return (
    <div className="mt-2 flex gap-2 sm:hidden">
      <button
        type="button"
        data-testid={`${testidPrefix}-approve-tap`}
        onClick={onApprove}
        disabled={approved}
        className="flex h-11 flex-1 items-center justify-center rounded border border-ok-edge bg-ok text-sm text-ok-ink disabled:opacity-40"
      >
        Approve
      </button>
      <button
        type="button"
        data-testid={`${testidPrefix}-reject-tap`}
        onClick={onReject}
        disabled={!approved}
        className="flex h-11 flex-1 items-center justify-center rounded border border-edge text-sm text-muted disabled:opacity-40"
      >
        Reject
      </button>
    </div>
  );
}
