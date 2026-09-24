/**
 * Tailwind build for the STEMKit pages.
 *
 * `src/output.css` used to be a committed artifact with no way to regenerate
 * it, so any class introduced after it was generated simply did nothing —
 * a button would render with its background but no text colour, for instance.
 * This config makes the stylesheet reproducible from the markup.
 *
 * The content globs include the JS because several tools build markup in
 * template strings; a class that only ever appears there still has to survive
 * the purge.
 *
 * `fontFamily.sans` puts the vendored Inter (see src/tailwind/input.css) at
 * the front of the default stack. Without this the pages requested the font
 * and then never used it: Tailwind's preflight sets the system stack on
 * <html>, and nothing in the markup overrode it.
 */
const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  content: [
    './*.html',
    './js/**/*.js',
    './src/**/*.js'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // Prussian blue, the site's one accent. Change it here and in the
      // --stk-accent tokens in src/tailwind/input.css.
      colors: {
        brand: {
          50: '#f1f6fb', 100: '#e0ebf6', 200: '#c0d6ec', 300: '#92b8dd',
          400: '#5c93c7', 500: '#3574b0', 600: '#1f5c96', 700: '#1a4b7b',
          800: '#193f66', 900: '#173553', 950: '#0f2236'
        }
      },
      fontFamily: {
        sans: ['Inter', ...defaultTheme.fontFamily.sans]
      }
    }
  },
  plugins: []
};
