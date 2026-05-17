import sys
print("Python:", sys.version)
try:
    import win32crypt
    print("win32crypt: OK")
except ImportError as e:
    print("win32crypt: MISSING -", e)
try:
    import sqlite3
    print("sqlite3: OK")
except ImportError as e:
    print("sqlite3: MISSING -", e)
try:
    from Crypto.Cipher import AES
    print("pycryptodome: OK")
except ImportError:
    try:
        from Cryptodome.Cipher import AES
        print("pycryptodome(dome): OK")
    except ImportError as e:
        print("pycryptodome: MISSING -", e)
