import { createHash } from 'node:crypto';
import * as Y from 'yjs';

const UUID_NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const RUST_NANOID_SAFE_ALPHABET = '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function uuidBytes(value) {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

export function uuidV5(name, namespace) {
  const hash = createHash('sha1').update(Buffer.concat([uuidBytes(namespace), Buffer.from(name)])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableId(documentId, role) {
  const documentUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)
    ? documentId
    : uuidV5(documentId, UUID_NAMESPACE_OID);
  const hex = uuidV5(role, documentUuid).replaceAll('-', '');
  let value = '';

  for (let index = 0; index < 10; index += 1) {
    value += RUST_NANOID_SAFE_ALPHABET[Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) & 0x3f];
  }

  return value;
}

export function rowDocumentIdFromRowId(rowId) {
  return uuidV5('document_id', rowId);
}

/** Matches AppFlowy-Web's pageIdFromDocumentId (slate-yjs/utils/yjs.ts). */
export function pageIdFromDocumentId(documentId) {
  return uuidV5('page', documentId);
}

/**
 * Task 79: decodes AppFlowy-Web's encodeCreationCollab() wire format
 * (src/application/database-yjs/creation/encoded-collab.ts) --
 * [u64 LE vector_len][vector][u64 LE state_len][state][1 trailing byte],
 * base64-encoded. The trailing byte is a fixed EncoderVersion discriminant
 * (always 0/V1 from this encoder -- "an absent collab_version is omitted by
 * serde" per that function's own comment: a true Option<version> field would
 * need its own presence byte, but this encoder never writes one, so the
 * buffer is always exactly vector+state+1 bytes). Used by the "seeded"
 * template-row-creation path (database/{id}/row) to accept a client-built
 * row and/or document Y.Doc directly, rather than reconstructing it
 * server-side from loose fields the way default-row-creation does.
 */
export function decodeCreationCollab(base64) {
  if (typeof base64 !== 'string' || !base64) throw new Error('A creation collab string is required');
  let bytes;

  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new Error('Malformed creation collab encoding');
  }
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error('Creation collab exceeds its size limit');
  let offset = 0;
  const readChunk = () => {
    if (offset + 8 > bytes.length) throw new Error('Truncated creation collab');
    const length = bytes.readBigUInt64LE(offset);

    offset += 8;
    if (length < 0n || length > BigInt(bytes.length - offset)) throw new Error('Truncated creation collab');
    const chunk = Uint8Array.prototype.slice.call(bytes, offset, offset + Number(length));

    offset += Number(length);
    return chunk;
  };
  const vector = readChunk();
  const state = readChunk();

  if (offset + 1 !== bytes.length) throw new Error('Unexpected trailing creation collab bytes');
  if (bytes[offset] !== 0) throw new Error('Unsupported creation collab encoder version');
  if (!vector.length || !state.length) throw new Error('Empty creation collab fields');

  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, state);
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Creation collab history is incomplete');
    const actual = Y.decodeStateVector(Y.encodeStateVector(doc));
    const expected = Y.decodeStateVector(vector);

    if (expected.size !== actual.size || [...expected].some(([client, clock]) => actual.get(client) !== clock)) {
      throw new Error('Creation collab state vector does not match its state');
    }

    return { doc, state, vector };
  } catch (decodeError) {
    doc.destroy();
    throw decodeError;
  }
}

/**
 * Task 79: applies AppFlowy-Web's compileFirstBodyActions() output
 * (src/application/row-document/first-body-actions.ts) to the exact
 * blank-with-default-paragraph structure createInitialPageCollab builds
 * below -- a client compiles those actions as the delta FROM that same
 * blank shape TO its real content, so starting from it and replaying the
 * actions in order reconstructs the client's document byte-for-byte.
 * Only 'Delete'/'Insert'/'InsertText' ever appear in that output (first-time
 * creation, never an incremental edit), so 'ApplyTextDelta' is not handled.
 */
