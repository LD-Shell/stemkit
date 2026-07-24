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
 */
module.exports = {
  content: [
    './*.html',
    './js/**/*.js',
    './src/**/*.js'
  ],
  darkMode: 'class',
  theme: { extend: {} },
  plugins: []
};
