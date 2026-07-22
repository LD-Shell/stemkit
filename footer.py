import os
import glob
import re

def update_footers():
    # 1. Define the exact new footer block as a raw string
    # Using triple quotes allows us to safely include all the HTML and quotes
    new_footer = """<footer class="mt-auto border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 py-12">
        <div class="max-w-7xl mx-auto px-6">
            <div class="stk-dir mb-12">
                <div>
                    <h4><i class="fa-solid fa-chart-pie text-indigo-500 text-xs"></i> Data &amp; Stats</h4>
                    <ul>
                        <li><a href="plot-digitizer.html">Plot Digitizer</a></li>
                        <li><a href="data-cleaner.html">Data Cleaner</a></li>
                        <li><a href="stats-calculator.html">Stat Calculator</a></li>
                        <li><a href="error-bar-generator.html">Error Bar Gen</a></li>
                        <li><a href="outlier-detector.html">Outlier Detector</a></li>
                        <li><a href="curve-fitter.html">Curve Fitter</a></li>
                        <li><a href="plot-builder.html">Plot Builder</a></li>
                        <li><a href="xvg-visualizer.html">XVG Visualizer</a></li>
                    </ul>
                </div>
                <div>
                    <h4><i class="fa-solid fa-microchip text-orange-500 text-xs"></i> Compute</h4>
                    <ul>
                        <li><a href="structure-inspector.html">3D Inspector</a></li>
                        <li><a href="coordinate-manipulator.html">Coordinate Manipulator</a></li>
                        <li><a href="scientific-converter.html">Energy Conversions</a></li>
                        <li><a href="script-generator.html">HPC Script Gen</a></li>
                    </ul>
                </div>
                <div>
                    <h4><i class="fa-solid fa-book-open text-teal-500 text-xs"></i> Publish</h4>
                    <ul>
                        <li><a href="latex-formatter.html">Equation Formatter</a></li>
                        <li><a href="latex-tables.html">Visual LaTeX Tables</a></li>
                        <li><a href="doi-fetcher.html">DOI to BibTeX</a></li>
                        <li><a href="bibtex-deduplicator.html">BibTeX Deduplicator</a></li>
                        <li><a href="bibtex-sanitizer.html">BibTeX Sanitizer</a></li>
                        <li><a href="journal-abbreviator.html">Journal Abbrev</a></li>
                    </ul>
                </div>
                <div>
                    <h4><i class="fa-solid fa-headphones text-fuchsia-500 text-xs"></i> Focus &amp; Flow</h4>
                    <ul>
                        <li><a href="pomodoro.html">Ambient Pomodoro</a></li>
                        <li><a href="decision.html">Decision Matrix</a></li>
                        <li><a href="sandbox.html">Kinetic Sandbox</a></li>
                    </ul>
                </div>
            </div>
            <div class="border-t border-slate-200 dark:border-slate-800 pt-8 flex flex-col md:flex-row items-center justify-between text-slate-500 dark:text-slate-400 gap-4">
                <div class="flex items-center gap-2">
                    <i class="fa-solid fa-flask text-xl text-slate-300 dark:text-slate-700"></i>
                    <span class="font-bold text-slate-700 dark:text-slate-300">STEMKit</span>
                </div>
                <div class="text-center text-sm font-medium">&copy; 2026 STEMKit. Engineered for Science.</div>
                <div class="flex gap-6 text-sm font-medium">
                    <a href="privacy.html#privacy" class="hover:text-indigo-500 transition-colors">Privacy Policy</a>
                    <a href="privacy.html#terms" class="hover:text-indigo-500 transition-colors">Terms of Service</a>
                </div>
            </div>
        </div>
    </footer>"""

    # 2. Compile a regular expression pattern to find the existing footer
    # re.DOTALL ensures that the '.' character matches newlines, allowing it to span multiple lines.
    # The pattern looks for '<footer' followed by anything up to '</footer>'.
    footer_pattern = re.compile(r'<footer.*?</footer>', re.DOTALL)

    # 3. Grab every .html file in the current directory
    html_files = glob.glob('*.html')
    
    if not html_files:
        print("No HTML files found in this directory.")
        return

    for file_path in html_files:
        with open(file_path, 'r', encoding='utf-8') as file:
            full_content = file.read()
            
        # 4. Check if the file actually contains a footer
        if '<footer' not in full_content:
            print(f"⚠️  Skipping: {file_path} (No footer tag found)")
            continue
            
        # 5. Perform the replacement
        # re.sub replaces the matched pattern with the new_footer string
        updated_content = re.sub(footer_pattern, new_footer, full_content)
        
        # 6. Safety Check: Only write if the content actually changed
        if updated_content != full_content:
            with open(file_path, 'w', encoding='utf-8') as file:
                file.write(updated_content)
            print(f"✅ Updated: {file_path}")
        else:
            print(f"⏭️  Skipping: {file_path} (Footer is already up to date)")

if __name__ == "__main__":
    update_footers()
