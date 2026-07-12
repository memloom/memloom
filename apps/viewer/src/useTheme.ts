import { useEffect, useState } from "react";

// The active theme, live: watches data-theme on <html> so the canvas graph can re-palette
// when the toggle flips. index.html sets the attribute before first paint.
export function useTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  useEffect(() => {
    const el = document.documentElement;
    const read = () => setTheme(el.dataset.theme === "light" ? "light" : "dark");
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return theme;
}
