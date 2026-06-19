/**
 * Tailwind v4 is CSS-first (no tailwind.config.js); the PostCSS plugin is the
 * config surface for the Next.js build. Mirrors the console's Tailwind v4 setup
 * (apps/web uses the Vite plugin; Next uses the PostCSS plugin instead).
 *
 * @type {import("postcss-load-config").Config}
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
