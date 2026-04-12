import { cn } from "@/lib/utils";

/** Diagonal streak top-left → bottom-right on successful transfer. Remounts when `launchKey` increments. */
export function TxShootingStar({
  launchKey,
  className,
}: {
  launchKey: number;
  className?: string;
}) {
  if (launchKey <= 0) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-[100050] overflow-hidden",
        className,
      )}
      aria-hidden
    >
      <div key={launchKey} className="cosmic-shooting-star">
        <div className="cosmic-shooting-star__glow" />
        <div className="cosmic-shooting-star__streak" />
      </div>
    </div>
  );
}
