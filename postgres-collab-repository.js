import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';

const bytes = (value) => value instanceof Uint8Array ? value : new Uint8Array(value || []);
const buffer = (value) => Buffer.from(bytes(value));
const digest = (value) => createHash('sha256').update(buffer(value)).digest('hex');

function failure(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function decodeStateVector(value, label) {
  try { return Y.decodeStateVector(bytes(value)); }
  catch { throw failure(`INVALID_${label.toUpperCase()}`, `${label} is not a valid Yjs state vector`); }
}

function stateVectorCovers(current, required) {
  for (const [clientId, clock] of required) {
    if ((current.get(clientId) || 0) < clock) return false;
  }
  return true;
}

export function preparePageCollabUpdate({
  objectId,
  documentState,
  flags = 0,
  payload,
  beforeStateVector = null,
  collabVersion,
  expectedCollabVersion,
  restoreId = null,
  expectedRestoreId = null,
}) {
  if (flags !== 0 && flags !== 1) throw failure('UNSUPPORTED_FLAGS', 'only Yjs v1 and v2 updates are supported');
  const update = bytes(payload);
  if (!update.byteLength) throw failure('EMPTY_UPDATE', 'update payload must not be empty');
  if (collabVersion && collabVersion !== expectedCollabVersion) {
    throw failure('VERSION_MISMATCH', 'collaboration version mismatch');
  }
  if ((restoreId || null) !== (expectedRestoreId || null)) {
    throw failure('RESTORE_GENERATION_MISMATCH', 'restore generation mismatch');
  }

  const doc = new Y.Doc({ guid: objectId });
  try {
    Y.applyUpdate(doc, bytes(documentState));
    if (doc.store.pendingStructs || doc.store.pendingDs) {
      throw failure('INVALID_STORED_DOCUMENT', 'stored document has unresolved Yjs dependencies');
    }

    if (beforeStateVector && bytes(beforeStateVector).byteLength) {
      const currentVector = Y.decodeStateVector(Y.encodeStateVector(doc));
      const beforeVector = decodeStateVector(beforeStateVector, 'before state vector');
      if (!stateVectorCovers(currentVector, beforeVector)) {
        throw failure('MISSING_CAUSAL_STATE', 'server state does not cover the update before-state vector');
      }
    }

    try {
      if (flags === 1) Y.applyUpdateV2(doc, update);
      else Y.applyUpdate(doc, update);
    } catch {
      throw failure('MALFORMED_YJS_UPDATE', 'update is not a valid Yjs update');
    }
    if (doc.store.pendingStructs || doc.store.pendingDs) {
      throw failure('UNRESOLVED_DEPENDENCY', 'update has unresolved Yjs dependencies');
    }

    return {
      documentState: new Uint8Array(Y.encodeStateAsUpdate(doc)),
      stateVector: new Uint8Array(Y.encodeStateVector(doc)),
    };
  } finally {
    doc.destroy();
  }
}

function rowDocument(row) {
  return {
    workspaceId: row.workspace_id,
    pageId: row.page_id,
    collabVersion: row.collab_version,
    restoreId: row.restore_id,
    documentState: new Uint8Array(row.document_state),
    stateVector: new Uint8Array(row.state_vector),
    generation: Number(row.generation),
    lastMessageId: {
      timestamp: Number(row.last_message_id_timestamp || 0),
      counter: Number(row.last_message_id_counter || 0),
    },
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function allocateMessageId(client, workspaceId) {
  const result = await client.query(
    `INSERT INTO collab_workspace_rids AS current (workspace_id, timestamp, counter)
     VALUES($1, $2, 0)
     ON CONFLICT (workspace_id) DO UPDATE SET
       timestamp = CASE
         WHEN current.timestamp < EXCLUDED.timestamp THEN EXCLUDED.timestamp
         WHEN current.counter = 4294967295 THEN current.timestamp + 1
         ELSE current.timestamp
       END,
       counter = CASE
         WHEN current.timestamp < EXCLUDED.timestamp OR current.counter = 4294967295 THEN 0
         ELSE current.counter + 1
       END
     RETURNING timestamp, counter`,
    [workspaceId, Date.now()]
  );
  return {
    timestamp: Number(result.rows[0].timestamp),
    counter: Number(result.rows[0].counter),
  };
}

export class PostgresPageCollabRepository {
  constructor(pool) { this.pool = pool; }

  async persistInitial({ workspaceId, pageId, documentState, stateVector, collabVersion = 'appflowy-page-v1', restoreId = null, updatedAt = new Date() }) {
    const state = bytes(documentState); const vector = bytes(stateVector);
    if (!state.byteLength) throw failure('EMPTY_DOCUMENT_STATE', 'document state must not be empty');
    decodeStateVector(vector, 'state vector');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const page = await client.query('SELECT 1 FROM pages WHERE id=$1 AND workspace_id=$2', [pageId, workspaceId]);
      if (!page.rowCount) throw failure('PAGE_NOT_FOUND', 'page does not belong to workspace');
      const result = await client.query(`INSERT INTO collab_documents(workspace_id,page_id,collab_version,restore_id,document_state,state_vector,generation,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,0,$7) ON CONFLICT (workspace_id,page_id) DO NOTHING RETURNING workspace_id,page_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at`,
      [workspaceId, pageId, collabVersion, restoreId, buffer(state), buffer(vector), updatedAt]);
      if (!result.rowCount) throw failure('COLLAB_DOCUMENT_EXISTS', 'collaboration document already exists');
      await client.query('COMMIT');
      return rowDocument(result.rows[0]);
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async load({ workspaceId, pageId }) {
    const result = await this.pool.query(`SELECT d.workspace_id,d.page_id,d.collab_version,d.restore_id,d.document_state,d.state_vector,d.generation,d.last_message_id_timestamp,d.last_message_id_counter,d.updated_at
      FROM collab_documents d JOIN pages p ON p.id=d.page_id AND p.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND d.page_id=$2`, [workspaceId, pageId]);
    return result.rows[0] ? rowDocument(result.rows[0]) : null;
  }

  async acceptUpdate({ workspaceId, pageId, flags = 0, payload, beforeStateVector = null, collabVersion = 'appflowy-page-v1', restoreId = null, messageKey = null, createdAt = new Date() }) {
    const update = bytes(payload);
    const payloadDigest = digest(update);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT d.workspace_id,d.page_id,d.collab_version,d.restore_id,d.document_state,d.state_vector,d.generation,d.last_message_id_timestamp,d.last_message_id_counter,d.updated_at
        FROM collab_documents d JOIN pages p ON p.id=d.page_id AND p.workspace_id=d.workspace_id
        WHERE d.workspace_id=$1 AND d.page_id=$2 FOR UPDATE`, [workspaceId, pageId]);
      if (!result.rowCount) throw failure('COLLAB_DOCUMENT_NOT_FOUND', 'collaboration document or page not found');
      const current = rowDocument(result.rows[0]);
      const duplicate = await client.query(`SELECT id,message_id_timestamp,message_id_counter FROM collab_updates WHERE workspace_id=$1 AND page_id=$2 AND (payload_digest=$3 OR ($4::text IS NOT NULL AND message_key=$4)) LIMIT 1`, [workspaceId, pageId, payloadDigest, messageKey]);
      if (duplicate.rowCount) {
        let messageId = duplicate.rows[0].message_id_timestamp === null
          ? await allocateMessageId(client, workspaceId)
          : {
              timestamp: Number(duplicate.rows[0].message_id_timestamp),
              counter: Number(duplicate.rows[0].message_id_counter),
            };
        if (duplicate.rows[0].message_id_timestamp === null) {
          await client.query(
            'UPDATE collab_updates SET message_id_timestamp=$2,message_id_counter=$3 WHERE id=$1',
            [duplicate.rows[0].id, messageId.timestamp, messageId.counter]
          );
          await client.query(
            `UPDATE collab_documents SET last_message_id_timestamp=$3,last_message_id_counter=$4
             WHERE workspace_id=$1 AND page_id=$2`,
            [workspaceId, pageId, messageId.timestamp, messageId.counter]
          );
        }
        await client.query('COMMIT');
        return { status: 'duplicate', duplicate: true, durable: true, acknowledged: true, messageId, ...current };
      }
      const prepared = preparePageCollabUpdate({
        objectId: pageId,
        documentState: current.documentState,
        flags,
        payload: update,
        beforeStateVector,
        collabVersion,
        expectedCollabVersion: current.collabVersion,
        restoreId,
        expectedRestoreId: current.restoreId,
      });
      const messageId = await allocateMessageId(client, workspaceId);
      const inserted = await client.query(`INSERT INTO collab_updates(workspace_id,page_id,payload_digest,message_key,flags,payload,before_state_vector,collab_version,restore_id,created_at,message_id_timestamp,message_id_counter)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [workspaceId, pageId, payloadDigest, messageKey, flags, buffer(update), beforeStateVector ? buffer(beforeStateVector) : null, collabVersion, restoreId, createdAt, messageId.timestamp, messageId.counter]);
      const updated = await client.query(`UPDATE collab_documents SET document_state=$3,state_vector=$4,generation=generation+1,last_message_id_timestamp=$5,last_message_id_counter=$6,updated_at=$7
        WHERE workspace_id=$1 AND page_id=$2 AND generation=$8 RETURNING workspace_id,page_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at`, [workspaceId, pageId, buffer(prepared.documentState), buffer(prepared.stateVector), messageId.timestamp, messageId.counter, createdAt, current.generation]);
      if (!updated.rowCount) throw failure('CONCURRENT_UPDATE', 'document generation changed during update');
      await client.query('COMMIT');
      return { status: 'applied', duplicate: false, durable: true, acknowledged: true, messageId, updateId: inserted.rows[0].id, ...rowDocument(updated.rows[0]) };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }
}

function rowVersion(row) {
  return {
    version: row.version,
    parent: row.parent,
    name: row.name,
    document_state: Array.from(bytes(row.document_state)),
    created_at: new Date(row.created_at).toISOString(),
    created_by: row.created_by == null ? null : Number(row.created_by),
    deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    editors: (row.editors || []).map(Number),
    kind: row.kind,
  };
}

function computeStateVectorFromDocumentState(state) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes(state));
    return new Uint8Array(Y.encodeStateVector(doc));
  } finally {
    doc.destroy();
  }
}

