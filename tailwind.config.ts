import type { Config } from "tailwindcss";

// Helper: a token backed by a CSS variable holding an "R G B" triplet, so
// Tailwind opacity modifiers still work (bg-warn/50, text-ink/70, etc.).
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Text-forward reading surface. System serif for prose, system sans for chrome.
        serif: ["Georgia", "Cambria", "Times New Roman", "serif"],
        sans: ["ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
      },
      colors: {
        // Surfaces and text
        paper: token("paper"),
        surface: token("surface"),
        inset: token("inset"),
        chip: token("chip"),
        ink: token("ink"),
        muted: token("muted"),
        faint: token("faint"),

        // Lines
        edge: {
          DEFAULT: token("edge"),
          soft: token("edge-soft"),
        },

        // Accent (primary action)
        accent: {
          DEFAULT: token("accent"),
          ink: token("accent-ink"),
          hover: token("accent-hover"),
        },

        focus: token("focus"),

        // Alert families
        warn: {
          DEFAULT: token("warn"),
          ink: token("warn-ink"),
          edge: token("warn-edge"),
          chip: token("warn-chip"),
        },
        info: {
          DEFAULT: token("info"),
          ink: token("info-ink"),
          edge: token("info-edge"),
          chip: token("info-chip"),
        },
        danger: {
          DEFAULT: token("danger"),
          ink: token("danger-ink"),
          edge: token("danger-edge"),
          chip: token("danger-chip"),
          strong: token("danger-strong"),
        },
        ok: {
          DEFAULT: token("ok"),
          ink: token("ok-ink"),
          edge: token("ok-edge"),
          chip: token("ok-chip"),
          strong: token("ok-strong"),
        },
      },
      borderColor: {
        // Bare `border` (no color class) falls back to the soft edge token.
        DEFAULT: "rgb(var(--edge-soft))",
      },
    },
  },
  plugins: [],
};

export default config;
