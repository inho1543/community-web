import os
import sqlite3
import secrets
from functools import wraps
from flask import session
from werkzeug.security import generate_password_hash, check_password_hash
from pathlib import Path
from flask import Flask, jsonify, request, g

app = Flask(__name__)
SECRET_PATH = Path(os.environ.get("SESSION_SECRET_PATH", "/data/session-secret"))
SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
if not SECRET_PATH.exists():
    try:
        fd = os.open(SECRET_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    except FileExistsError:
        pass
app.secret_key = SECRET_PATH.read_text().strip()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE") == "1")

DB_PATH = Path(os.environ.get("DB_PATH", "/data/community.db"))
MAX_TITLE = 120
MAX_NAME = 30
MAX_BODY = 5000
MAX_COMMENT = 1000


def get_db():
    if "db" not in g:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 10000")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_error):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with app.app_context():
        db = get_db()
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nickname TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                nickname TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS likes (
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                visitor_id TEXT NOT NULL,
                PRIMARY KEY(post_id, visitor_id)
            );
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS account_likes (
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY(post_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
        """)
        db.commit()


def error(message, status=400):
    return jsonify({"error": message}), status


def cleaned(data, key, maximum):
    value = data.get(key, "")
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > maximum:
        return None
    return value


def parse_json():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def post_exists(post_id):
    return get_db().execute("SELECT 1 FROM posts WHERE id = ?", (post_id,)).fetchone() is not None


def require_login(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return error("로그인이 필요합니다.", 401)
        return fn(*args, **kwargs)
    return wrapped


@app.before_request
def check_csrf():
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        # Cookie sessions require an anti-CSRF token, not only SameSite.
        if not session.get("csrf") or not secrets.compare_digest(
            request.headers.get("X-CSRF-Token", ""), session.get("csrf", "")
        ):
            # Registration/login bootstrap: a CSRF token is initialized by GET /api/auth/me.
            return error("보안 확인이 필요합니다. 페이지를 새로고침해 주세요.", 403)


@app.get("/api/auth/me")
def whoami():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    user = None
    if session.get("user_id"):
        row = get_db().execute("SELECT id, username FROM users WHERE id=?", (session["user_id"],)).fetchone()
        if row:
            user = dict(row)
        else:
            session.pop("user_id", None)
    return jsonify({"user": user, "csrf": session["csrf"]})


@app.post("/api/auth/register")
def register():
    data = parse_json()
    username = cleaned(data, "username", 30)
    password = data.get("password")
    if not username or len(username) < 3 or not all(c.isalnum() or c in "_-" for c in username):
        return error("아이디는 3~30자의 영문·숫자·밑줄·하이픈으로 입력해 주세요.")
    if not username.isascii():
        return error("아이디는 영문과 숫자로 작성해 주세요.")
    if not isinstance(password, str) or not 10 <= len(password) <= 128:
        return error("비밀번호는 10~128자로 입력해 주세요.")
    db = get_db()
    try:
        cur = db.execute("INSERT INTO users (username,password_hash) VALUES (?,?)", (username, generate_password_hash(password)))
        db.commit()
    except sqlite3.IntegrityError:
        return error("이미 사용 중인 아이디입니다.", 409)
    session.clear()
    session["user_id"] = cur.lastrowid
    session["csrf"] = secrets.token_urlsafe(32)
    return jsonify({"user": {"id": cur.lastrowid, "username": username}, "csrf": session["csrf"]}), 201


@app.post("/api/auth/login")
def login():
    data = parse_json()
    username = data.get("username", "")
    password = data.get("password", "")
    row = get_db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone() if isinstance(username, str) else None
    if row is None or not isinstance(password, str) or not check_password_hash(row["password_hash"], password):
        return error("아이디 또는 비밀번호가 올바르지 않습니다.", 401)
    session.clear()
    session["user_id"] = row["id"]
    session["csrf"] = secrets.token_urlsafe(32)
    return jsonify({"user": {"id": row["id"], "username": row["username"]}, "csrf": session["csrf"]})


@app.post("/api/auth/logout")
def logout():
    session.clear()
    session["csrf"] = secrets.token_urlsafe(32)
    return jsonify({"user": None, "csrf": session["csrf"]})


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/api/posts")
def list_posts():
    db = get_db()
    rows = db.execute("""
        SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count,
               (SELECT COUNT(*) FROM account_likes l WHERE l.post_id=p.id) AS like_count
        FROM posts p ORDER BY p.id DESC LIMIT 100
    """).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/posts")
@require_login
def create_post():
    data = parse_json()
    nickname = get_db().execute("SELECT username FROM users WHERE id=?", (session["user_id"],)).fetchone()["username"]
    title = cleaned(data, "title", MAX_TITLE)
    content = cleaned(data, "content", MAX_BODY)
    if not all((nickname, title, content)):
        return error("닉네임(30자), 제목(120자), 내용(5000자)을 확인해 주세요.")
    db = get_db()
    cur = db.execute("INSERT INTO posts (nickname, title, content) VALUES (?, ?, ?)", (nickname, title, content))
    db.commit()
    return jsonify({"id": cur.lastrowid, "message": "게시글이 등록되었습니다."}), 201


@app.get("/api/posts/<int:post_id>")
def detail(post_id):
    db = get_db()
    post = db.execute("""
        SELECT p.*, (SELECT COUNT(*) FROM account_likes l WHERE l.post_id=p.id) AS like_count
        FROM posts p WHERE p.id=?
    """, (post_id,)).fetchone()
    if post is None:
        return error("게시글을 찾을 수 없습니다.", 404)
    comments = db.execute("SELECT * FROM comments WHERE post_id=? ORDER BY id ASC", (post_id,)).fetchall()
    return jsonify({"post": dict(post), "comments": [dict(row) for row in comments]})


@app.post("/api/posts/<int:post_id>/comments")
@require_login
def create_comment(post_id):
    if not post_exists(post_id):
        return error("게시글을 찾을 수 없습니다.", 404)
    data = parse_json()
    nickname = get_db().execute("SELECT username FROM users WHERE id=?", (session["user_id"],)).fetchone()["username"]
    content = cleaned(data, "content", MAX_COMMENT)
    if not nickname or not content:
        return error("닉네임(30자)과 댓글(1000자)을 확인해 주세요.")
    db = get_db()
    cur = db.execute("INSERT INTO comments (post_id, nickname, content) VALUES (?, ?, ?)", (post_id, nickname, content))
    db.commit()
    return jsonify({"id": cur.lastrowid, "message": "댓글이 등록되었습니다."}), 201


@app.put("/api/posts/<int:post_id>/like")
@require_login
def toggle_like(post_id):
    if not post_exists(post_id):
        return error("게시글을 찾을 수 없습니다.", 404)
    uid = session["user_id"]
    db = get_db()
    found = db.execute("SELECT 1 FROM account_likes WHERE post_id=? AND user_id=?", (post_id, uid)).fetchone()
    if found:
        db.execute("DELETE FROM account_likes WHERE post_id=? AND user_id=?", (post_id, uid))
        liked = False
    else:
        db.execute("INSERT INTO account_likes (post_id, user_id) VALUES (?, ?)", (post_id, uid))
        liked = True
    db.commit()
    count = db.execute("SELECT COUNT(*) FROM account_likes WHERE post_id=?", (post_id,)).fetchone()[0]
    return jsonify({"liked": liked, "like_count": count})


@app.get("/api/posts/<int:post_id>/my-like")
def my_like(post_id):
    uid = session.get("user_id")
    liked = False
    if uid:
        liked = get_db().execute("SELECT 1 FROM account_likes WHERE post_id=? AND user_id=?", (post_id, uid)).fetchone() is not None
    return jsonify({"liked": liked})


init_db()
