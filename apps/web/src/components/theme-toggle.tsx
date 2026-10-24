import { useState } from "react";
import { Button } from "./ui/button.js";
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label="Dark theme"
      aria-pressed={dark}
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle("dark", next);
        document.documentElement.style.colorScheme = next ? "dark" : "light";
        try {
          localStorage.setItem("relay-theme", next ? "dark" : "light");
        } catch {
          /* Theme still works without storage. */
        }
        setDark(next);
      }}
    >
      {dark ? "Light theme" : "Dark theme"}
    </Button>
  );
}
