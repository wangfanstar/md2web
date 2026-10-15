"""本地已发布文档的共享历史；与个人 SVN 草稿隔离。调用方持数据库锁。"""
from . import database, documents, drafts


def record(conn, path, before, after, actor_id):
    path = documents.normalize_md_path(path)
    for text in (before, after):
        if text is None:
            continue
        text = documents.normalize_eol(text)
        latest = conn.execute('SELECT content FROM local_document_versions WHERE path=? ORDER BY id DESC LIMIT 1', (path,)).fetchone()
        if latest is None or latest['content'] != text:
            conn.execute('INSERT INTO local_document_versions (path, content, actor_id, created_at) VALUES (?, ?, ?, ?)',
                         (path, text, actor_id, database.now_iso()))


def get_revision(conn, path, ref):
    path = documents.normalize_md_path(path)
    try:
        revision_id = int(str(ref).split(':', 1)[1])
    except (ValueError, IndexError):
        raise drafts.DraftError(400, '无效的本地版本号')
    row = conn.execute('SELECT * FROM local_document_versions WHERE id=? AND path=?', (revision_id, path)).fetchone()
    if row is None:
        raise drafts.DraftError(404, '该文档的版本不存在')
    return {'id': 'local:' + str(row['id']), 'content': row['content'],
            'hash': documents.text_hash(row['content']), 'createdAt': row['created_at'], 'baseRevision': None}


def list_history(conn, md_dir, path):
    path = documents.normalize_md_path(path)
    rows = conn.execute('SELECT * FROM local_document_versions WHERE path=? ORDER BY id DESC LIMIT 200', (path,)).fetchall()
    current = drafts.published_text(md_dir, path)
    return {'path': path, 'mode': 'local', 'revisions': [
        {'id': 'local:' + str(row['id']), 'createdAt': row['created_at'],
         'size': len(row['content'].encode('utf-8')), 'draftVersion': row['id'],
         'isHead': i == 0 and documents.text_hash(row['content']) == documents.text_hash(current)}
        for i, row in enumerate(rows)]}


def diff_documents(conn, md_dir, path, from_ref, to_ref):
    path = documents.normalize_md_path(path)
    current = drafts.published_text(md_dir, path)
    if current is None:
        raise drafts.DraftError(404, '文档不存在')

    def resolve(ref):
        if ref in (None, '', 'published'):
            return '当前已保存版本', current
        if ref == 'previous':
            rows = conn.execute('SELECT content FROM local_document_versions WHERE path=? ORDER BY id DESC LIMIT 2', (path,)).fetchall()
            if rows and documents.text_hash(rows[0]['content']) == documents.text_hash(current):
                rows = rows[1:]
            if not rows:
                raise drafts.DraftError(404, '尚无上一版本；保存修改后即可查看差异（升级前未记录的历史无法恢复）')
            return '上一版本', rows[0]['content']
        revision = get_revision(conn, path, ref)
        return '版本 #' + revision['id'], revision['content']

    before_label, before = resolve(from_ref)
    after_label, after = resolve(to_ref)
    before, after = documents.normalize_eol(before), documents.normalize_eol(after)
    return {'path': path, 'from': {'label': before_label}, 'to': {'label': after_label},
            'diff': drafts.unified_diff(before, after, path), 'identical': before == after}
