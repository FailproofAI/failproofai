"use client";

import { useRouter } from "next/navigation";
import { useEffect, useCallback, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutoRefresh } from "@/app/contexts/AutoRefreshContext";

const AUTO_REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
  { label: "30s", value: 30 },
] as const;

interface RefreshButtonProps {
  className?: string;
}

export function RefreshButton({ className }: RefreshButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { intervalSec: autoInterval, setIntervalSec: setAutoInterval } = useAutoRefresh();

  const handleRefresh = useCallback((): void => {
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    if (autoInterval <= 0) return;
    const id = setInterval(handleRefresh, autoInterval * 1000);
    return () => clearInterval(id);
  }, [autoInterval, handleRefresh]);

  const isAutoActive = autoInterval > 0;

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border border-border bg-muted/50 p-0.5 gap-0.5",
        className,
      )}
    >
      <button
        onClick={handleRefresh}
        title="Refresh"
        className={cn(
          "inline-flex items-center justify-center rounded-md p-1.5 transition-colors",
          isAutoActive
            ? "text-primary hover:bg-primary/10"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )}
      >
        <RefreshCw
          className={cn("w-3.5 h-3.5", isPending && "animate-spin")}
        />
      </button>

      <div className="w-px h-4 bg-border" />

      <div className="inline-flex items-center gap-0.5" role="group" aria-label="Auto-refresh interval">
        {AUTO_REFRESH_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setAutoInterval(opt.value)}
            aria-pressed={autoInterval === opt.value}
            className={cn(
              "px-2 py-1 text-[11px] font-medium rounded-md transition-colors",
              autoInterval === opt.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
