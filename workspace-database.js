import * as Y from 'yjs';

const DATA_SECTION = 'data';
const WORKSPACE_DATABASES = 'databases';

export function createDefaultWorkspaceDatabaseState(objectId) {
  const doc = new Y.Doc({ guid: objectId });
  doc.getMap(DATA_SECTION).set(WORKSPACE_DATABASES, new Y.Array());
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
