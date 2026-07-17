"use client";

import { useEffect } from "react";
import { captureClientEvent } from "@/lib/client-telemetry";
import { isAppError } from "@/lib/error-origin";

/**
 * Reports uncaught dashboard errors.
 *
 * Both listeners are page-global, so they also see failures from browser
 * extensions injected into the page (MetaMask and friends). Those are filtered
 * out — see lib/error-origin.ts — so this reports only our own failures.
 */
export function GlobalErrorListeners() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (
        !isAppError({
          stack: event.error?.stack,
          filename: event.filename,
          appOrigin: window.location.origin,
        })
      ) {
        return;
      }
      captureClientEvent("unhandled_exception", {
        error_message: event.message,
        error_name: event.error?.name,
        error_filename: event.filename,
        error_lineno: event.lineno,
        error_colno: event.colno,
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      // A rejection carries no filename, so the stack is the only evidence of
      // where it came from. A non-Error reason has none and stays unattributed.
      if (
        !isAppError({
          stack: reason instanceof Error ? reason.stack : undefined,
          appOrigin: window.location.origin,
        })
      ) {
        return;
      }
      captureClientEvent("unhandled_rejection", {
        error_message: reason instanceof Error ? reason.message : String(reason),
        error_name: reason instanceof Error ? reason.name : undefined,
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return null;
}
