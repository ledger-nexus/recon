import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
        },
        accent: { 500: "#0891b2", 600: "#0e7490" },
        positive: "#15803d",
        negative: "#b91c1c",
        // Amber for warning / "needs attention" states — dashboard
        // unmatched-line counter, partial-match badges, etc.
        warning: "#b45309",
        // AI-suggestion-specific tint so users see at a glance which
        // matches were AI-proposed (vs deterministic vs manual).
        ai: "#7c3aed",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Helvetica", "Arial"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
