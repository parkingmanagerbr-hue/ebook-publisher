#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
"""
extract_chrome_cookies.py

Lê cookies do Chrome (incluindo HttpOnly) com decriptação AES-GCM via DPAPI.
Salva sessões combinadas com localStorage capturado anteriormente.

Uso: python scripts/extract_chrome_cookies.py
"""
import os, sys, json, shutil, sqlite3, base64, tempfile, subprocess, ctypes, ctypes.wintypes
from pathlib import Path
from datetime import datetime

# ── Copiar arquivo bloqueado pelo Chrome via Windows API ──────────────────────
def copy_locked_file(src, dst):
    """Copia arquivo mesmo que outro processo o tenha aberto."""
    kernel32 = ctypes.windll.kernel32

    GENERIC_READ     = 0x80000000
    FILE_SHARE_READ  = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    FILE_SHARE_DELETE= 0x00000004
    OPEN_EXISTING    = 3
    FILE_ATTRIBUTE_NORMAL = 0x80

    h = kernel32.CreateFileW(
        str(src),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None,
    )
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    if h == INVALID_HANDLE_VALUE or h == 0xFFFFFFFF or h == -1:
        err = kernel32.GetLastError()
        raise OSError(f"CreateFileW falhou (erro {err})")

    try:
        size = os.path.getsize(src)
        buf = (ctypes.c_char * size)()
        read = ctypes.wintypes.DWORD(0)
        ok = kernel32.ReadFile(h, buf, size, ctypes.byref(read), None)
        if not ok:
            raise OSError(f"ReadFile falhou (erro {kernel32.GetLastError()})")
        Path(dst).write_bytes(bytes(buf[:read.value]))
    finally:
        kernel32.CloseHandle(h)

try:
    import win32crypt
    from Crypto.Cipher import AES
except ImportError as e:
    print(f"ERRO: {e}")
    print("Instale: pip install pywin32 pycryptodome")
    sys.exit(1)

# ── Paths ────────────────────────────────────────────────────────────────────
CHROME_DIR   = Path(os.environ["LOCALAPPDATA"]) / "Google/Chrome/User Data"
LOCAL_STATE  = CHROME_DIR / "Local State"
SESS_DIR     = Path(__file__).parent.parent / "data/sessions"
VPS_SESS     = "vps:/opt/platform/data/ebook-publisher/db/sessions/"
SESS_DIR.mkdir(parents=True, exist_ok=True)

def find_all_cookie_dbs():
    """Encontra todos os arquivos Cookies em todos os perfis do Chrome."""
    dbs = []
    for profile in CHROME_DIR.iterdir():
        if not profile.is_dir():
            continue
        # Novo caminho (Chrome 96+): Profile X/Network/Cookies
        new_path = profile / "Network" / "Cookies"
        if new_path.exists():
            dbs.append(new_path)
            continue
        # Caminho antigo: Profile X/Cookies
        old_path = profile / "Cookies"
        if old_path.exists():
            dbs.append(old_path)
    return dbs

# Domínios por plataforma
PLATFORMS = {
    "hotmart": {
        "label": "HOTMART",
        "domains": ["hotmart.com", "app-vlc.hotmart.com", "sso.hotmart.com",
                    "api-sec-vlc.hotmart.com", ".hotmart.com"],
        "testUrl": "https://app-vlc.hotmart.com/products",
    },
    "cakto": {
        "label": "CAKTO",
        "domains": ["cakto.com.br", "app.cakto.com.br", "sso.cakto.com.br",
                    ".cakto.com.br", "api.cakto.com.br"],
        "testUrl": "https://app.cakto.com.br/dashboard",
    },
    "amazon": {
        "label": "AMAZON KDP",
        "domains": ["amazon.com", ".amazon.com", "kdp.amazon.com",
                    "amazon.com.br", ".amazon.com.br", "www.amazon.com",
                    "www.amazon.com.br"],
        "testUrl": "https://kdp.amazon.com/pt_BR/bookshelf",
    },
}

