"""
extract-chrome-cookies.py
Extrai cookies do Chrome para hotmart.com e cakto.com.br
e salva no formato de sessão do ebook-publisher.
"""
import os, sys, json, base64, shutil, sqlite3, ctypes, ctypes.wintypes, struct, time, re
from pathlib import Path

CHROME_USER_DATA = Path(os.environ['LOCALAPPDATA']) / 'Google' / 'Chrome' / 'User Data'
PROFILE = 'Profile 1'
OUTPUT_DIR = Path(__file__).parent.parent / 'data' / 'sessions'

TARGETS = {
    'hotmart': ['hotmart.com', 'app.hotmart.com', 'sso.hotmart.com'],
    'cakto':   ['cakto.com.br', 'app.cakto.com.br'],
}

def dpapi_decrypt(data: bytes) -> bytes:
    """Decrypt data using Windows DPAPI."""
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [('cbData', ctypes.wintypes.DWORD),
                    ('pbData', ctypes.POINTER(ctypes.c_char))]

    p = ctypes.create_string_buffer(data, len(data))
    blobin = DATA_BLOB(ctypes.sizeof(p), p)
    blobout = DATA_BLOB()
    retval = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blobin), None, None, None, None, 0, ctypes.byref(blobout))
    if not retval:
        raise RuntimeError('DPAPI decrypt failed')
    result = ctypes.string_at(blobout.pbData, blobout.cbData)
    ctypes.windll.kernel32.LocalFree(blobout.pbData)
    return result

def get_chrome_key(profile: str) -> bytes:
    """Get the AES key from Chrome Local State."""
    local_state_path = CHROME_USER_DATA / 'Local State'
    with open(local_state_path, 'r', encoding='utf-8') as f:
        local_state = json.load(f)

    encrypted_key = base64.b64decode(local_state['os_crypt']['encrypted_key'])
    # Remove DPAPI prefix (first 5 bytes = "DPAPI")
    encrypted_key = encrypted_key[5:]
    return dpapi_decrypt(encrypted_key)

def decrypt_cookie_value(key: bytes, encrypted_value: bytes) -> str:
    """Decrypt a Chrome cookie value."""
    try:
        from Crypto.Cipher import AES
    except ImportError:
        # Try pycryptodome
        try:
            from Cryptodome.Cipher import AES
        except ImportError:
            # Manual AES-GCM via cryptography lib
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            if encrypted_value[:3] == b'v10' or encrypted_value[:3] == b'v11':
                nonce = encrypted_value[3:15]
                ciphertext = encrypted_value[15:]
                aesgcm = AESGCM(key)
                decrypted = aesgcm.decrypt(nonce, ciphertext, None)
                return decrypted.decode('utf-8', errors='replace')
            return ''

    if encrypted_value[:3] == b'v10' or encrypted_value[:3] == b'v11':
        nonce = encrypted_value[3:15]
        ciphertext = encrypted_value[15:-16]
        tag = encrypted_value[-16:]
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        decrypted = cipher.decrypt_and_verify(ciphertext, tag)
        return decrypted.decode('utf-8', errors='replace')
    elif len(encrypted_value) > 0:
        # Old DPAPI-encrypted value
        try:
            return dpapi_decrypt(encrypted_value).decode('utf-8', errors='replace')
        except:
            return ''
    return ''

def copy_locked_file(src: Path, dst: Path):
    """Copy a file locked by another process using robocopy /B (backup mode)."""
    import subprocess
    result = subprocess.run(
        ['robocopy', str(src.parent), str(dst.parent), src.name,
         '/B', '/NJH', '/NJS', '/NFL', '/NDL'],
        capture_output=True, text=True
    )
    # robocopy exits with 0-7 for success, >=8 for failure
    if result.returncode >= 8:
        raise OSError(f'robocopy failed ({result.returncode}): {result.stderr}')
    # Rename if dst name differs from src name
    copied = dst.parent / src.name
    if copied != dst:
        copied.rename(dst)

