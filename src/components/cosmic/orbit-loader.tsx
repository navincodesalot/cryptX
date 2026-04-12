import { cn } from "@/lib/utils";

/** Space-themed loading indicator — pulsing ring + core (replaces generic spinners in UI). */
export function OrbitLoader({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex size-[1em] min-h-[1rem] min-w-[1rem] items-center justify-center align-middle",
        className,
      )}
      aria-hidden
    >
      <span
        className={cn(
          "absolute inset-0 animate-spin rounded-full border-2 border-sky-500/20 border-t-cyan-400 border-r-violet-400/85",
          "shadow-[0_0_12px_oklch(0.65_0.15_230/50%)]",
        )}
      />
      <span className="bg-cyan-200/90 size-1 rounded-full shadow-[0_0_8px_#67e8f9]" />
    </span>
  );
}
