"""Keep local file operations, published rows and history in one recoverable update."""
from . import database, documents, operations, recycle
from .file_transaction import rollback_paths, database_transaction


def _within(path, prefix):
    return path == prefix or path.startswith(prefix + '/')


def _history_move(conn, source, destination):
    for row in conn.execute('SELECT id, path FROM local_document_versions').fetchall():
        if _within(row['path'], source):
            conn.execute('UPDATE local_document_versions SET path=? WHERE id=?',
                         (destination + row['path'][len(source):], row['id']))


def apply(conn, config, md_dir, binding, action, path, destination, payload, perform, confirm):
    source = operations._managed_path(md_dir, path)
    mount = binding['mount'] if binding else 'md'
    paths = [source] if action not in ('create', 'trash-empty') else []
    if destination is not None:
        paths.append(destination)
    trash = None
    if action in ('delete', 'restore', 'trash-empty'):
        mount = payload.get('mount') or mount
        trash = recycle.root_for(md_dir, mount)
        entry_id = payload.get('_trash_id') or payload.get('entryId')
        if entry_id:
            trash = trash / entry_id if action == 'delete' else recycle._entry_path(trash, entry_id)
        paths.append(trash)
    if action in ('move', 'delete') and source.is_file():
        refs = recycle._asset_paths(md_dir, path, documents.read_md_text(source))
        paths.extend(refs)
        if action == 'move':
            paths.extend(destination.parent / asset.relative_to(source.parent) for asset in refs)
    if action == 'restore':
        for asset in payload['_trash_meta'].get('assets') or []:
            paths.append(operations._managed_path(md_dir, 'md/' + asset))

    row = operations._ensure_local_binding(conn, binding, config) if binding else None
    with rollback_paths(paths), database_transaction(conn):
        result = perform()
        now = database.now_iso()
        revision = int(row.get('source_revision') or 0) + 1 if row else None
        if action in ('rename', 'move'):
            new_path = result['path']
            _history_move(conn, path, new_path)
            if row:
                for item in conn.execute('SELECT id, path FROM repository_documents WHERE binding_id=?', (row['id'],)).fetchall():
                    if _within(item['path'], path):
                        new = new_path + item['path'][len(path):]
                        conn.execute("DELETE FROM repository_documents WHERE binding_id=? AND path=? AND state='deleted'",
                                     (row['id'], new))
                        conn.execute('UPDATE repository_documents SET path=?, source_revision=?, updated_at=? WHERE id=?',
                                     (new, revision, now, item['id']))
        elif action == 'delete':
            archive = mount + '/' + recycle.NAME + '/' + result['id']
            _history_move(conn, path, archive)
            if row:
                for item in conn.execute('SELECT id, path FROM repository_documents WHERE binding_id=?', (row['id'],)).fetchall():
                    if _within(item['path'], path):
                        conn.execute("UPDATE repository_documents SET state='deleted', source_revision=?, updated_at=? WHERE id=?",
                                     (revision, now, item['id']))
        elif action == 'restore':
            archive = mount + '/' + recycle.NAME + '/' + result['id']
            _history_move(conn, archive, path)
        elif action == 'trash-empty':
            archive = mount + '/' + recycle.NAME
            if payload.get('entryId'):
                archive += '/' + payload['entryId']
            for item in conn.execute('SELECT id, path FROM local_document_versions').fetchall():
                if _within(item['path'], archive):
                    conn.execute('DELETE FROM local_document_versions WHERE id=?', (item['id'],))
        if row and action in ('create', 'restore'):
            target = operations._managed_path(md_dir, result['path'])
            files = [target] if target.is_file() else sorted(target.rglob('*.md'))
            for file in files:
                if file.suffix.lower() != '.md':
                    continue
                rel = 'md/' + operations._lexical_relative(md_dir, file)
                text = documents.read_md_text(file)
                conn.execute('INSERT OR REPLACE INTO repository_documents '
                             '(binding_id,path,content,content_hash,eol,source_revision,state,updated_at) '
                             "VALUES (?,?,?,?,?,?,'published',?)",
                             (row['id'], rel, documents.normalize_eol(text), documents.text_hash(text),
                              documents.detect_eol(text), revision, now))
        if row:
            current = conn.execute("SELECT path,content_hash FROM repository_documents WHERE binding_id=? AND state!='deleted'",
                                   (row['id'],)).fetchall()
            digest = operations._manifest_hash({item['path']: {'hash': item['content_hash']} for item in current})
            conn.execute('UPDATE repo_bindings SET source_revision=?,source_hash=?,updated_at=? WHERE id=?',
                         (revision, digest, now, row['id']))
        confirm(result)
    return result
