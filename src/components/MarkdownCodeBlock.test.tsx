import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "./Editor";

afterEach(cleanup);
it("copies a Markdown code block without its fences or surrounding response text", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    <Markdown
      content={
        "Explanation outside the block.\n\n```markdown\n# Prijedlog\n\nČitav sadržaj.\n```"
      }
    />,
  );
  await user.click(screen.getByRole("button", { name: "Copy Markdown" }));
  expect(copy).toHaveBeenCalledWith("# Prijedlog\n\nČitav sadržaj.\n");
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
});
it("shows an actionable clipboard error and keeps code markup inert", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("Clipboard unavailable"),
  );
  render(
    <Markdown content={'```html\n<script>alert("example")</script>\n```'} />,
  );
  await user.click(screen.getByRole("button", { name: "Copy html" }));
  expect(screen.getByRole("alert")).toHaveTextContent("copy it manually");
  expect(document.querySelector("script")).toBeNull();
});