function applyFirstBodyActions(doc, actions) {
  const document = doc.getMap('data').get('document');
  const blocks = document.get('blocks');
  const metadata = document.get('meta');
  const children = metadata.get('children_map');
  const texts = metadata.get('text_map');
  const removeFromParent = (block) => {
    const parent = blocks.get(block.get('parent'));
    const list = parent && children.get(parent.get('children'));
    if (list instanceof Y.Array) {
      const index = list.toArray().indexOf(block.get('id'));
      if (index !== -1) list.delete(index, 1);
    }
  };

  for (const action of actions) {
    if (action.action === 'Delete') {
      const target = blocks.get(action.payload.block.id);
      if (!target) continue;
      removeFromParent(target);
      blocks.delete(target.get('id'));
      if (target.get('children')) children.delete(target.get('children'));
      if (target.get('external_type') === 'text' && target.get('external_id')) texts.delete(target.get('external_id'));
    } else if (action.action === 'Insert') {
      const { block, parent_id, prev_id } = action.payload;
      const map = new Y.Map();

      map.set('id', block.id);
      map.set('ty', block.ty);
      map.set('parent', block.parent);
      map.set('children', block.children);
      map.set('external_id', block.external_id);
      map.set('external_type', block.external_type);
      map.set('data', JSON.stringify(block.data ?? {}));
      blocks.set(block.id, map);
      if (!children.has(block.children)) children.set(block.children, new Y.Array());
      const parent = blocks.get(parent_id);
      const list = parent && children.get(parent.get('children'));

      if (!(list instanceof Y.Array)) throw new Error('Insert action references an unknown parent');
      const insertIndex = prev_id ? list.toArray().indexOf(prev_id) + 1 : 0;

      list.insert(insertIndex, [block.id]);
    } else if (action.action === 'InsertText') {
      const { text_id, delta } = action.payload;
      const text = texts.get(text_id) ?? new Y.Text();

      if (!texts.has(text_id)) texts.set(text_id, text);
      text.applyDelta(JSON.parse(delta));
    } else {
      throw new Error(`Unsupported first-body action: ${action.action}`);
    }
  }
}

export function createPageCollabFromFirstBodyContribution(documentId, contribution) {
  if (contribution.kind === 'default_schema') return createInitialPageCollab(documentId);
  const doc = new Y.Doc({ guid: documentId });
  const rootId = uuidV5('page', documentId);
  const data = doc.getMap('data');
  const document = new Y.Map();
  const blocks = new Y.Map();
  const metadata = new Y.Map();
  const children = new Y.Map();
  const texts = new Y.Map();
  const page = new Y.Map();
  const pageChildren = new Y.Array();

  page.set('id', rootId);
  page.set('ty', 'page');
  page.set('parent', '');
  page.set('children', rootId);
  page.set('external_id', null);
  page.set('external_type', null);
  page.set('data', '{}');
  blocks.set(rootId, page);
  children.set(rootId, pageChildren);
  document.set('page_id', rootId);
  document.set('blocks', blocks);
  document.set('meta', metadata);
  metadata.set('children_map', children);
  metadata.set('text_map', texts);
  data.set('document', document);

  try {
    applyFirstBodyActions(doc, contribution.actions);
  } catch (actionError) {
    doc.destroy();
    throw actionError;
  }

  const documentState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);

  doc.destroy();
  return { documentState, stateVector, collabVersion: 'appflowy-page-v1' };
}

export function createInitialPageCollab(documentId) {
  const doc = new Y.Doc({ guid: documentId });
  const rootId = uuidV5('page', documentId);
  const paragraphId = stableId(documentId, 'block');
  const paragraphChildrenId = stableId(documentId, 'children');
  const paragraphTextId = stableId(documentId, 'text');
  const data = doc.getMap('data');
  const document = new Y.Map();
  const blocks = new Y.Map();
  const metadata = new Y.Map();
  const children = new Y.Map();
  const texts = new Y.Map();
  const page = new Y.Map();
  const paragraph = new Y.Map();
  const pageChildren = new Y.Array();

  page.set('id', rootId);
  page.set('ty', 'page');
  page.set('parent', '');
  page.set('children', rootId);
  page.set('external_id', rootId);
  page.set('external_type', 'text');
  page.set('data', '');
  blocks.set(rootId, page);

  paragraph.set('id', paragraphId);
  paragraph.set('ty', 'paragraph');
  paragraph.set('parent', rootId);
  paragraph.set('children', paragraphChildrenId);
  paragraph.set('external_id', paragraphTextId);
  paragraph.set('external_type', 'text');
  paragraph.set('data', '{}');
  blocks.set(paragraphId, paragraph);

  pageChildren.push([paragraphId]);
  children.set(rootId, pageChildren);
  children.set(paragraphChildrenId, new Y.Array());
  texts.set(rootId, new Y.Text());
  texts.set(paragraphTextId, new Y.Text());
  document.set('page_id', rootId);
  document.set('blocks', blocks);
  document.set('meta', metadata);
  metadata.set('children_map', children);
  metadata.set('text_map', texts);
  data.set('document', document);

  const documentState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  return { documentState, stateVector, collabVersion: 'appflowy-page-v1' };
}
