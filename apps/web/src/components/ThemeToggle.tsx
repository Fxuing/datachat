import { Moon, Sun } from "lucide-react";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "切换到浅色主题" : "切换到深色主题"}
      aria-label={dark ? "切换到浅色主题" : "切换到深色主题"}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors",
        "hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
