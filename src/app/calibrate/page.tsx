import type { Metadata } from "next";
import Calibrator from "@/components/Calibrator";

export const metadata: Metadata = { title: "Calibrate letters · Said With Hands" };

export default function CalibratePage() {
  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-8 px-4 pt-28 pb-16 md:px-6">
      <div>
        <h1 className="page-title">Calibrate letters</h1>
        <p className="mt-2 max-w-[64ch] text-sm text-pretty text-muted">
          Teach the letters to your hand. Everything stays on this device unless you export it.
        </p>
      </div>
      <Calibrator />
    </main>
  );
}
