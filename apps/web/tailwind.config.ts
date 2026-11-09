import type { Config } from "tailwindcss";

/**
 * Semantic design tokens. Every colour reads from a CSS variable defined in
 * `index.css`, so light/dark themes switch by toggling `.dark` on <html>
 * without touching component code.
 */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        subtle: "rgb(var(--subtle) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        inksoft: "rgb(var(--ink-soft) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        linestrong: "rgb(var(--line-strong) / <alpha-value>)",
        brand: "rgb(var(--brand) / <alpha-value>)",
        brandhover: "rgb(var(--brand-hover) / <alpha-value>)",
        brandsoft: "rgb(var(--brand-soft) / <alpha-value>)",
        brandink: "rgb(var(--brand-ink) / <alpha-value>)",
        brandtext: "rgb(var(--brand-text) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        successsoft: "rgb(var(--success-soft) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        warningsoft: "rgb(var(--warning-soft) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",
        dangersoft: "rgb(var(--danger-soft) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "SF Pro Text",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "JetBrains Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      borderRadius: {
        card: "0.75rem",
      },
      boxShadow: {
        card: "0 1px 2px rgb(24 24 27 / 0.04), 0 1px 3px rgb(24 24 27 / 0.06)",
        pop: "0 12px 32px -12px rgb(24 24 27 / 0.18), 0 2px 8px rgb(24 24 27 / 0.06)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
