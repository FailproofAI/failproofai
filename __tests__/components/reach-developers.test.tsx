import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReachDevelopers } from "@/components/reach-developers";

describe("ReachDevelopers", () => {
  it("renders trigger button", () => {
    render(<ReachDevelopers />);
    // The button has the Mail icon and "Reach Us" text (hidden on mobile)
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });

  it("dropdown hidden initially, shown on click", async () => {
    const user = userEvent.setup();
    render(<ReachDevelopers />);

    // Dropdown content should not be visible initially
    expect(screen.queryByText("Feedback & Issues")).not.toBeInTheDocument();

    // Click the trigger button
    const btn = screen.getAllByRole("button")[0];
    await user.click(btn);

    // Dropdown should now be visible with the current items
    expect(screen.getByText("Join our Discord")).toBeInTheDocument();
    expect(screen.getByText("Feedback & Issues")).toBeInTheDocument();
  });

  it("Discord link and the combined feedback/issues link point to the right places", async () => {
    const user = userEvent.setup();
    render(<ReachDevelopers />);

    const btn = screen.getAllByRole("button")[0];
    await user.click(btn);

    const discordLink = screen.getByText("Join our Discord").closest("a");
    expect(discordLink).toHaveAttribute("href", "https://discord.gg/2zjBZP7yQJ");

    const feedbackLink = screen.getByText("Feedback & Issues").closest("a");
    expect(feedbackLink).toHaveAttribute(
      "href",
      expect.stringContaining("github.com/FailproofAI/failproofai/issues/new/choose"),
    );
  });

  it("click outside closes dropdown", async () => {
    const user = userEvent.setup();
    const { container } = render(<ReachDevelopers />);

    // Open dropdown
    const btn = screen.getAllByRole("button")[0];
    await user.click(btn);
    expect(screen.getByText("Feedback & Issues")).toBeInTheDocument();

    // Click the backdrop overlay (the fixed inset-0 div rendered when open)
    const backdrop = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    await user.click(backdrop);
    expect(screen.queryByText("Feedback & Issues")).not.toBeInTheDocument();
  });

  // ARIA attribute tests
  it("button has aria-expanded=false when closed", () => {
    render(<ReachDevelopers />);
    const btn = screen.getAllByRole("button")[0];
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("button has aria-expanded=true when open", async () => {
    const user = userEvent.setup();
    render(<ReachDevelopers />);
    const btn = screen.getAllByRole("button")[0];
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("button has aria-haspopup=true", () => {
    render(<ReachDevelopers />);
    const btn = screen.getAllByRole("button")[0];
    expect(btn).toHaveAttribute("aria-haspopup", "true");
  });

  it("dropdown has role=menu when open", async () => {
    const user = userEvent.setup();
    render(<ReachDevelopers />);
    const btn = screen.getAllByRole("button")[0];
    await user.click(btn);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("menu items have role=menuitem", async () => {
    const user = userEvent.setup();
    render(<ReachDevelopers />);
    const btn = screen.getAllByRole("button")[0];
    await user.click(btn);
    const menuItems = screen.getAllByRole("menuitem");
    // Star, Documentation, Join our Discord, Feedback & Issues
    expect(menuItems).toHaveLength(4);
  });

  it("Escape key closes dropdown", async () => {
    const user = userEvent.setup();
    render(<ReachDevelopers />);
    const btn = screen.getAllByRole("button")[0];
    await user.click(btn);
    expect(screen.getByText("Feedback & Issues")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText("Feedback & Issues")).not.toBeInTheDocument();
  });
});