def extract_cookies(profile: str, domains: list, key: bytes) -> list:
    """Extract cookies from Chrome profile for given domains."""
    cookies_path = CHROME_USER_DATA / profile / 'Network' / 'Cookies'
    tmp_path = Path(os.environ['TEMP']) / 'chrome_cookies_tmp.db'

    # Try copying first; fall back to immutable SQLite URI if locked
    try:
        shutil.copy2(cookies_path, tmp_path)
        conn = sqlite3.connect(str(tmp_path))
    except PermissionError:
        # Chrome is running — connect directly with immutable=1 (no locks)
        uri = f"file:{str(cookies_path).replace(chr(92), '/')}?immutable=1&mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        tmp_path = None
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    placeholders = ','.join(['?' for _ in domains])
    # Also handle subdomains with LIKE
    domain_conditions = ' OR '.join([f"host_key LIKE ?" for _ in domains])
    domain_values = [f'%{d}%' for d in domains]

    cursor.execute(f"""
        SELECT name, value, host_key, path, expires_utc, is_secure, is_httponly,
               has_expires, is_persistent, samesite, encrypted_value
        FROM cookies
        WHERE {domain_conditions}
        ORDER BY host_key, name
    """, domain_values)

    result = []
    for row in cursor.fetchall():
        value = row['value']
        if not value and row['encrypted_value']:
            try:
                value = decrypt_cookie_value(key, row['encrypted_value'])
            except Exception as e:
                value = f'[decrypt_error: {e}]'

        # Convert Chrome epoch (microseconds since 1601) to Unix timestamp
        expires = row['expires_utc']
        if expires and expires > 0:
            # Chrome epoch starts at 1601-01-01, Unix at 1970-01-01
            # Difference: 11644473600 seconds
            expires_unix = (expires / 1e6) - 11644473600
        else:
            expires_unix = -1

        cookie = {
            'name': row['name'],
            'value': value,
            'domain': row['host_key'],
            'path': row['path'],
            'expires': expires_unix,
            'size': len(row['name']) + len(value),
            'httpOnly': bool(row['is_httponly']),
            'secure': bool(row['is_secure']),
            'session': not bool(row['has_expires']),
            'sameSite': ['Strict', 'Lax', 'None'][min(row['samesite'] or 0, 2)],
        }
        result.append(cookie)

    conn.close()
    if tmp_path and tmp_path.exists():
        try:
            os.remove(tmp_path)
        except:
            pass
    return result

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f'Lendo chave do Chrome (Profile: {PROFILE})...')
    try:
        key = get_chrome_key(PROFILE)
        print(f'  Chave AES: {len(key)} bytes')
    except Exception as e:
        print(f'ERRO ao obter chave: {e}')
        sys.exit(1)

    for platform, domains in TARGETS.items():
        print(f'\nExtraindo cookies para {platform} ({domains})...')
        try:
            cookies = extract_cookies(PROFILE, domains, key)
            print(f'  Encontrados: {len(cookies)} cookies')
            for c in cookies[:5]:
                print(f'    {c["domain"]} | {c["name"]} = {c["value"][:40]}...' if len(c["value"]) > 40 else f'    {c["domain"]} | {c["name"]} = {c["value"]}')

            out = {
                'platform': platform,
                'savedAt': int(time.time() * 1000),
                'url': f'https://app.hotmart.com' if platform == 'hotmart' else 'https://app.cakto.com.br',
                'cookies': cookies,
                'localStorage': {},
                'sessionStorage': {},
            }
            out_path = OUTPUT_DIR / f'{platform}.json'
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(out, f, indent=2)
            print(f'  Salvo em: {out_path}')
        except Exception as e:
            print(f'  ERRO: {e}')
            import traceback
            traceback.print_exc()

    print('\nPronto! Agora copie os arquivos para o VPS.')

if __name__ == '__main__':
    main()
