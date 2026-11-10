import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, jsonify, request, g

app = Flask(__name__)
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


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/api/posts")
def list_posts():
    db = get_db()
    rows = db.execute("""
        SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count,
               (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS like_count
        FROM posts p ORDER BY p.id DESC LIMIT 100
    """).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/posts")
def create_post():
    data = parse_json()
    nickname = cleaned(data, "nickname", MAX_NAME)
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
        SELECT p.*, (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS like_count
        FROM posts p WHERE p.id=?
    """, (post_id,)).fetchone()
    if post is None:
        return error("게시글을 찾을 수 없습니다.", 404)
    comments = db.execute("SELECT * FROM comments WHERE post_id=? ORDER BY id ASC", (post_id,)).fetchall()
    return jsonify({"post": dict(post), "comments": [dict(row) for row in comments]})


@app.post("/api/posts/<int:post_id>/comments")
def create_comment(post_id):
    if not post_exists(post_id):
        return error("게시글을 찾을 수 없습니다.", 404)
    data = parse_json()
    nickname = cleaned(data, "nickname", MAX_NAME)
    content = cleaned(data, "content", MAX_COMMENT)
    if not nickname or not content:
        return error("닉네임(30자)과 댓글(1000자)을 확인해 주세요.")
    db = get_db()
    cur = db.execute("INSERT INTO comments (post_id, nickname, content) VALUES (?, ?, ?)", (post_id, nickname, content))
    db.commit()
    return jsonify({"id": cur.lastrowid, "message": "댓글이 등록되었습니다."}), 201


@app.put("/api/posts/<int:post_id>/like")
def toggle_like(post_id):
    if not post_exists(post_id):
        return error("게시글을 찾을 수 없습니다.", 404)
    data = parse_json()
    visitor_id = cleaned(data, "visitor_id", 80)
    if not visitor_id:
        return error("방문자 식별 정보가 필요합니다.")
    db = get_db()
    found = db.execute("SELECT 1 FROM likes WHERE post_id=? AND visitor_id=?", (post_id, visitor_id)).fetchone()
    if found:
        db.execute("DELETE FROM likes WHERE post_id=? AND visitor_id=?", (post_id, visitor_id))
        liked = False
    else:
        db.execute("INSERT INTO likes (post_id, visitor_id) VALUES (?, ?)", (post_id, visitor_id))
        liked = True
    db.commit()
    count = db.execute("SELECT COUNT(*) FROM likes WHERE post_id=?", (post_id,)).fetchone()[0]
    return jsonify({"liked": liked, "like_count": count})


init_db()
