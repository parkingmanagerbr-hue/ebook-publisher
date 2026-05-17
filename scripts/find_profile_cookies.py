#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Usa robocopy /B para copiar arquivos de cookies bloqueados pelo Chrome.
Identifica qual perfil tem cookies de Hotmart/Cakto/Amazon.
"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import os, json, sqlite3, base64, tempfile, subprocess
from pathlib import Path

try:
    import win32crypt
    from Crypto.Cipher import AES
except ImportError:
    print("pip install pywin32 pycryptodome")
    sys.exit(1)

CHROME_DIR = Path(os.environ["LOCALAPPDATA"]) / "Google/Chrome/User Data"
LOCAL_STATE = CHROME_DIR / "Local State"

TARGETS = {
    "hotmart": ["hotmart.com", "app-vlc.hotmart.com", "sso.hotmart.com"],
    "cakto":   ["cakto.com.br", "app.cakto.com.br"],
    "amazon":  ["amazon.com", "kdp.amazon.com"],
}

def get_key():
    data = json.loads(LOCAL_STATE.read_text(encoding="utf-8"))
    enc_key = base64.b64decode(data["os_crypt"]["encrypted_key"])[5:]
    return win32crypt.CryptUnprotectData(enc_key, None, None, None, 0)[1]

def decrypt(val, key):
    try:
        if val[:3] in (b"v10", b"v11"):
            iv, payload = val[3:15], val[15:]
            return AES.new(key, AES.MODE_GCM, nonce=iv).decrypt(payload)[:-16].decode()
        return win32crypt.CryptUnprotectData(val, None, None, None, 0)[1].decode()
    except:
        return ""

def copy_with_robocopy(src, dst_dir):
    """Usa robocopy /B (backup mode) para copiar arquivo bloqueado."""
    result = subprocess.run(
        ["robocopy", str(src.parent), str(dst_dir), src.name, "/B", "/NJH", "/NJS", "/NFL", "/NDL", "/NP"],
        capture_output=True, text=True, timeout=10
    )
    # robocopy retorna 0-7 para sucesso
    return result.returncode < 8 and (dst_dir / src.name).exists()

def read_db(db_path, key, domain_filters):
    tmp_dir = Path(tempfile.mkdtemp())
    tmp_db = tmp_dir / "Cookies"

    # Tentar robocopy /B primeiro
    copied = False
    try:
        copied = copy_with_robocopy(db_path, tmp_dir)
    except Exception as e:
        pass

    # Fallback: cópia direta
    if not copied:
        try:
            import shutil
            shutil.copy2(db_path, tmp_db)
            copied = True
        except:
            pass

    if not copied:
        return []

    try:
        conn = sqlite3.connect(str(tmp_db))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        try:
            cur.execute("SELECT host_key,name,path,encrypted_value,expires_utc,is_secure,is_httponly,samesite FROM cookies")
        except:
            cur.execute("SELECT host_key,name,path,encrypted_value,expires_utc,secure,httponly,0 as samesite FROM cookies")

        cookies = []
        for row in cur.fetchall():
            host = row["host_key"]
            hn = host.lstrip(".")
            if not any(hn == d.lstrip(".") or hn.endswith("." + d.lstrip(".")) or host == d for d in domain_filters):
                continue
            val = decrypt(row["encrypted_value"], key) if row["encrypted_value"] else ""
            exp = row["expires_utc"]
            exp_unix = max(0, (exp - 11644473600000000) / 1000000) if exp and exp > 0 else 0
            cookies.append({
                "name": row["name"], "value": val,
                "domain": host, "path": row["path"],
                "expires": exp_unix,
                "size": len(row["name"]) + len(val),
                "httpOnly": bool(row["is_httponly"]),
                "secure": bool(row["is_secure"]),
                "session": exp == 0,
                "sameSite": {0:"Strict",1:"Lax",2:"None"}.get(row["samesite"],"Lax"),
            })
        conn.close()
        return cookies
    except Exception as e:
        return []
    finally:
        try:
            import shutil; shutil.rmtree(tmp_dir, ignore_errors=True)
        except: pass

def main():
    print("Obtendo chave de encriptação...")
    key = get_key()
    print(f"  Chave: {len(key)} bytes\n")

    all_dbs = []
    for profile in CHROME_DIR.iterdir():
        if not profile.is_dir() or profile.name.startswith("."):
            continue
        for sub in [profile/"Network"/"Cookies", profile/"Cookies"]:
            if sub.exists():
                all_dbs.append(sub)
                break

    print(f"Perfis encontrados: {len(all_dbs)}\n")

    SESS_DIR = Path(__file__).parent.parent / "data/sessions"
    SESS_DIR.mkdir(parents=True, exist_ok=True)

    results = {}
    for platform, domains in TARGETS.items():
        print(f"=== {platform.upper()} ===")
        all_cookies = []
        seen = set()
        for db in all_dbs:
            profile_name = db.parent.parent.name
            cookies = read_db(db, key, domains)
            new = 0
            for c in cookies:
                k = f"{c['name']}|{c['domain']}"
                if k not in seen:
                    seen.add(k)
                    all_cookies.append(c)
                    new += 1
            if new:
                ho = sum(1 for c in cookies if c["httpOnly"])
                print(f"  [{profile_name}] {new} cookies ({ho} HttpOnly)")

        print(f"  TOTAL: {len(all_cookies)} cookies ({sum(1 for c in all_cookies if c['httpOnly'])} HttpOnly)")

        if all_cookies:
            # Preservar localStorage anterior
            sess_file = SESS_DIR / f"{platform}.json"
            prev = {}
            if sess_file.exists():
                try: prev = json.loads(sess_file.read_text(encoding="utf-8"))
                except: pass

            session = {
                "platform": platform,
                "url": {"hotmart":"https://app-vlc.hotmart.com/products",
                        "cakto":"https://app.cakto.com.br/dashboard",
                        "amazon":"https://kdp.amazon.com/pt_BR/bookshelf"}[platform],
                "cookies": all_cookies,
                "localStorage": prev.get("localStorage", {}),
                "sessionStorage": prev.get("sessionStorage", {}),
                "savedAt": int(__import__("time").time() * 1000),
                "savedAtHuman": __import__("datetime").datetime.now().strftime("%d/%m/%Y, %H:%M:%S"),
                "cookieCount": len(all_cookies),
                "capturedVia": "robocopy-dpapi",
            }
            sess_file.write_text(json.dumps(session, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"  Salvo: {sess_file}")
            results[platform] = True
        else:
            print(f"  NENHUM cookie encontrado!")
            results[platform] = False
        print()

    any_ok = any(results.values())
    if any_ok:
        platforms_ok = [p for p, ok in results.items() if ok]
        files = " ".join(f'"{SESS_DIR/p}.json"' for p in platforms_ok)
        print("Enviando para VPS...")
        ret = subprocess.run(
            f'scp {files} vps:/opt/platform/data/ebook-publisher/db/sessions/',
            shell=True
        )
        if ret.returncode == 0:
            print("Sessoes enviadas!")
            print("Reiniciando container...")
            subprocess.run(
                'ssh vps "cd /opt/platform && docker compose -f docker-compose.production.yml restart ebook-publisher"',
                shell=True
            )
            print("Pronto!")

if __name__ == "__main__":
    main()
