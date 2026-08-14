import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { Button } from "@/app/components/ui/button";

describe("Button", () => {
  it("renders children text", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText("Click me")).toBeInTheDocument();
  });

  it("applies correct classes for default variant", () => {
    render(<Button>Default</Button>);
    const btn = screen.getByText("Default");
    expect(btn.className).toContain("bg-primary");
  });

  it("applies correct classes for ghost variant", () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByText("Ghost");
    expect(btn.className).toContain("hover:bg-muted");
  });

  it("applies correct classes for outline variant", () => {
    render(<Button variant="outline">Outline</Button>);
    const btn = screen.getByText("Outline");
    expect(btn.className).toContain("border");
    expect(btn.className).toContain("bg-transparent");
  });

  it("applies correct classes for icon size", () => {
    render(<Button size="icon">I</Button>);
    const btn = screen.getByText("I");
    expect(btn.className).toContain("h-10");
    expect(btn.className).toContain("w-10");
  });

  it("applies correct classes for sm size", () => {
    render(<Button size="sm">Small</Button>);
    const btn = screen.getByText("Small");
    expect(btn.className).toContain("h-9");
  });

  it("applies correct classes for lg size", () => {
    render(<Button size="lg">Large</Button>);
    const btn = screen.getByText("Large");
    expect(btn.className).toContain("h-11");
  });

  it("forwards ref to HTMLButtonElement", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("handles disabled state", () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByText("Disabled");
    expect(btn).toBeDisabled();
    expect(btn.className).toContain("disabled:opacity-50");
  });
});
