import { Moon, Sun } from "lucide-react";
import { useTheme } from "./useTheme";

// Theme switcher, same mechanism as the landing page: flips data-theme on <html> and
// persists the choice. No SSR here (Vite SPA), so the icon can render immediately.

export function ThemeToggle() {
  const theme = useTheme();

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("memloom-theme", next);
    } catch {
      // private mode: theme still applies for this visit
    }
  };

  return (
    <button
      type="button"
      className="themeToggle"
      onClick={toggle}
      aria-label="Toggle color theme"
      title="Toggle theme"
    >
      {theme === "dark" ? (
        <Sun size={15} strokeWidth={1.75} />
      ) : (
        <Moon size={15} strokeWidth={1.75} />
      )}
    </button>
  );
}
