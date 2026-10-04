import Communicator from "@/components/Communicator";
import Hero from "@/components/Hero";
import Marquee from "@/components/Marquee";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <Hero />
      <Marquee />
      <section
        id="communicate"
        aria-labelledby="communicate-title"
        className="mx-auto w-full max-w-[1280px] px-4 py-16 md:px-6"
      >
        <div className="mb-8 max-w-[64ch]">
          <h2 id="communicate-title" className="page-title">
            Start signing
          </h2>
          <p className="mt-2 text-sm text-pretty text-muted">
            Allow the camera, hold one hand up, and hold each letter until the ring fills. Speak reads the
            transcript aloud.
          </p>
        </div>
        <Communicator />
      </section>
    </main>
  );
}
