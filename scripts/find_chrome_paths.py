import os, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from pathlib import Path

local = os.environ.get("LOCALAPPDATA", "")
print("LOCALAPPDATA:", repr(local))

chrome_bases = [
    Path(local) / "Google/Chrome/User Data",
    Path(local) / "Google/Chrome for Testing/User Data",
    Path(os.environ.get("APPDATA","")) / "Google/Chrome/User Data",
]

for base in chrome_bases:
    print(f"\nChecking: {base}")
    if base.exists():
        print("  EXISTS")
        # Find all Cookies files
        for cookies in base.rglob("Cookies"):
            print(f"  COOKIES: {cookies} ({cookies.stat().st_size} bytes)")
        for cookies in base.rglob("Network/Cookies"):
            print(f"  NETWORK/COOKIES: {cookies}")
        # List profiles
        for child in base.iterdir():
            if child.is_dir():
                print(f"  DIR: {child.name}")
    else:
        print("  NOT FOUND")
