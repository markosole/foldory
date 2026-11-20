import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppSelect, { type SelectOption } from "./AppSelect";

afterEach(cleanup);
const options: SelectOption[] = [
  { value: "a", label: "Alpha", group: "Projects" },
  { value: "offline", label: "Offline", disabled: true, group: "Projects" },
  { value: "b", label: "Beta", group: "Projects" },
  { value: "c", label: "Čapljina", keywords: "Herzegovina", group: "Archive" },
];
function Fixture({ searchable = false }: { searchable?: boolean }) {
  const [value, setValue] = useState("a");
  return (
    <>
      <AppSelect
        aria-label="Project"
        value={value}
        options={options}
        onChange={setValue}
        searchable={searchable}
      />
      <button>Next field</button>
    </>
  );
}

describe("shared select", () => {
  it("shows optional icons and descriptions while retaining exact accessible option labels", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppSelect
        aria-label="Access"
        value="read"
        options={[
          {
            value: "read",
            label: "Read only access",
            description: "Review every file change.",
            icon: <svg data-testid="read-shield" />,
          },
          {
            value: "full",
            label: "Full access",
            description: "Read and save project files.",
          },
        ]}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Access" }));
    const option = screen.getByRole("option", {
      name: "Read only access",
    });
    expect(option).toHaveAccessibleDescription("Review every file change.");
    expect(screen.getByTestId("read-shield")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Full access" }));
    expect(onChange).toHaveBeenCalledWith("full");
    expect(screen.getByRole("combobox", { name: "Access" })).toHaveFocus();
  });
  it("supports arrows, endpoints, typeahead, Enter and Escape without selecting disabled options", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const trigger = screen.getByRole("combobox", { name: "Project" });
    trigger.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(trigger).toHaveTextContent("Beta");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Home}{End}{Enter}");
    expect(trigger).toHaveTextContent("Čapljina");
    await user.keyboard("a{Enter}");
    expect(trigger).toHaveTextContent("Alpha");
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Offline" }));
    expect(trigger).toHaveTextContent("Alpha");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowDown}{Escape}");
    expect(trigger).toHaveTextContent("Alpha");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("searches labels, group names and keywords without committing until an option is chosen", async () => {
    const user = userEvent.setup();
    render(<Fixture searchable />);
    const trigger = screen.getByRole("combobox", { name: "Project" });
    await user.click(trigger);
    const search = screen.getByRole("searchbox", {
      name: "Search Project options",
    });
    expect(search).toHaveFocus();
    await user.type(search, "ČAP");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(trigger).toHaveTextContent("Alpha");
    await user.clear(search);
    await user.type(search, "herzegovina");
    await user.keyboard("{Enter}");
    expect(trigger).toHaveTextContent("Čapljina");
    await user.click(trigger);
    await user.type(screen.getByRole("searchbox"), "Projects");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "missing");
    expect(screen.getByRole("status")).toHaveTextContent("No matching options");
    await user.keyboard("{Enter}{Escape}");
    expect(trigger).toHaveTextContent("Čapljina");
    expect(trigger).toHaveFocus();
  });

  it("closes on outside clicks and Tab resumes after the control", async () => {
    const user = userEvent.setup();
    render(<Fixture searchable />);
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("button", { name: "Next field" })).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Next field" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent("Alpha");
  });

  it("handles refreshed and empty options and becomes disabled while open", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const props = {
      "aria-label": "Status",
      value: "a",
      options,
      onChange: change,
    };
    const { rerender } = render(<AppSelect {...props} />);
    await user.click(screen.getByRole("combobox"));
    rerender(<AppSelect {...props} options={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No options available",
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(change).not.toHaveBeenCalled();
    rerender(<AppSelect {...props} disabled />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("inherits disabled fieldsets and choosing an option never submits its form", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const change = vi.fn();
    const { rerender } = render(
      <form onSubmit={submit}>
        <fieldset disabled>
          <AppSelect
            aria-label="Status"
            value="a"
            options={options}
            onChange={change}
          />
        </fieldset>
      </form>,
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    rerender(
      <form onSubmit={submit}>
        <AppSelect
          aria-label="Status"
          value="a"
          options={options}
          onChange={change}
        />
      </form>,
    );
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(change).toHaveBeenCalledWith("b");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps dialog options inside the modal and Escape only closes the dropdown", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn();
    render(
      <dialog open onCancel={cancel}>
        <AppSelect
          aria-label="Template"
          value="a"
          options={options}
          onChange={vi.fn()}
          searchable
        />
      </dialog>,
    );
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByRole("listbox"),
    );
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByRole("searchbox"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });
});
