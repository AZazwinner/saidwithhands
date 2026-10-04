const ITEMS = [
  "Runs in your browser",
  "No video leaves your device",
  "Teach it a new sign in seconds",
  "Best guess, with the raw signs always shown",
  "Spoken aloud",
  "Their reply, captioned",
];

function Track({ duplicate }: { duplicate?: boolean }) {
  return (
    <div
      className={`flex shrink-0 items-center py-4 ${duplicate ? "marquee-dup" : ""}`}
      aria-hidden={duplicate || undefined}
    >
      {ITEMS.map((item) => (
        <span key={item} className="flex items-center whitespace-nowrap">
          <span className="text-sm text-muted">{item}</span>
          <span aria-hidden className="mx-8 h-1 w-1 shrink-0 rounded-full bg-accent" />
        </span>
      ))}
    </div>
  );
}

/** A slow ticker of what the app does, between the hero and the tool (as on Cascadex). */
export default function Marquee() {
  return (
    <div className="marquee overflow-hidden border-y border-border bg-surface" aria-label="What it does">
      <div className="marquee-track">
        <Track />
        <Track duplicate />
      </div>
    </div>
  );
}
