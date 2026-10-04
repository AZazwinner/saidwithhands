import type { Metadata } from "next";
import Evaluator from "@/components/Evaluator";

export const metadata: Metadata = { title: "Evaluate · Said With Hands" };

export default function EvaluatePage() {
  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-8 px-4 pt-28 pb-16 md:px-6">
      <h1 className="page-title">Evaluate</h1>
      <Evaluator />
    </main>
  );
}
