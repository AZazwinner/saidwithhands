import Link from "next/link";

export default function Footer() {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 py-12 md:flex-row md:justify-between md:px-6">
        <div className="flex max-w-[56ch] flex-col gap-2">
          <p className="text-base font-semibold tracking-tight">Said With Hands</p>
          <p className="text-sm text-muted">
            A communication aid that recognizes fingerspelling and signs you teach it. Video is processed on your
            device; only text goes to Google Gemini and ElevenLabs.
          </p>
        </div>
        <nav aria-label="Footer" className="flex gap-6 text-sm text-muted">
          <Link href="/" className="hover:text-text">
            Communicate
          </Link>
          <Link href="/teach" className="hover:text-text">
            Teach a sign
          </Link>
          <Link href="/calibrate" className="hover:text-text">
            Calibrate letters
          </Link>
        </nav>
      </div>
    </footer>
  );
}
