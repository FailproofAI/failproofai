import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DatePickerInput from "@/app/components/date-picker-input";

describe("DatePickerInput", () => {
  it('renders type="date" input', () => {
    render(<DatePickerInput id="test-date" value={null} onChange={vi.fn()} />);
    const input = document.getElementById("test-date") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe("date");
  });

  it("displays formatted date when value provided", () => {
    const date = new Date("2024-06-15T00:00:00Z");
    render(<DatePickerInput id="test-date" value={date} onChange={vi.fn()} />);
    const input = document.getElementById("test-date") as HTMLInputElement;
    expect(input.value).toBe("2024-06-15");
  });

  it("calls onChange on value change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePickerInput id="test-date" value={null} onChange={onChange} />);
    const input = document.getElementById("test-date") as HTMLInputElement;
    await user.type(input, "2024-06-15");
    expect(onChange).toHaveBeenCalled();
  });

  it("renders with correct id", () => {
    render(<DatePickerInput id="my-date-picker" value={null} onChange={vi.fn()} />);
    expect(document.getElementById("my-date-picker")).not.toBeNull();
  });
});
