import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";

describe("web app smoke test", () => {
  it("renders the application entry point", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Your conversations start here." })).toBeTruthy();
  });
});
