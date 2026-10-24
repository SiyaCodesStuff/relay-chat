import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
const bootstrap = readFileSync(resolve(process.cwd(), "public/theme.js"), "utf8");
function run(preference: string | null, systemDark: boolean, blocked = false) {
  const toggle = vi.fn();
  const style = { colorScheme: "" };
  runInNewContext(bootstrap, {
    localStorage: {
      getItem: () => {
        if (blocked) throw new Error("Storage blocked");
        return preference;
      },
    },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: { documentElement: { classList: { toggle }, style } },
  });
  return { toggle, style };
}
describe("pre-paint theme bootstrap", () => {
  it("honors the saved choice ahead of the OS preference", () => {
    expect(run("light", true).toggle).toHaveBeenCalledWith("dark", false);
    expect(run("dark", false).style.colorScheme).toBe("dark");
  });
  it("uses system preference when storage is missing, invalid, or blocked", () => {
    for (const preference of [null, "invalid"])
      expect(run(preference, true).toggle).toHaveBeenCalledWith("dark", true);
    expect(run(null, true, true).style.colorScheme).toBe("dark");
  });
  it("loads as a blocking script in the head before the React entry", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const script = html.indexOf('<script src="/theme.js"></script>');
    expect(script).toBeGreaterThan(0);
    expect(script).toBeLessThan(html.indexOf("</head>"));
    expect(script).toBeLessThan(html.indexOf("/src/main.tsx"));
  });
});