# ── Obter chave AES do Chrome ─────────────────────────────────────────────────
def get_encryption_key():
    with open(LOCAL_STATE, "r", encoding="utf-8") as f:
        local_state = json.load(f)
    encrypted_key_b64 = local_state["os_crypt"]["encrypted_key"]
    encrypted_key = base64.b64decode(encrypted_key_b64)
    # Remove prefixo "DPAPI" (5 bytes)
    encrypted_key = encrypted_key[5:]
    # Decriptar com DPAPI
    key = win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]
    return key

# ── Decriptar valor de cookie ─────────────────────────────────────────────────
def decrypt_cookie(encrypted_value, key):
    try:
        if encrypted_value[:3] == b"v10" or encrypted_value[:3] == b"v11":
            # Chrome 80+ — AES-256-GCM
            iv = encrypted_value[3:15]
            payload = encrypted_value[15:]
            cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
            return cipher.decrypt(payload)[:-16].decode("utf-8")
        else:
            # Versão antiga — DPAPI direto
            return win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1].decode("utf-8")
    except Exception:
        return ""

# ── Ler cookies de UM banco SQLite ───────────────────────────────────────────
def read_cookies_from_db(db_path, key, domain_filters):
    """Lê cookies de um único arquivo de banco de dados."""
    tmp = Path(tempfile.mktemp(suffix=".db"))
    try:
        copy_locked_file(db_path, tmp)
    except Exception as e:
        try:
            shutil.copy2(db_path, tmp)  # fallback
        except Exception as e2:
            print(f"    ⚠️  Não foi possível copiar {db_path.parent.parent.name}: {e2}")
            return []

    cookies = []
    conn = sqlite3.connect(str(tmp))
    try:
        cursor = conn.cursor()
        try:
            cursor.execute("""
                SELECT host_key, name, path, encrypted_value, expires_utc,
                       is_secure, is_httponly, samesite
                FROM cookies
            """)
        except sqlite3.OperationalError:
            try:
                cursor.execute("""
                    SELECT host_key, name, path, encrypted_value, expires_utc,
                           secure, httponly, 0 as samesite
                    FROM cookies
                """)
            except Exception:
                return []

        for row in cursor.fetchall():
            host, name, path, enc_val, expires, secure, httponly, samesite = row
            host_normalized = host.lstrip(".")
            match = any(
                host_normalized == d.lstrip(".") or
                host_normalized.endswith("." + d.lstrip(".")) or
                host == d
                for d in domain_filters
            )
            if not match:
                continue

            value = decrypt_cookie(enc_val, key) if enc_val else ""

            expires_unix = 0
            if expires and expires > 0:
                try:
                    expires_unix = (expires - 11644473600000000) / 1000000
                    if expires_unix < 0:
                        expires_unix = 0
                except Exception:
                    expires_unix = 0

            cookies.append({
                "name":     name,
                "value":    value,
                "domain":   host,
                "path":     path,
                "expires":  expires_unix,
                "size":     len(name) + len(value),
                "httpOnly": bool(httponly),
                "secure":   bool(secure),
                "session":  expires == 0,
                "sameSite": {0: "Strict", 1: "Lax", 2: "None"}.get(samesite, "Lax"),
            })
    except Exception as e:
        print(f"    ⚠️  Erro ao ler {db_path.parent.parent.name}: {e}")
    finally:
        conn.close()
        tmp.unlink(missing_ok=True)

    return cookies