// --- Task 49B: document version history / restore (PostgreSQL parity for
// Task 49A's JSON implementation). Versions are append-only and tombstoned
// (never physically deleted). Each version stores a complete, independently
// reconstructable Yjs document state.
Object.assign(PostgresPageCollabRepository.prototype, {
  async pageRow(client, workspaceId, pageId) {
    const r = await client.query(
      `SELECT d.workspace_id,d.page_id,d.collab_version,d.restore_id,d.document_state,d.state_vector,d.generation,d.last_message_id_timestamp,d.last_message_id_counter,d.updated_at
       FROM collab_documents d JOIN pages p ON p.id=d.page_id AND p.workspace_id=d.workspace_id
       WHERE d.workspace_id=$1 AND d.page_id=$2`,
      [workspaceId, pageId]
    );
    return r.rowCount ? rowDocument(r.rows[0]) : null;
  },

  async listVersions(workspaceId, pageId, { since } = {}) {
    const client = await this.pool.connect();
    try {
      const found = await this.pageRow(client, workspaceId, pageId);
      if (!found) return null;
      const r = await client.query(
        `SELECT version,parent,name,document_state,created_at,created_by,deleted_at,editors,kind
         FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND deleted_at IS NULL
         ${since ? 'AND created_at > to_timestamp($3::double precision / 1000.0)' : ''}
         ORDER BY created_at ASC`,
        since ? [workspaceId, pageId, since] : [workspaceId, pageId]
      );
      return r.rows.map(rowVersion);
    } finally { client.release(); }
  },

  async getVersion(workspaceId, pageId, versionId) {
    const client = await this.pool.connect();
    try {
      const found = await this.pageRow(client, workspaceId, pageId);
      if (!found) return null;
      const r = await client.query(
        `SELECT version,parent,name,document_state,created_at,created_by,deleted_at,editors,kind
         FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND version=$3`,
        [workspaceId, pageId, versionId]
      );
      return r.rowCount ? rowVersion(r.rows[0]) : null;
    } finally { client.release(); }
  },

  async createVersion(workspaceId, pageId, { name, documentState, actorUid, kind = 'named', editors }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await this.pageRow(client, workspaceId, pageId);
      if (!found) { await client.query('COMMIT'); return null; }
      const latest = await client.query(
        `SELECT version FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, pageId]
      );
      const entry = {
        version: randomUUID(),
        parent: latest.rowCount ? latest.rows[0].version : null,
        name: name || null,
        document_state: Buffer.from(bytes(documentState)),
        created_at: new Date(),
        created_by: actorUid ?? null,
        editors: editors ?? (actorUid != null ? [actorUid] : []),
        kind,
      };
      await client.query(
        `INSERT INTO collab_versions(version,workspace_id,page_id,parent,name,document_state,kind,created_at,created_by,editors)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [entry.version, workspaceId, pageId, entry.parent, entry.name, entry.document_state, entry.kind, entry.created_at, entry.created_by, entry.editors]
      );
      await client.query('COMMIT');
      return { ...entry, document_state: Array.from(bytes(entry.document_state)), created_at: entry.created_at.toISOString(), deleted_at: null };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  },

  // Keeps the newest `keep` automatic versions; older ones are tombstoned, and tombstoned automatic versions older than
  // 30 days that no restore event refers to are removed for good.
  async pruneAutoVersions(workspaceId, pageId, keep) {
    const hidden = await this.pool.query(
      `UPDATE collab_versions SET deleted_at = now()
       WHERE version IN (SELECT version FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND kind='auto' AND deleted_at IS NULL ORDER BY created_at DESC OFFSET $3)`,
      [workspaceId, pageId, keep]
    );
    await this.pool.query(
      `DELETE FROM collab_versions v WHERE v.workspace_id=$1 AND v.page_id=$2 AND v.kind='auto' AND v.deleted_at < now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM restore_events r WHERE r.restored_version_id = v.version OR r.before_restore_snapshot_version_id = v.version)`,
      [workspaceId, pageId]
    );
    return hidden.rowCount;
  },
  async tombstoneVersion(workspaceId, pageId, versionId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await this.pageRow(client, workspaceId, pageId);
      if (!found) { await client.query('COMMIT'); return { status: 'not_found' }; }
      const r = await client.query(
        `SELECT deleted_at FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND version=$3 FOR UPDATE`,
        [workspaceId, pageId, versionId]
      );
      if (!r.rowCount) { await client.query('COMMIT'); return { status: 'not_found' }; }
      if (r.rows[0].deleted_at) { await client.query('COMMIT'); return { status: 'already_deleted' }; }
      await client.query(`UPDATE collab_versions SET deleted_at=now() WHERE workspace_id=$1 AND page_id=$2 AND version=$3`, [workspaceId, pageId, versionId]);
      await client.query('COMMIT');
      return { status: 'deleted' };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  },

  // Restore to a previously stored version. Does NOT allocate a workspace
  // Rid. Runs in a single transaction: row-locks the collab_documents row
  // (FOR UPDATE) to serialize concurrent restores/updates for this page
  // (first durable writer wins -- mirrors JSON's single-writer queue).
  // Idempotency: a digest of (pageId, targetVersionId) is compared against
  // the most recently applied restore event for this page; if it matches
  // and the document's restore_id still equals that event's resulting
  // restore id (i.e. nothing else has mutated the row since), the request
  // is treated as a retry and the same result is returned without creating
  // a second before-restore snapshot / restore event / generation bump.
  async restoreVersion({ workspaceId, pageId, versionId, actorUid }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const docResult = await client.query(
        `SELECT d.workspace_id,d.page_id,d.collab_version,d.restore_id,d.document_state,d.state_vector,d.generation,d.last_message_id_timestamp,d.last_message_id_counter,d.updated_at
         FROM collab_documents d JOIN pages p ON p.id=d.page_id AND p.workspace_id=d.workspace_id
         WHERE d.workspace_id=$1 AND d.page_id=$2 FOR UPDATE`,
        [workspaceId, pageId]
      );
      if (!docResult.rowCount) throw failure('COLLAB_DOCUMENT_NOT_FOUND', 'Collaboration document or page not found');
      const current = rowDocument(docResult.rows[0]);
      const digestValue = createHash('sha256').update(`${pageId}:${versionId}`).digest('hex');

      const lastEvent = await client.query(
        `SELECT digest, resulting_restore_id FROM restore_events WHERE workspace_id=$1 AND page_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, pageId]
      );
      if (lastEvent.rowCount && lastEvent.rows[0].digest === digestValue && lastEvent.rows[0].resulting_restore_id === current.restoreId) {
        await client.query('COMMIT');
        return {
          status: 'duplicate',
          duplicate: true,
          documentState: current.documentState,
          stateVector: current.stateVector,
          collabVersion: current.collabVersion,
          restoreId: current.restoreId,
        };
      }

      const targetResult = await client.query(
        `SELECT version,document_state,deleted_at FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND version=$3`,
        [workspaceId, pageId, versionId]
      );
      if (!targetResult.rowCount) throw failure('VERSION_NOT_FOUND', 'Target version not found');
      if (targetResult.rows[0].deleted_at) throw failure('VERSION_DELETED', 'Target version has been deleted');

      const latest = await client.query(
        `SELECT version FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, pageId]
      );
      const beforeRestoreVersionId = randomUUID();
      const now = new Date();
      await client.query(
        `INSERT INTO collab_versions(version,workspace_id,page_id,parent,name,document_state,kind,created_at,created_by,editors)
         VALUES($1,$2,$3,$4,NULL,$5,'before_restore',$6,$7,$8)`,
        [beforeRestoreVersionId, workspaceId, pageId, latest.rowCount ? latest.rows[0].version : null, buffer(current.documentState), now, actorUid ?? null, actorUid != null ? [actorUid] : []]
      );

      const restoredState = bytes(targetResult.rows[0].document_state);
      const restoredVector = computeStateVectorFromDocumentState(restoredState);
      const newRestoreId = randomUUID();

      const updated = await client.query(
        `UPDATE collab_documents SET document_state=$3,state_vector=$4,restore_id=$5,generation=generation+1,updated_at=$6
         WHERE workspace_id=$1 AND page_id=$2 AND generation=$7 RETURNING document_state,state_vector,collab_version,restore_id`,
        [workspaceId, pageId, buffer(restoredState), buffer(restoredVector), newRestoreId, now, current.generation]
      );
      if (!updated.rowCount) throw failure('CONCURRENT_UPDATE', 'document generation changed during restore');

      await client.query(
        `INSERT INTO restore_events(id,workspace_id,page_id,digest,restored_version_id,before_restore_snapshot_version_id,resulting_restore_id,actor,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), workspaceId, pageId, digestValue, versionId, beforeRestoreVersionId, newRestoreId, actorUid ?? null, now]
      );

      await client.query('COMMIT');
      return {
        status: 'applied',
        duplicate: false,
        documentState: new Uint8Array(updated.rows[0].document_state),
        stateVector: new Uint8Array(updated.rows[0].state_vector),
        collabVersion: updated.rows[0].collab_version,
        restoreId: updated.rows[0].restore_id,
      };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  },
});

export const createPostgresPageCollabRepository = (pool) => new PostgresPageCollabRepository(pool);

// --- Task 63: generic collab-object repository for Database (CollabType=1)
// and DatabaseRow (CollabType=4) PostgreSQL storage. ---
//
// Task 61 found `preparePageCollabUpdate` above is already fully
// object-agnostic (it only needs objectId/documentState/payload/version
// fencing, nothing Document-specific), so this reuses it verbatim rather
// than writing a third copy. `allocateMessageId` (the workspace-wide RID
// allocator, exported above) is reused unmodified too -- Database and
// DatabaseRow updates draw from the exact same `collab_workspace_rids`
// sequence as Document updates, so there is still only ONE RID allocator in
// the whole system, matching JSON mode's single `s.workspaceRids` map.
//
// This is deliberately a *new*, narrow class rather than a refactor of
// PostgresPageCollabRepository: that class also carries Document-only
// version-history/restore methods (Task 49B) that have no Database/
// DatabaseRow equivalent and are explicitly out of scope for Task 63, and
// touching its working, already-tested load/acceptUpdate methods to
// generalize them would risk the exact kind of regression the task brief
// warns against. The two classes share logic only through the two exported
// free functions above.
function genericObjectRow(row, idColumn) {
  return {
    workspaceId: row.workspace_id,
    [idColumn]: row[idColumn],
    collabVersion: row.collab_version,
    restoreId: row.restore_id,
    documentState: new Uint8Array(row.document_state),
    stateVector: new Uint8Array(row.state_vector),
    generation: Number(row.generation),
    lastMessageId: {
      timestamp: Number(row.last_message_id_timestamp || 0),
      counter: Number(row.last_message_id_counter || 0),
    },
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresGenericObjectCollabRepository {
  constructor(pool, { documentsTable, updatesTable, idColumn }) {
    this.pool = pool;
    this.documentsTable = documentsTable;
    this.updatesTable = updatesTable;
    this.idColumn = idColumn;
  }

  async load({ workspaceId, objectId }) {
    const result = await this.pool.query(
      `SELECT workspace_id, ${this.idColumn}, collab_version, restore_id, document_state, state_vector, generation, last_message_id_timestamp, last_message_id_counter, updated_at
       FROM ${this.documentsTable} WHERE workspace_id=$1 AND ${this.idColumn}=$2`,
      [workspaceId, objectId]
    );
    return result.rows[0] ? genericObjectRow(result.rows[0], this.idColumn) : null;
  }

  async acceptUpdate({ workspaceId, objectId, flags = 0, payload, beforeStateVector = null, collabVersion, restoreId = null, messageKey = null, createdAt = new Date() }) {
    const update = bytes(payload);
    const payloadDigest = digest(update);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT workspace_id, ${this.idColumn}, collab_version, restore_id, document_state, state_vector, generation, last_message_id_timestamp, last_message_id_counter, updated_at
         FROM ${this.documentsTable} WHERE workspace_id=$1 AND ${this.idColumn}=$2 FOR UPDATE`,
        [workspaceId, objectId]
      );
      if (!result.rowCount) throw failure('COLLAB_DOCUMENT_NOT_FOUND', 'collaboration document not found');
      const current = genericObjectRow(result.rows[0], this.idColumn);
      const duplicate = await client.query(
        `SELECT id, message_id_timestamp, message_id_counter FROM ${this.updatesTable}
         WHERE workspace_id=$1 AND ${this.idColumn}=$2 AND (payload_digest=$3 OR ($4::text IS NOT NULL AND message_key=$4)) LIMIT 1`,
        [workspaceId, objectId, payloadDigest, messageKey]
      );
      if (duplicate.rowCount) {
        let messageId = duplicate.rows[0].message_id_timestamp === null
          ? await allocateMessageId(client, workspaceId)
          : {
              timestamp: Number(duplicate.rows[0].message_id_timestamp),
              counter: Number(duplicate.rows[0].message_id_counter),
            };
        if (duplicate.rows[0].message_id_timestamp === null) {
          await client.query(
            `UPDATE ${this.updatesTable} SET message_id_timestamp=$2,message_id_counter=$3 WHERE id=$1`,
            [duplicate.rows[0].id, messageId.timestamp, messageId.counter]
          );
          await client.query(
            `UPDATE ${this.documentsTable} SET last_message_id_timestamp=$3,last_message_id_counter=$4
             WHERE workspace_id=$1 AND ${this.idColumn}=$2`,
            [workspaceId, objectId, messageId.timestamp, messageId.counter]
          );
        }
        await client.query('COMMIT');
        return { status: 'duplicate', duplicate: true, durable: true, acknowledged: true, messageId, ...current };
      }
      const prepared = preparePageCollabUpdate({
        objectId,
        documentState: current.documentState,
        flags,
        payload: update,
        beforeStateVector,
        collabVersion,
        expectedCollabVersion: current.collabVersion,
        restoreId,
        expectedRestoreId: current.restoreId,
      });
      const messageId = await allocateMessageId(client, workspaceId);
      const inserted = await client.query(
        `INSERT INTO ${this.updatesTable}(workspace_id,${this.idColumn},payload_digest,message_key,flags,payload,before_state_vector,collab_version,restore_id,created_at,message_id_timestamp,message_id_counter)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [workspaceId, objectId, payloadDigest, messageKey, flags, buffer(update), beforeStateVector ? buffer(beforeStateVector) : null, collabVersion ?? current.collabVersion, restoreId, createdAt, messageId.timestamp, messageId.counter]
      );
      const updated = await client.query(
        `UPDATE ${this.documentsTable} SET document_state=$3,state_vector=$4,generation=generation+1,last_message_id_timestamp=$5,last_message_id_counter=$6,updated_at=$7
         WHERE workspace_id=$1 AND ${this.idColumn}=$2 AND generation=$8
         RETURNING workspace_id,${this.idColumn},collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at`,
        [workspaceId, objectId, buffer(prepared.documentState), buffer(prepared.stateVector), messageId.timestamp, messageId.counter, createdAt, current.generation]
      );
      if (!updated.rowCount) throw failure('CONCURRENT_UPDATE', 'document generation changed during update');
      await client.query('COMMIT');
      return { status: 'applied', duplicate: false, durable: true, acknowledged: true, messageId, updateId: inserted.rows[0].id, ...genericObjectRow(updated.rows[0], this.idColumn) };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }
}

export const createPostgresDatabaseCollabRepository = (pool) => new PostgresGenericObjectCollabRepository(pool, {
  documentsTable: 'database_collab_documents', updatesTable: 'database_collab_updates', idColumn: 'database_id',
});
export const createPostgresDatabaseRowCollabRepository = (pool) => new PostgresGenericObjectCollabRepository(pool, {
  documentsTable: 'database_row_collab_documents', updatesTable: 'database_row_collab_updates', idColumn: 'row_id',
});
