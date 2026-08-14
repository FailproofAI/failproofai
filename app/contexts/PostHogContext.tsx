"use client";

import React, { createContext, useContext, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { getTelemetryConfig } from "@/app/actions/get-telemetry-config";
import {
  setClientTelemetryConfig,
  captureClientEvent,
} from "@/lib/client-telemetry";

interface PostHogContextType {
  capture: (event: string, properties?: Record<string, unknown>) => void;
}

const PostHogContext = createContext<PostHogContextType | undefined>(undefined);

export function usePostHog(): PostHogContextType {
  const context = useContext(PostHogContext);
  if (context === undefined) {
    throw new Error("usePostHog must be used within a PostHogProvider");
  }
  return context;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const prevPathRef = useRef<string | null>(null);
  const configLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getTelemetryConfig().then((cfg) => {
      if (cancelled) return;
      setClientTelemetryConfig(cfg);
      configLoadedRef.current = true;
      // Fire initial pageview after config loads
      captureClientEvent("$pageview");
      prevPathRef.current = window.location.pathname;
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!configLoadedRef.current) return;
    if (prevPathRef.current === pathname) return;
    prevPathRef.current = pathname;
    captureClientEvent("$pageview");
  }, [pathname]);

  const capture = React.useCallback(
    (event: string, properties?: Record<string, unknown>) => {
      captureClientEvent(event, properties);
    },
    [],
  );

  return (
    <PostHogContext.Provider value={{ capture }}>
      {children}
    </PostHogContext.Provider>
  );
}
