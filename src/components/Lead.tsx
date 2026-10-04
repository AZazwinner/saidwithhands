import type { LucideIcon } from "lucide-react";

/**
 * A 16px icon leading a line of text, vertically centred on the first line (line box h-5 for 14px
 * text, h-4 for 12px, h-6 for 16px) so wrapped text and icon stay aligned without off-grid nudges.
 */
export default function Lead({
  icon: Icon,
  line = "h-5",
  className = "",
}: {
  icon: LucideIcon;
  line?: "h-4" | "h-5" | "h-6";
  className?: string;
}) {
  return (
    <span className={`flex shrink-0 items-center ${line}`}>
      <Icon size={16} strokeWidth={1.5} aria-hidden className={className} />
    </span>
  );
}
