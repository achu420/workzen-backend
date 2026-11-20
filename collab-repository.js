import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { decodeMessage } from './collab-protocol.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asBytes = (value) => value instanceof Uint8Array ? value : new Uint8Array(value || []);

export class OfflinePageCollabRepository {
  constructor({ initialUpdate, version = 'offline-v1', databaseRestoreId = null, objectId = 'offline-page' }) {
    this.objectId = objectId; this.version = version; this.databaseRestoreId = databaseRestoreId; this.seen = new Set(); this.doc = new Y.Doc({ guid: objectId });
    try { Y.applyUpdate(this.doc, asBytes(initialUpdate)); } catch (error) { throw new Error(`Invalid initial AppFlowy page update: ${error.message}`); }
    if (this.doc.store.pendingStructs || this.doc.store.pendingDs) throw new Error('Initial update has unresolved Yjs dependencies');
  }
  stateVector() { return new Uint8Array(Y.encodeStateVector(this.doc)); }
  documentUpdate(flags = 0) { return new Uint8Array(flags === 1 ? Y.encodeStateAsUpdateV2(this.doc) : Y.encodeStateAsUpdate(this.doc)); }
  missingUpdate(stateVector, flags = 0) {
    let vector; try { vector = asBytes(stateVector); Y.decodeStateVector(vector); } catch (error) { throw new Error(`Invalid state vector: ${error.message}`); }
    return new Uint8Array(flags === 1 ? Y.encodeStateAsUpdateV2(this.doc, vector) : Y.encodeStateAsUpdate(this.doc, vector));
  }
  validateUpdate({ flags = 0, payload, version = this.version, beforeStateVector, databaseRestoreId = this.databaseRestoreId, messageId } = {}) {
    const bytes = asBytes(payload);
    if (flags !== 0 && flags !== 1) return { accepted: false, status: 'rejected', reason: 'UNSUPPORTED_FLAGS' };
    if (!bytes.byteLength) return { accepted: false, status: 'rejected', reason: 'EMPTY_PAYLOAD' };
    if (version !== this.version) return { accepted: false, status: 'rejected', reason: 'VERSION_MISMATCH' };
    if ((databaseRestoreId || null) !== this.databaseRestoreId) return { accepted: false, status: 'rejected', reason: 'RESTORE_GENERATION_MISMATCH' };
    if (beforeStateVector && asBytes(beforeStateVector).byteLength > 0) { try { Y.decodeStateVector(asBytes(beforeStateVector)); } catch { return { accepted: false, status: 'rejected', reason: 'INVALID_BEFORE_STATE_VECTOR' }; } }
    const key = messageId ? `${messageId.timestamp ?? 0}-${messageId.counter ?? 0}` : digest(bytes);
    if (this.seen.has(key)) return { accepted: false, status: 'duplicate', duplicate: true, reason: 'DUPLICATE_DELIVERY', durable: false };
    try {
      const candidate = new Y.Doc({ guid: this.objectId });
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.doc));
      flags === 1 ? Y.applyUpdateV2(candidate, bytes) : Y.applyUpdate(candidate, bytes);
      if (candidate.store.pendingStructs || candidate.store.pendingDs) return { accepted: false, status: 'rejected', reason: 'UNRESOLVED_DEPENDENCY' };
    } catch { return { accepted: false, status: 'rejected', reason: 'MALFORMED_YJS_UPDATE' }; }
    return { accepted: true, status: 'validated', duplicate: false, key, durable: false };
  }
  acceptUpdate(metadata) {
    const validation = this.validateUpdate(metadata); if (!validation.accepted) return validation;
    const bytes = asBytes(metadata.payload);
    try { metadata.flags === 1 ? Y.applyUpdateV2(this.doc, bytes) : Y.applyUpdate(this.doc, bytes); } catch { return { accepted: false, status: 'rejected', reason: 'MALFORMED_YJS_UPDATE' }; }
    this.seen.add(validation.key);
    return { accepted: true, status: 'applied', duplicate: false, durable: false, acknowledged: false, stateVector: this.stateVector() };
  }
  applyMessage(bytes) {
    let message; try { message = decodeMessage(asBytes(bytes)); } catch { return { accepted: false, status: 'rejected', reason: 'MALFORMED_PROTOBUF' }; }
    const collab = message.collabMessage; if (!collab || collab.objectId !== this.objectId) return { accepted: false, status: 'rejected', reason: 'OBJECT_ID_MISMATCH' };
    if (collab.update) return this.acceptUpdate({ flags: collab.update.flags, payload: collab.update.payload, version: collab.update.version, beforeStateVector: collab.update.beforeStateVector, databaseRestoreId: collab.update.databaseRestoreId, messageId: collab.update.messageId });
    if (collab.syncRequest) return { accepted: true, status: 'sync-response', missingUpdate: this.missingUpdate(collab.syncRequest.stateVector), stateVector: this.stateVector(), durable: false };
    return { accepted: false, status: 'rejected', reason: 'UNSUPPORTED_MESSAGE' };
  }
}
