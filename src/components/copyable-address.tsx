"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function shortAddr(addr: string) {
  return addr ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : "—";
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Full address, monospace, click copies. Tooltip: click hint / Copied! */
export function CopyableAddress({
  address,
  className,
  textClassName,
}: {
  address: string;
  className?: string;
  textClassName?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(address);
    if (ok) {
      setCopied(true);
      toast.success("Address copied");
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Could not copy");
    }
  }, [address]);

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        closeOnClick={false}
        className={cn(
          "hover:bg-muted/45 border-border/0 w-full rounded-md border px-1.5 py-1 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          className,
        )}
        onClick={() => void handleCopy()}
      >
        <span
          className={cn(
            "text-foreground block break-all font-mono leading-snug",
            textClassName,
          )}
        >
          {address}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-sm">
        {copied ? "Copied!" : "Click to copy address"}
      </TooltipContent>
    </Tooltip>
  );
}

/** Table cell: Ledger A/B label or shortened external addr; tooltip shows full pubkey; click copies. */
export function TxAddressCell({
  addr,
  addrA,
  addrB,
}: {
  addr: string;
  addrA: string;
  addrB: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(addr);
    if (ok) {
      setCopied(true);
      toast.success("Address copied");
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Could not copy");
    }
  }, [addr]);

  if (!addr) return <span className="text-muted-foreground">—</span>;

  const display =
    addr === addrA ? (
      <span className="text-primary font-semibold">Ledger A</span>
    ) : addr === addrB ? (
      <span className="font-semibold text-violet-400">Ledger B</span>
    ) : (
      <span>{shortAddr(addr)}</span>
    );

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        closeOnClick={false}
        className="hover:bg-muted/35 text-foreground max-w-[200px] truncate rounded px-1 py-0.5 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:max-w-[220px]"
        onClick={() => void handleCopy()}
      >
        {display}
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[min(90vw,28rem)]">
        <p className="text-background break-all font-mono text-[11px] leading-relaxed">
          {addr}
        </p>
        <p className="text-background/75 mt-1.5 text-[10px]">
          {copied ? "Copied!" : "Click to copy"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
