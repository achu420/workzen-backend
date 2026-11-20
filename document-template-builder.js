import * as Y from 'yjs';
import { pageIdFromDocumentId } from './page-document.js';

// Builds a Document collab from plain-JSON `{page_id, blocks, meta}` (the shape
// of an AppFlowy export / our document template library). The export's root
// page block id is replaced by pageIdFromDocumentId(documentId) so the root
// follows this backend's convention.
//
// `pageIdMap` (old page id -> new page id) remaps in-template page mentions;
// a mention whose target is not in the map is dropped (the template generator
// already turns out-of-template mentions into plain text).
//
// Text is built with Y.Text#insert: Y.Text#applyDelta in the installed yjs
// version rejects plain Quill-style op arrays.
export function buildDocumentCollabFromTemplate({ documentId, document: exportDoc, pageIdMap }) {
  const doc = new Y.Doc({ guid: documentId });
  const newRootId = pageIdFromDocumentId(documentId);
  const oldRootId = exportDoc.page_id;
  const remapId = (value) => (value === oldRootId ? newRootId : value);

  const data = doc.getMap('data');
  const document = new Y.Map();
  data.set('document', document);
  const blocks = new Y.Map();
  const metadata = new Y.Map();
  const childrenMap = new Y.Map();
  const textMap = new Y.Map();
  document.set('page_id', newRootId);
  document.set('blocks', blocks);
  document.set('meta', metadata);
  metadata.set('children_map', childrenMap);
  metadata.set('text_map', textMap);

  for (const [blockId, block] of Object.entries(exportDoc.blocks || {})) {
    const map = new Y.Map();
    const newId = remapId(blockId);
    map.set('id', newId);
    map.set('ty', block.ty);
    map.set('parent', remapId(block.parent ?? ''));
    map.set('children', block.children);
    map.set('external_id', block.external_id ?? null);
    map.set('external_type', block.external_type ?? null);
    map.set('data', JSON.stringify(block.data ?? {}));
    blocks.set(newId, map);
  }
  for (const [childrenId, arr] of Object.entries(exportDoc.meta?.children_map || {})) {
    const yarr = new Y.Array();
    yarr.push((arr || []).map(remapId));
    childrenMap.set(childrenId, yarr);
  }
  for (const [textId, deltaJson] of Object.entries(exportDoc.meta?.text_map || {})) {
    const text = new Y.Text();
    textMap.set(textId, text);
    let delta;
    try { delta = JSON.parse(deltaJson); } catch { delta = []; }
    if (!Array.isArray(delta)) continue;
    let offset = 0;
    for (const op of delta) {
      if (typeof op.insert !== 'string' || !op.insert.length) continue;
      let attributes = op.attributes || {};
      const mention = attributes.mention;
      if (mention?.type === 'page') {
        const target = pageIdMap?.get(mention.page_id);
        if (!target) continue;
        attributes = { ...attributes, mention: { ...mention, page_id: target } };
      }
      text.insert(offset, op.insert, attributes);
      offset += op.insert.length;
    }
  }

  const documentState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  return { documentState, stateVector, collabVersion: 'appflowy-page-v1' };
}
