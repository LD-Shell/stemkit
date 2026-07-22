import os
import glob

def update_html_files():
    # The exact strings we are looking for
    target_tag = '<link rel="stylesheet" href="src/home.css">'
    anchor_tag = '<link rel="stylesheet" href="src/output.css">'
    
    # 1. Grab every .html file in the current directory
    html_files = glob.glob('*.html')
    
    if not html_files:
        print("No HTML files found in this directory.")
        return

    for file_path in html_files:
        with open(file_path, 'r', encoding='utf-8') as file:
            lines = file.readlines()
            
        # 2. Safety Check: Convert list to a single string to see if home.css is already there
        full_content = "".join(lines)
        if target_tag in full_content:
            print(f"⏭️  Skipping: {file_path} (Already has home.css)")
            continue
            
        new_lines = []
        modified = False
        
        # 3. Iterate through line by line to find output.css
        for line in lines:
            if anchor_tag in line:
                # 4. Extract the exact whitespace before output.css so home.css matches perfectly
                indentation = line[:line.find('<')]
                
                # Insert the new tag with matching indentation, then the original line
                new_lines.append(f"{indentation}{target_tag}\n")
                new_lines.append(line)
                modified = True
            else:
                # Otherwise, just keep the line exactly as it was
                new_lines.append(line)
                
        # 5. Write the modified lines back to the file
        if modified:
            with open(file_path, 'w', encoding='utf-8') as file:
                file.writelines(new_lines)
            print(f"✅ Updated: {file_path}")
        else:
            print(f"⚠️  Skipping: {file_path} (Could not find output.css anchor)")

if __name__ == "__main__":
    update_html_files()
