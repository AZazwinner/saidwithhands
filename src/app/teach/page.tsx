import type { Metadata } from "next";
import Teacher from "@/components/Teacher";

export const metadata: Metadata = { title: "Teach a sign · Said With Hands" };

export default function TeachPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-8 px-4 pt-28 pb-16 md:px-6">
      <div>
        <h1 className="page-title">Teach a sign</h1>
        <p className="mt-2 max-w-[64ch] text-sm text-pretty text-muted">
          Show it 5–10 times and it&apos;s recognized right away, with no training step. Movements it
          wasn&apos;t taught are rejected rather than guessed. Stays on this device.
        </p>
      </div>
      <Teacher />
    </main>
  );
}
