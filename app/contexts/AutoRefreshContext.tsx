"use client";

import React, { createContext, useContext, useState } from "react";

interface AutoRefreshContextType {
  intervalSec: number;
  setIntervalSec: (sec: number) => void;
}

const AutoRefreshContext = createContext<AutoRefreshContextType | undefined>(undefined);

export function useAutoRefresh() {
  const ctx = useContext(AutoRefreshContext);
  if (!ctx) throw new Error("useAutoRefresh must be used within AutoRefreshProvider");
  return ctx;
}

export function AutoRefreshProvider({ children }: { children: React.ReactNode }) {
  const [intervalSec, setIntervalSec] = useState(0);
  return (
    <AutoRefreshContext.Provider value={{ intervalSec, setIntervalSec }}>
      {children}
    </AutoRefreshContext.Provider>
  );
}
