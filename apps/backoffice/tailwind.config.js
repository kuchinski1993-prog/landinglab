/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/app/**/*.{ts,tsx}', './src/components/**/*.{ts,tsx}'],
  // Polaris ships its own CSS reset — disable Tailwind Preflight to avoid conflicts.
  // Utility classes (flex, gap-*, text-*, etc.) continue working normally.
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        // Minimal palette for the single-user backoffice. No design system in Phase 1.
        sidebar: '#111827',
        'sidebar-hover': '#1f2937',
      },
    },
  },
  plugins: [],
};
