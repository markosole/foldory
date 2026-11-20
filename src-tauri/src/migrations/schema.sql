-- Workspace schema version 1. Applied only when creating a new database.
BEGIN;
CREATE TABLE sources(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  json TEXT NOT NULL,
  connected INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX sources_connected ON sources(connected, path COLLATE NOCASE);
CREATE TABLE projects(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  json TEXT NOT NULL
);
CREATE INDEX projects_source ON projects(source_id);
CREATE TABLE templates(id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files(
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  directory INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  modified TEXT NOT NULL DEFAULT '',
  content_state INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, path)
);
CREATE INDEX files_name ON files(name COLLATE NOCASE);
CREATE INDEX files_folders ON files(directory, depth, project_id);
CREATE TABLE file_contents(
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY(project_id, path)
);
CREATE VIRTUAL TABLE file_text USING fts5(
  project_id UNINDEXED,
  path UNINDEXED,
  content,
  content='file_contents',
  content_rowid='rowid',
  tokenize='unicode61'
);
INSERT INTO file_text(file_text) VALUES('rebuild');
CREATE TRIGGER contents_insert AFTER INSERT ON file_contents BEGIN
  INSERT INTO file_text(rowid, project_id, path, content) VALUES(new.rowid, new.project_id, new.path, new.content);
END;
CREATE TRIGGER contents_delete AFTER DELETE ON file_contents BEGIN
  INSERT INTO file_text(file_text, rowid, project_id, path, content) VALUES('delete', old.rowid, old.project_id, old.path, old.content);
END;
CREATE TRIGGER contents_update AFTER UPDATE ON file_contents BEGIN
  INSERT INTO file_text(file_text, rowid, project_id, path, content) VALUES('delete', old.rowid, old.project_id, old.path, old.content);
  INSERT INTO file_text(rowid, project_id, path, content) VALUES(new.rowid, new.project_id, new.path, new.content);
END;
CREATE VIRTUAL TABLE file_names USING fts5(
  name,
  path,
  content='files',
  content_rowid='rowid',
  tokenize='trigram'
);
INSERT INTO file_names(file_names) VALUES('rebuild');
CREATE TRIGGER files_names_insert AFTER INSERT ON files BEGIN
  INSERT INTO file_names(rowid, name, path) VALUES(new.rowid, new.name, new.path);
END;
CREATE TRIGGER files_names_delete AFTER DELETE ON files BEGIN
  INSERT INTO file_names(file_names, rowid, name, path) VALUES('delete', old.rowid, old.name, old.path);
END;
CREATE TRIGGER files_names_update AFTER UPDATE OF name, path ON files WHEN old.name<>new.name OR old.path<>new.path BEGIN
  INSERT INTO file_names(file_names, rowid, name, path) VALUES('delete', old.rowid, old.name, old.path);
  INSERT INTO file_names(rowid, name, path) VALUES(new.rowid, new.name, new.path);
END;
CREATE TABLE project_indexes(
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  settings_hash TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL
);
CREATE TABLE inspector_write_access (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))
);
CREATE INDEX chats_scope ON chats(project_id, updated_at DESC);
CREATE INDEX chats_archive_scope ON chats(project_id, archived, updated_at DESC);
CREATE TABLE chat_selection (
  scope TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'pending', 'stopped', 'failed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_chat ON chat_messages(chat_id);
CREATE UNIQUE INDEX chat_messages_pending ON chat_messages(chat_id) WHERE status='pending';
CREATE TABLE chat_message_sources (
  message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  metadata TEXT NOT NULL,
  evidence TEXT NOT NULL
);
CREATE TABLE assistant_access (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('readOnly', 'write', 'full'))
);
CREATE TABLE chat_file_actions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'applying', 'applied', 'declined', 'failed')),
  content TEXT NOT NULL,
  before_content TEXT,
  expected_revision TEXT,
  reason TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, path)
);
CREATE INDEX chat_file_actions_message ON chat_file_actions(message_id, created_at);
PRAGMA user_version=1;
COMMIT;
