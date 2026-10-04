"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Hand } from "lucide-react";

// Evaluate is intentionally not linked here: it's a team tool, still reachable at /evaluate.
const LINKS: { href: string; label: string; short?: string }[] = [
  { href: "/", label: "Communicate" },
  { href: "/teach", label: "Teach a sign", short: "Teach" },
  { href: "/calibrate", label: "Calibrate letters", short: "Calibrate" },
];

/**
 * Floating nav in the portfolio's style: a frosted blur strip along the top edge with two pills on it.
 * Desktop: [wordmark + links] centered, call-to-action on the right. Phones: a hand mark and the links.
 */
export default function NavBar() {
  const path = usePathname();
  const links = (
    <nav aria-label="Main" className="flex gap-4 text-sm sm:gap-6">
      {LINKS.map((l) => {
        const active = path === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`flex h-10 items-center whitespace-nowrap transition-colors duration-150 ${
              active ? "font-medium text-accent" : "text-muted hover:text-text"
            }`}
          >
            {l.short ? (
              <>
                <span className="sm:hidden">{l.short}</span>
                <span className="hidden sm:inline">{l.label}</span>
              </>
            ) : (
              l.label
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      <div className="nav-blur" aria-hidden="true">
        <div className="nav-blur-layer" />
        <div className="nav-blur-layer" />
        <div className="nav-blur-layer" />
        <div className="nav-blur-layer" />
      </div>

      <header className="fixed inset-x-0 top-7 z-50 px-4">
        {/* Phones */}
        <div className="flex gap-2 sm:hidden">
          <Link
            href="/"
            aria-label="Said With Hands, home"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-border bg-surface text-text"
          >
            <Hand size={20} strokeWidth={1.5} aria-hidden />
          </Link>
          <div className="flex h-10 flex-1 items-center justify-around rounded-control border border-border bg-surface px-4">
            {links}
          </div>
        </div>

        {/* Tablet and up */}
        <div className="mx-auto hidden w-full max-w-[1280px] grid-cols-[1fr_auto_1fr] items-center gap-3 sm:grid md:px-2">
          <div className="col-start-2 flex h-10 items-center gap-8 rounded-control border border-border bg-surface px-6 whitespace-nowrap">
            <Link href="/" className="text-base font-semibold tracking-tight" aria-label="Said With Hands, home">
              Said With Hands
            </Link>
            {links}
          </div>
          <Link
            href="/#communicate"
            className="col-start-3 hidden h-10 items-center gap-3 justify-self-end rounded-control border border-border bg-surface py-1 pr-1 pl-4 text-sm font-medium whitespace-nowrap transition-colors duration-150 hover:bg-surface-2 lg:inline-flex"
          >
            Start signing
            <span className="flex h-8 w-8 items-center justify-center rounded-control bg-accent text-accent-fg">
              <ArrowRight size={16} strokeWidth={1.5} aria-hidden />
            </span>
          </Link>
        </div>
      </header>
    </>
  );
}
