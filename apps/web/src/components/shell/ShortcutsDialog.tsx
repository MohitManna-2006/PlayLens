import { Dialog } from "@/components/ui/Dialog";

const GROUPS: Array<{ title: string; note?: string; rows: Array<[string, string]> }> = [
  {
    title: "Replay",
    note: "Active while the replay workspace has focus and no text field or menu is open.",
    rows: [
      ["Space", "Play or pause"],
      ["← / →", "Previous or next valid frame"],
      ["Shift + ← / →", "Back or forward one second"],
      ["Home / End", "First or last valid frame"],
      ["Escape", "Close the most local layer, then clear player selection"],
    ],
  },
  {
    title: "PlayLab",
    note: "When the modified defender control has focus.",
    rows: [
      ["Arrow keys", "Move 0.25 yd"],
      ["Shift + arrow keys", "Move 1 yd"],
    ],
  },
  {
    title: "Analyst composer",
    rows: [
      ["Enter", "Send question"],
      ["Shift + Enter", "New line"],
    ],
  },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <div className="space-y-6">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="text-panel font-semibold">{g.title}</h3>
            {g.note && <p className="mt-1 text-caption text-muted">{g.note}</p>}
            <dl className="mt-2">
              {g.rows.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-0">
                  <dt className="text-body-2 text-fg-2">{v}</dt>
                  <dd>
                    <kbd className="num rounded-control bg-surface px-2 py-0.5 text-meta text-fg">{k}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
