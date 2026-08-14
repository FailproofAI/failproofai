import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { AutoRefreshProvider } from "@/app/contexts/AutoRefreshContext";

function Providers({ children }: { children: React.ReactNode }) {
  return <AutoRefreshProvider>{children}</AutoRefreshProvider>;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  return render(ui, { wrapper: Providers, ...options });
}