# ── Ler cookies de TODOS os perfis ────────────────────────────────────────────
def read_chrome_cookies(key, domain_filters):
    all_dbs = find_all_cookie_dbs()
    print(f"  🔍 Buscando em {len(all_dbs)} perfis...")

    all_cookies = []
    seen_keys = set()

    for db in all_dbs:
        profile_name = db.parent.parent.name
        cookies = read_cookies_from_db(db, key, domain_filters)
        new_count = 0
        for c in cookies:
            key_id = f"{c['name']}|{c['domain']}|{c['path']}"
            if key_id not in seen_keys:
                seen_keys.add(key_id)
                all_cookies.append(c)
                new_count += 1
        if new_count > 0:
            http_only_n = sum(1 for c in cookies if c["httpOnly"])
            print(f"    [{profile_name}] {new_count} cookies ({http_only_n} HttpOnly)")

    return all_cookies

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("\n" + "═" * 60)
    print("  EXTRAÇÃO DE COOKIES DO CHROME (incluindo HttpOnly)")
    print("═" * 60)

    print("\n🔑 Obtendo chave de encriptação do Chrome...")
    try:
        key = get_encryption_key()
        print(f"  ✅ Chave obtida ({len(key)} bytes)")
    except Exception as e:
        print(f"  ❌ Falha: {e}")
        sys.exit(1)

    results = {}

    for platform_key, config in PLATFORMS.items():
        print(f"\n── {config['label']} {'─' * (45 - len(config['label']))}")

        cookies = read_chrome_cookies(key, config["domains"])
        http_only_count = sum(1 for c in cookies if c["httpOnly"])

        print(f"  🍪 {len(cookies)} cookies ({http_only_count} HttpOnly)")

        if not cookies:
            print(f"  ⚠️  Verifique se está logado no Chrome em {config['label']}")
            results[platform_key] = False
            continue

        # Listar cookies de auth importantes
        auth_keywords = ["session", "auth", "token", "sid", "at-", "tgt",
                         "access", "refresh", "sso", "cas", "csrftoken",
                         "sessionid", "__cf"]
        important = [c for c in cookies
                     if any(k in c["name"].lower() for k in auth_keywords)]
        if important:
            names = [f"{'[H]' if c['httpOnly'] else ''}{c['name']}" for c in important[:10]]
            print(f"  🔑 Auth: {', '.join(names)}")

        # Carregar sessão anterior para preservar localStorage
        session_file = SESS_DIR / f"{platform_key}.json"
        previous_session = {}
        if session_file.exists():
            try:
                previous_session = json.loads(session_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        session = {
            "platform":       platform_key,
            "url":            config["testUrl"],
            "cookies":        cookies,
            "localStorage":   previous_session.get("localStorage",   {}),
            "sessionStorage": previous_session.get("sessionStorage", {}),
            "savedAt":        int(datetime.now().timestamp() * 1000),
            "savedAtHuman":   datetime.now().strftime("%d/%m/%Y, %H:%M:%S"),
            "cookieCount":    len(cookies),
            "capturedVia":    "python-dpapi-aes-gcm",
        }

        session_file.write_text(json.dumps(session, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  ✅ Salvo: {session_file}")
        results[platform_key] = True

    # ── Resumo ───────────────────────────────────────────────────────────────
    print("\n" + "═" * 60)
    print("  RESUMO")
    for k, ok in results.items():
        label = PLATFORMS[k]["label"]
        print(f"  {'✅' if ok else '❌'} {label}")

    any_ok = any(results.values())
    if not any_ok:
        print("\n❌ Nenhuma sessão capturada. Verifique se está logado no Chrome.")
        sys.exit(1)

    # ── Enviar para VPS ──────────────────────────────────────────────────────
    print("\n📤 Enviando sessões para o VPS...")
    files = [str(SESS_DIR / f"{k}.json") for k, ok in results.items() if ok]
    quoted = " ".join('"' + f + '"' for f in files)
    cmd = f'scp {quoted} {VPS_SESS}'
    ret = subprocess.run(cmd, shell=True)
    if ret.returncode == 0:
        print("✅ Sessões enviadas!")
    else:
        print("⚠️  Erro no SCP — verifique conexão SSH")
        sys.exit(1)

    # ── Reiniciar container ──────────────────────────────────────────────────
    print("\n🔄 Reiniciando ebook-publisher no VPS...")
    ret = subprocess.run(
        'ssh vps "cd /opt/platform && docker compose -f docker-compose.production.yml restart ebook-publisher"',
        shell=True
    )
    if ret.returncode == 0:
        print("✅ Container reiniciado!")
        print("\n📋 Para ver os logs:")
        print('   ssh vps "docker logs platform-ebook-publisher-1 --tail 50 -f"')
    else:
        print("⚠️  Erro ao reiniciar")

if __name__ == "__main__":
    main()
