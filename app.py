#!/usr/bin/env python3
"""Local-network seating preference and result server.

Requires Python 3.10 or later. Run with: python3.10 app.py
"""

import sys


MINIMUM_PYTHON_VERSION = (3, 10)
if sys.version_info < MINIMUM_PYTHON_VERSION:
    required = ".".join(map(str, MINIMUM_PYTHON_VERSION))
    current = ".".join(map(str, sys.version_info[:3]))
    sys.exit(f"Python {required} 以降が必要です。現在のバージョン: {current}")


import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import socket
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DB_PATH = ROOT / "seating.db"
HOST = os.environ.get("SEATING_HOST", "0.0.0.0")
PORT = int(os.environ.get("SEATING_PORT", "8000"))
ADMIN_PASSWORD = os.environ.get("SEATING_ADMIN_PASSWORD", "admin")
SESSION_SECRET = os.environ.get("SEATING_SESSION_SECRET", secrets.token_hex(32)).encode()


def database():
    connection = sqlite3.connect(DB_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database():
    with database() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                title TEXT NOT NULL,
                rows_count INTEGER NOT NULL,
                columns_count INTEGER NOT NULL,
                phase TEXT NOT NULL CHECK (phase IN ('voting', 'results')),
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS participants (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS votes (
                participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
                seat_code TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS assignments (
                participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
                seat_code TEXT UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS excluded_seats (
                seat_code TEXT PRIMARY KEY
            );
            """
        )
        db.execute(
            """
            INSERT OR IGNORE INTO settings (id, title, rows_count, columns_count, phase)
            VALUES (1, '席替え投票', 5, 6, 'voting')
            """
        )


def seat_codes(rows_count, columns_count):
    return [f"{row}-{column}" for row in range(1, rows_count + 1) for column in range(1, columns_count + 1)]


def current_settings(db):
    return db.execute("SELECT * FROM settings WHERE id = 1").fetchone()


def valid_seat(db, code):
    settings = current_settings(db)
    if code not in seat_codes(settings["rows_count"], settings["columns_count"]):
        return False
    return not db.execute("SELECT 1 FROM excluded_seats WHERE seat_code = ?", (code,)).fetchone()


def excluded_seat_codes(db):
    return [row["seat_code"] for row in db.execute("SELECT seat_code FROM excluded_seats ORDER BY seat_code")]


def sign(value):
    return hmac.new(SESSION_SECRET, value.encode(), hashlib.sha256).hexdigest()


def admin_cookie_value():
    value = "admin"
    return f"{value}.{sign(value)}"


def local_ipv4_addresses():
    """Return addresses other devices on the local network can use."""
    addresses = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.connect(("8.8.8.8", 80))
            addresses.add(connection.getsockname()[0])
    except OSError:
        pass
    try:
        addresses.update(
            address[4][0]
            for address in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        )
    except socket.gaierror:
        pass
    return sorted(address for address in addresses if not address.startswith("127."))


class SeatingHandler(BaseHTTPRequestHandler):
    server_version = "SeatingApp/1.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    def cookies(self):
        parsed = SimpleCookie()
        parsed.load(self.headers.get("Cookie", ""))
        return {name: morsel.value for name, morsel in parsed.items()}

    def is_admin(self):
        return hmac.compare_digest(self.cookies().get("admin", ""), admin_cookie_value())

    def participant_id(self):
        return self.cookies().get("participant")

    def send_json(self, payload, status=HTTPStatus.OK, cookies=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, message, status=HTTPStatus.BAD_REQUEST):
        self.send_json({"error": message}, status)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("不正なリクエストです。")
        if length > 20_000:
            raise ValueError("リクエストが大きすぎます。")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("JSONの形式が不正です。")

    def require_admin(self):
        if not self.is_admin():
            self.error_json("管理者としてログインしてください。", HTTPStatus.UNAUTHORIZED)
            return False
        return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            return self.get_public_state()
        if path == "/api/admin/session":
            return self.send_json({"authenticated": self.is_admin()})
        if path == "/api/admin/state":
            if self.require_admin():
                return self.get_admin_state()
            return
        if path == "/":
            return self.serve_file(STATIC_DIR / "index.html")
        if path == "/admin":
            return self.serve_file(STATIC_DIR / "admin.html")
        if path.startswith("/static/"):
            relative = path.removeprefix("/static/")
            candidate = (STATIC_DIR / relative).resolve()
            if STATIC_DIR.resolve() in candidate.parents and candidate.is_file():
                return self.serve_file(candidate)
        self.error_json("見つかりません。", HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self.read_json()
            if not isinstance(data, dict):
                raise ValueError("JSONオブジェクトを指定してください。")
            if path == "/api/join":
                return self.join(data)
            if path == "/api/vote":
                return self.vote(data)
            if path == "/api/admin/login":
                return self.admin_login(data)
            if path == "/api/admin/logout":
                return self.admin_logout()
            if path == "/api/admin/settings":
                return self.save_settings(data)
            if path == "/api/admin/publish":
                return self.publish_results()
            if path == "/api/admin/reopen":
                return self.reopen_voting()
            if path == "/api/admin/reset":
                return self.reset_all()
            if path == "/api/admin/participant/delete":
                return self.delete_participant(data)
            self.error_json("見つかりません。", HTTPStatus.NOT_FOUND)
        except ValueError as error:
            self.error_json(str(error))
        except sqlite3.Error:
            self.error_json("データの保存に失敗しました。もう一度試してください。", HTTPStatus.INTERNAL_SERVER_ERROR)

    def serve_file(self, file_path):
        content = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or file_path.suffix in {".js", ".json"}:
            content_type += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def get_public_state(self):
        participant = None
        with database() as db:
            settings = current_settings(db)
            participant_id = self.participant_id()
            if participant_id:
                participant = db.execute(
                    "SELECT p.id, p.name, v.seat_code AS vote FROM participants p "
                    "LEFT JOIN votes v ON v.participant_id = p.id WHERE p.id = ?",
                    (participant_id,),
                ).fetchone()
            count = db.execute("SELECT COUNT(*) AS count FROM participants").fetchone()["count"]
            payload = {
                "title": settings["title"],
                "rows": settings["rows_count"],
                "columns": settings["columns_count"],
                "excludedSeats": excluded_seat_codes(db),
                "phase": settings["phase"],
                "participantCount": count,
                "myParticipant": dict(participant) if participant else None,
            }
            if settings["phase"] == "results":
                payload["results"] = [
                    dict(row)
                    for row in db.execute(
                        "SELECT p.name, a.seat_code AS seat FROM participants p "
                        "LEFT JOIN assignments a ON a.participant_id = p.id "
                        "ORDER BY CASE WHEN a.seat_code IS NULL THEN 1 ELSE 0 END, a.seat_code, p.name"
                    )
                ]
        self.send_json(payload)

    def get_admin_state(self):
        with database() as db:
            settings = current_settings(db)
            participants = [
                dict(row)
                for row in db.execute(
                    "SELECT p.id, p.name, p.created_at, v.seat_code AS vote, a.seat_code AS assignment "
                    "FROM participants p "
                    "LEFT JOIN votes v ON v.participant_id = p.id "
                    "LEFT JOIN assignments a ON a.participant_id = p.id "
                    "ORDER BY p.created_at, p.name"
                )
            ]
            self.send_json(
                {
                    "settings": dict(settings),
                    "excludedSeats": excluded_seat_codes(db),
                    "participants": participants,
                }
            )

    def join(self, data):
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("名前を入力してください。")
        if len(name) > 30:
            raise ValueError("名前は30文字以内にしてください。")
        with database() as db:
            settings = current_settings(db)
            if settings["phase"] != "voting":
                raise ValueError("結果公開後のため、新しい参加は受け付けていません。")
            participant_id = self.participant_id() or secrets.token_urlsafe(24)
            db.execute(
                "INSERT INTO participants (id, name) VALUES (?, ?) "
                "ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP",
                (participant_id, name),
            )
        self.send_json(
            {"ok": True},
            cookies=[f"participant={participant_id}; Path=/; HttpOnly; SameSite=Lax"],
        )

    def vote(self, data):
        participant_id = self.participant_id()
        seat = str(data.get("seat", ""))
        if not participant_id:
            raise ValueError("先に名前を登録してください。")
        with database() as db:
            settings = current_settings(db)
            if settings["phase"] != "voting":
                raise ValueError("投票は締め切られています。")
            exists = db.execute("SELECT 1 FROM participants WHERE id = ?", (participant_id,)).fetchone()
            if not exists:
                raise ValueError("参加者情報が見つかりません。名前を登録し直してください。")
            if not valid_seat(db, seat):
                raise ValueError("その席は選べません。")
            db.execute(
                "INSERT INTO votes (participant_id, seat_code) VALUES (?, ?) "
                "ON CONFLICT(participant_id) DO UPDATE SET seat_code = excluded.seat_code, updated_at = CURRENT_TIMESTAMP",
                (participant_id, seat),
            )
        self.send_json({"ok": True, "seat": seat})

    def admin_login(self, data):
        password = str(data.get("password", ""))
        if not hmac.compare_digest(password, ADMIN_PASSWORD):
            self.error_json("パスワードが違います。", HTTPStatus.UNAUTHORIZED)
            return
        self.send_json(
            {"ok": True},
            cookies=[f"admin={admin_cookie_value()}; Path=/; HttpOnly; SameSite=Lax"],
        )

    def admin_logout(self):
        self.send_json({"ok": True}, cookies=["admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"])

    def save_settings(self, data):
        if not self.require_admin():
            return
        title = str(data.get("title", "")).strip()
        try:
            rows_count = int(data.get("rows"))
            columns_count = int(data.get("columns"))
        except (TypeError, ValueError):
            raise ValueError("行数と列数は数値で指定してください。")
        if not title or len(title) > 60:
            raise ValueError("タイトルは1〜60文字にしてください。")
        if not (1 <= rows_count <= 12 and 1 <= columns_count <= 12):
            raise ValueError("行数・列数は1〜12の範囲にしてください。")
        requested_exclusions = data.get("excludedSeats", [])
        if not isinstance(requested_exclusions, list):
            raise ValueError("除外席の形式が不正です。")
        all_seats = set(seat_codes(rows_count, columns_count))
        excluded = {str(seat) for seat in requested_exclusions}
        if len(excluded) != len(requested_exclusions) or not excluded.issubset(all_seats):
            raise ValueError("除外席の指定が不正です。")
        if len(excluded) == len(all_seats):
            raise ValueError("少なくとも1席は利用可能にしてください。")
        with database() as db:
            previous = current_settings(db)
            layout_changed = previous["rows_count"] != rows_count or previous["columns_count"] != columns_count
            exclusions_changed = set(excluded_seat_codes(db)) != excluded
            db.execute(
                "UPDATE settings SET title = ?, rows_count = ?, columns_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1",
                (title, rows_count, columns_count),
            )
            if layout_changed or exclusions_changed:
                db.execute("DELETE FROM votes")
                db.execute("DELETE FROM assignments")
                db.execute("UPDATE settings SET phase = 'voting' WHERE id = 1")
            db.execute("DELETE FROM excluded_seats")
            db.executemany("INSERT INTO excluded_seats (seat_code) VALUES (?)", ((seat,) for seat in sorted(excluded)))
        self.send_json({"ok": True, "seatsChanged": layout_changed or exclusions_changed})

    def publish_results(self):
        if not self.require_admin():
            return
        with database() as db:
            settings = current_settings(db)
            excluded = set(excluded_seat_codes(db))
            seats = [
                seat
                for seat in seat_codes(settings["rows_count"], settings["columns_count"])
                if seat not in excluded
            ]
            entries = db.execute(
                "SELECT p.id, v.seat_code AS vote FROM participants p "
                "LEFT JOIN votes v ON v.participant_id = p.id ORDER BY p.id"
            ).fetchall()
            randomizer = secrets.SystemRandom()
            by_vote = {}
            without_winning_seat = []
            for entry in entries:
                if entry["vote"] in seats:
                    by_vote.setdefault(entry["vote"], []).append(entry["id"])
                else:
                    without_winning_seat.append(entry["id"])
            assigned = {}
            free_seats = set(seats)
            for seat in seats:
                hopefuls = by_vote.get(seat, [])
                if hopefuls:
                    winner = randomizer.choice(hopefuls)
                    assigned[winner] = seat
                    free_seats.remove(seat)
                    without_winning_seat.extend(person for person in hopefuls if person != winner)
            randomizer.shuffle(without_winning_seat)
            remaining_seats = list(free_seats)
            randomizer.shuffle(remaining_seats)
            for person, seat in zip(without_winning_seat, remaining_seats):
                assigned[person] = seat
            db.execute("DELETE FROM assignments")
            db.executemany(
                "INSERT INTO assignments (participant_id, seat_code) VALUES (?, ?)", assigned.items()
            )
            db.execute("UPDATE settings SET phase = 'results', updated_at = CURRENT_TIMESTAMP WHERE id = 1")
        self.send_json({"ok": True, "assigned": len(assigned)})

    def reopen_voting(self):
        if not self.require_admin():
            return
        with database() as db:
            db.execute("DELETE FROM assignments")
            db.execute("UPDATE settings SET phase = 'voting', updated_at = CURRENT_TIMESTAMP WHERE id = 1")
        self.send_json({"ok": True})

    def reset_all(self):
        if not self.require_admin():
            return
        with database() as db:
            db.execute("DELETE FROM participants")
            db.execute("DELETE FROM votes")
            db.execute("DELETE FROM assignments")
            db.execute("UPDATE settings SET phase = 'voting', updated_at = CURRENT_TIMESTAMP WHERE id = 1")
        self.send_json({"ok": True})

    def delete_participant(self, data):
        if not self.require_admin():
            return
        participant_id = str(data.get("id", ""))
        with database() as db:
            db.execute("DELETE FROM participants WHERE id = ?", (participant_id,))
        self.send_json({"ok": True})


def main():
    initialize_database()
    server = ThreadingHTTPServer((HOST, PORT), SeatingHandler)
    print(f"\n席替えアプリを起動しました: http://localhost:{PORT}")
    print(f"管理画面: http://localhost:{PORT}/admin")
    if HOST in {"0.0.0.0", "::"}:
        addresses = local_ipv4_addresses()
        if addresses:
            print("参加者には、次のアドレスを案内してください。")
            for address in addresses:
                print(f"  http://{address}:{PORT}")
        else:
            print("参加者用のIPv4アドレスを取得できませんでした。Wi-Fi接続を確認してください。")
    if ADMIN_PASSWORD == "admin":
        print("管理者パスワード: admin  （本番利用前に環境変数 SEATING_ADMIN_PASSWORD で変更してください）")
    print("停止するには Ctrl+C を押します。\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
