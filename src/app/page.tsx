"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface WalletInfo {
  address: string;
  balance: number;
}

interface BalanceResponse {
  ledgerA: WalletInfo;
  ledgerB: WalletInfo;
}

interface TransferResponse {
  signature?: string;
  error?: string;
}

export default function HomePage() {
  const [ledgerA, setLedgerA] = useState<WalletInfo | null>(null);
  const [ledgerB, setLedgerB] = useState<WalletInfo | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [sendingFrom, setSendingFrom] = useState<"A" | "B" | null>(null);

  const fetchBalances = useCallback(async () => {
    setLoadingBalances(true);
    try {
      const res = await fetch("/api/balance");
      const data = (await res.json()) as BalanceResponse;
      setLedgerA(data.ledgerA);
      setLedgerB(data.ledgerB);
    } catch {
      toast.error("Failed to fetch balances");
    } finally {
      setLoadingBalances(false);
    }
  }, []);

  useEffect(() => {
    void fetchBalances();
  }, [fetchBalances]);

  const handleTransfer = async (from: "A" | "B") => {
    setSendingFrom(from);
    try {
      const res = await fetch("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, amount: 0.01 }),
      });
      const data = (await res.json()) as TransferResponse;

      if (!res.ok || data.error) {
        toast.error(data.error ?? "Transfer failed");
        return;
      }

      toast.success(`Sent 0.01 SOL from Ledger ${from}`, {
        description: (
          <a
            href={`https://explorer.solana.com/tx/${data.signature}?cluster=testnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View on Explorer →
          </a>
        ),
      });

      await fetchBalances();
    } catch {
      toast.error("Network error");
    } finally {
      setSendingFrom(null);
    }
  };

  return (
    <main className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center p-8">
      <div className="w-full max-w-3xl space-y-8">
        {/* Header */}
        <div className="space-y-1 text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            crypt<span className="text-primary">X</span>
          </h1>
          <p className="text-muted-foreground text-sm">
            DIY Hardware Wallet — Solana Testnet
          </p>
          <Badge variant="outline" className="mt-1">
            testnet
          </Badge>
        </div>

        <Separator />

        {/* Ledger Cards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <LedgerCard
            label="Ledger A"
            deviceLabel="Arduino #1"
            wallet={ledgerA}
            loading={loadingBalances}
            sendingNow={sendingFrom === "A"}
            onSend={() => handleTransfer("A")}
          />
          <LedgerCard
            label="Ledger B"
            deviceLabel="Arduino #2"
            wallet={ledgerB}
            loading={loadingBalances}
            sendingNow={sendingFrom === "B"}
            onSend={() => handleTransfer("B")}
          />
        </div>

        {/* Refresh */}
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchBalances()}
            disabled={loadingBalances}
          >
            {loadingBalances ? "Refreshing…" : "Refresh Balances"}
          </Button>
        </div>

        <Separator />

        <p className="text-muted-foreground text-center text-xs">
          Each "Send 0.01 SOL" button transfers from that ledger to the other.
          <br />
          Fund both addresses from the{" "}
          <a
            href="https://faucet.solana.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Solana testnet faucet
          </a>
          .
        </p>
      </div>
    </main>
  );
}

function LedgerCard({
  label,
  deviceLabel,
  wallet,
  loading,
  sendingNow,
  onSend,
}: {
  label: string;
  deviceLabel: string;
  wallet: WalletInfo | null;
  loading: boolean;
  sendingNow: boolean;
  onSend: () => void;
}) {
  const shortAddress = wallet
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : "—";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{label}</CardTitle>
          <Badge variant="secondary">{deviceLabel}</Badge>
        </div>
        <CardDescription className="font-mono text-xs">
          {loading ? "Loading…" : shortAddress}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <p className="text-4xl font-bold tabular-nums">
          {loading || wallet === null ? (
            <span className="text-muted-foreground text-2xl">…</span>
          ) : (
            `${wallet.balance.toFixed(4)}`
          )}
        </p>
        <p className="text-muted-foreground text-sm">SOL</p>
      </CardContent>

      <CardFooter>
        <Button
          className="w-full"
          onClick={onSend}
          disabled={sendingNow || loading || wallet === null}
        >
          {sendingNow ? "Sending…" : "Send 0.01 SOL →"}
        </Button>
      </CardFooter>
    </Card>
  );
}
