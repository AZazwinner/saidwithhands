import Link from "next/link";
import { ArrowDown } from "lucide-react";
import HeroCaretField from "./HeroCaretField";

const STATS = [
  { value: "A–Z", label: "Fingerspelled letters" },
  { value: "5–10", label: "Examples to teach a sign" },
  { value: "0", label: "Video frames sent anywhere" },
];

/** The landing hero: grain and the sweeping dotted-line field behind the headline, stat tiles beside it. */
export default function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative flex min-h-[88dvh] items-center overflow-hidden border-b border-border bg-bg pt-32 pb-16"
    >
      <div className="noise-overlay" aria-hidden="true" />
      <HeroCaretField />

      <div className="relative z-10 mx-auto w-full max-w-[1280px] px-4 md:px-6">
        <div className="grid items-end gap-12 lg:grid-cols-[1fr_auto]">
          <div className="fade-in flex max-w-2xl flex-col gap-6">
            <p className="text-sm text-muted">Sign recognizer and communication aid</p>
            <h1
              id="hero-title"
              className="text-display tracking-tight text-balance"
              style={{ fontWeight: 400 }}
            >
              Said with hands.
              <br />
              Heard out loud.
            </h1>
            <p className="max-w-[56ch] text-base text-pretty text-muted">
              Your webcam recognizes ASL fingerspelling and the signs you teach it, builds a transcript, and
              speaks it. The other person&apos;s reply appears as captions.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link href="#communicate" className="btn btn-primary btn-lg">
                Start signing
                <ArrowDown size={20} strokeWidth={1.5} aria-hidden />
              </Link>
              <Link href="/teach" className="btn btn-secondary btn-lg">
                Teach a sign
              </Link>
            </div>
          </div>

          <dl className="fade-in grid w-full grid-cols-3 gap-3 lg:w-56 lg:grid-cols-1" style={{ animationDelay: "120ms" }}>
            {STATS.map((s) => (
              <div key={s.label} className="card flex flex-col gap-1 px-4 py-3">
                <dt className="order-2 text-xs text-muted">{s.label}</dt>
                <dd className="order-1 text-xl tabular-nums sm:text-2xl">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
