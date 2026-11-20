import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistantErrorCard from "./AssistantErrorCard";

afterEach(cleanup);

describe("assistant error cards", () => {
  it("shows a descriptive database error and only retries after an explicit click", () => {
    const retry = vi.fn();
    render(
      <AssistantErrorCard
        error="database is locked"
        context="history"
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      "Workspace database busy",
    );
    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-error-code",
      "database_busy",
    );
    expect(screen.getByText(/Wait a few seconds/)).toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not offer an unsafe retry without a callback or for errors needing a settings change", () => {
    const { rerender } = render(
      <AssistantErrorCard error="Connection refused" />,
    );
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    rerender(
      <AssistantErrorCard error="HTTP 401 Unauthorized" onRetry={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      "AI sign-in or API key required",
    );
  });

  it("keeps model diagnostics collapsed and renders technical text without Markdown or HTML", () => {
    render(
      <AssistantErrorCard
        error={
          'AI endpoint returned an error (HTTP 400). {"error":"No models loaded <img src=x onerror=alert(1)>"}'
        }
        context="response"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No AI model loaded" }),
    ).toBeInTheDocument();
    const details = screen.getByText("Technical details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(details?.querySelector("img")).toBeNull();
    expect(details?.querySelector("pre")?.textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
    expect(screen.getByText(/For LM Studio or Unsloth/)).toBeInTheDocument();
  });

  it("uses a source-specific card without echoing attached content", () => {
    render(
      <AssistantErrorCard
        error={{
          message: "Unknown extraction failure",
          content: "PRIVATE-FILE-CONTENT",
          request: { prompt: "PRIVATE-PROMPT" },
        }}
        context="sources"
      />,
    );
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      "Source could not be included",
    );
    expect(document.body.textContent).not.toContain("PRIVATE-");
  });
});
