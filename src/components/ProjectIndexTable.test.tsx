import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectIndexTable from "./ProjectIndexTable";
import type { ProjectIndexStats } from "../types";

const base: ProjectIndexStats = {
  projectId: "p",
  projectName: "Project",
  files: 0,
  folders: 2,
  contentFiles: 1,
  excludedEntries: 12,
  skippedFiles: 3,
  truncatedFiles: 1,
  lastIndexed: 1000,
  durationMs: 1500,
  status: "indexed",
  message: "",
};
const statistics = [
  {
    ...base,
    projectId: "ten",
    projectName: "Project 10",
    files: 10,
    lastIndexed: 3000,
    status: "error",
    message: "Drive unavailable; previous index retained.",
  },
  {
    ...base,
    projectId: "two",
    projectName: "Project 2",
    files: 2,
    lastIndexed: 2000,
    status: "cleared",
  },
  {
    ...base,
    projectId: "alpha",
    projectName: "Alpha",
    files: 1000,
    lastIndexed: 1000,
  },
];
const rowNames = () =>
  within(screen.getByRole("table", { name: "Project index statistics" }))
    .getAllByRole("rowheader")
    .map((cell) => cell.querySelector(".index-project-name")!.textContent);
afterEach(cleanup);

describe("project index table", () => {
  it("sorts numbers numerically, names naturally, and updated times in both directions", () => {
    render(
      <ProjectIndexTable
        statistics={statistics}
        disabled={false}
        operation=""
        onClear={vi.fn()}
        onReindex={vi.fn()}
      />,
    );
    expect(rowNames()).toEqual(["Alpha", "Project 2", "Project 10"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by files" }));
    expect(rowNames()).toEqual(["Alpha", "Project 10", "Project 2"]);
    expect(screen.getByRole("columnheader", { name: "Files" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort by files" }));
    expect(rowNames()).toEqual(["Project 2", "Project 10", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by updated" }));
    expect(rowNames()).toEqual(["Project 10", "Project 2", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by updated" }));
    expect(rowNames()).toEqual(["Alpha", "Project 2", "Project 10"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by status" }));
    expect(rowNames()).toEqual(["Project 2", "Project 10", "Alpha"]);
  });
  it("combines project and status filters, shows full error detail and counts, and scopes row actions", () => {
    const onClear = vi.fn();
    const onReindex = vi.fn();
    render(
      <ProjectIndexTable
        statistics={statistics}
        disabled={false}
        operation=""
        onClear={onClear}
        onReindex={onReindex}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Filter projects" }), {
      target: { value: " project " },
    });
    expect(rowNames()).toEqual(["Project 2", "Project 10"]);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Filter index status" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Error" }));
    expect(rowNames()).toEqual(["Project 10"]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 1 of 3 projects",
    );
    expect(
      screen.getByText("Drive unavailable; previous index retained."),
    ).toBeInTheDocument();
    const row = screen
      .getByRole("rowheader", { name: /Project 10/ })
      .closest("tr")!;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(expect.arrayContaining(["10", "2", "1", "12", "3"]));
    fireEvent.click(
      within(row).getByRole("button", { name: "Reindex Project 10" }),
    );
    fireEvent.click(
      within(row).getByRole("button", { name: "Clear index for Project 10" }),
    );
    expect(onReindex).toHaveBeenCalledWith(statistics[0]);
    expect(onClear).toHaveBeenCalledWith(statistics[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter projects" }), {
      target: { value: "missing" },
    });
    expect(
      screen.getByText(/No projects match these filters/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Clear filters",
      }),
    );
    expect(rowNames()).toHaveLength(3);
  });
  it("keeps selected status filters through polling and disables actions during maintenance", () => {
    const onClear = vi.fn();
    const props = {
      statistics,
      disabled: false,
      operation: "",
      onClear,
      onReindex: vi.fn(),
    };
    const { rerender } = render(<ProjectIndexTable {...props} />);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Filter index status" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Cleared" }));
    rerender(
      <ProjectIndexTable
        {...props}
        statistics={statistics.map((project) => ({
          ...project,
          status: "indexed",
        }))}
        disabled
        operation="all"
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Filter index status" }),
    ).toHaveValue("cleared");
    expect(
      screen.getByText(/No projects match these filters/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Clear filters",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Clear index for Project 10" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reindex Alpha" }),
    ).toBeDisabled();
    expect(onClear).not.toHaveBeenCalled();
  });
});
