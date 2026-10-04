import { ShieldCheck } from "lucide-react";

/** The status line under the camera: what stays on the device and what is sent as text. */
export default function PrivacyNote({ part = "full" }: { part?: "full" | "short" | "detail" }) {
  return (
    <p className="flex items-start gap-2 text-xs text-muted">
      <ShieldCheck size={16} strokeWidth={1.5} aria-hidden className="shrink-0" />
      <span>
        {part !== "detail" && <span className="font-medium">On-device. No video leaves this device.</span>}
        {part !== "short" && (
          <>
            {part === "full" && " "}
            Only text is sent: recognized signs to Google Gemini for the best guess, and the sentence to
            ElevenLabs for the voice. Reply captions use your browser&apos;s speech service.
          </>
        )}
      </span>
    </p>
  );
}
