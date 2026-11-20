import protobuf from 'protobufjs';

// This descriptor is a source-derived subset of AppFlowy-Web's
// src/proto/messages.proto, collab.proto and notification.proto. Task 79:
// added messages.Message's `notification` branch and just enough of
// notification.proto (WorkspaceNotification.folder_changed, FolderChanged)
// to push the "something in the Folder tree changed, re-fetch the outline"
// signal a page rename/icon/extra update (and anything else that mutates a
// page/view outside its own live-synced collab) needs -- the rest of
// WorkspaceNotification's oneof branches are still intentionally omitted.
const root = protobuf.Root.fromJSON({ nested: { messages: { nested: { Message: { oneofs: { payload: { oneof: ['collabMessage', 'notification'] } }, fields: { collabMessage: { type: 'collab.CollabMessage', id: 1 }, notification: { type: 'notification.WorkspaceNotification', id: 2 } } } } }, notification: { nested: {
  FolderChanged: { fields: { outlineDiffJson: { type: 'string', id: 1 }, folderRid: { type: 'string', id: 2, proto3Optional: true } } },
  InboxNotification: { fields: { id: { type: 'string', id: 1 }, type: { type: 'string', id: 2 }, viewId: { type: 'string', id: 3, proto3Optional: true }, actorUid: { type: 'int64', id: 4, proto3Optional: true }, metadataJson: { type: 'string', id: 5 }, createdAt: { type: 'int64', id: 6 } } },
  CommentChanged: { fields: { workspaceId: { type: 'string', id: 1 }, viewId: { type: 'string', id: 2 } } },
  WorkspaceNotification: { oneofs: { payload: { oneof: ['folderChanged', 'inboxNotification', 'commentChanged'] } }, fields: { folderChanged: { type: 'notification.FolderChanged', id: 8 }, inboxNotification: { type: 'notification.InboxNotification', id: 10 }, commentChanged: { type: 'notification.CommentChanged', id: 11 } } },
} }, collab: { nested: {
  Rid: { fields: { timestamp: { type: 'fixed64', id: 1 }, counter: { type: 'uint32', id: 2 } } },
  PayloadCompressionType: { values: { COMPRESSION_NONE: 0, COMPRESSION_ZSTD: 1, COMPRESSION_GZIP: 2 } },
  CollabDocStateParams: { fields: {
    objectId: { type: 'string', id: 1 },
    collabType: { type: 'int32', id: 2 },
    compression: { type: 'collab.PayloadCompressionType', id: 3 },
    sv: { type: 'bytes', id: 4 },
    docState: { type: 'bytes', id: 5 },
    collabVersion: { type: 'string', id: 6 },
    databaseRestoreId: { type: 'string', id: 7 },
  } },
  CollabBatchSyncRequest: { fields: {
    items: { rule: 'repeated', type: 'collab.CollabDocStateParams', id: 1 },
    responseCompression: { type: 'collab.PayloadCompressionType', id: 2 },
  } },
  CollabBatchSyncResult: { fields: {
    objectId: { type: 'string', id: 1 },
    collabType: { type: 'int32', id: 2 },
    compression: { type: 'collab.PayloadCompressionType', id: 3 },
    missingUpdate: { type: 'bytes', id: 4 },
    error: { type: 'string', id: 5 },
    serverStateVector: { type: 'bytes', id: 6 },
    collabVersion: { type: 'string', id: 7 },
    messageId: { type: 'collab.Rid', id: 8 },
  } },
  CollabBatchSyncResponse: { fields: {
    results: { rule: 'repeated', type: 'collab.CollabBatchSyncResult', id: 1 },
    responseCompression: { type: 'collab.PayloadCompressionType', id: 2 },
  } },
  SyncRequest: { fields: { lastMessageId: { type: 'collab.Rid', id: 1 }, stateVector: { type: 'bytes', id: 2 }, version: { type: 'string', id: 3 } } },
  Update: { fields: { messageId: { type: 'collab.Rid', id: 1 }, flags: { type: 'uint32', id: 2 }, payload: { type: 'bytes', id: 3 }, version: { type: 'string', id: 4 }, beforeStateVector: { type: 'bytes', id: 5 }, afterStateVector: { type: 'bytes', id: 6 }, databaseRestoreId: { type: 'string', id: 7 } } },
  AwarenessUpdate: { fields: { payload: { type: 'bytes', id: 1 } } },
  AccessChanged: { fields: { canRead: { type: 'bool', id: 1 }, canWrite: { type: 'bool', id: 2 }, reason: { type: 'int32', id: 3 } } },
  CollabMessage: { oneofs: { data: { oneof: ['syncRequest', 'update', 'awarenessUpdate', 'accessChanged'] } }, fields: { objectId: { type: 'string', id: 1 }, collabType: { type: 'int32', id: 2 }, syncRequest: { type: 'collab.SyncRequest', id: 3 }, update: { type: 'collab.Update', id: 4 }, awarenessUpdate: { type: 'collab.AwarenessUpdate', id: 5 }, accessChanged: { type: 'collab.AccessChanged', id: 6 } } }
} } } });

const Message = root.lookupType('messages.Message');
const CollabBatchSyncRequest = root.lookupType('collab.CollabBatchSyncRequest');
const CollabBatchSyncResponse = root.lookupType('collab.CollabBatchSyncResponse');
export function decodeMessage(bytes) { return Message.decode(bytes); }
export function encodeMessage(value) { return Message.encode(Message.fromObject(value)).finish(); }
export function decodeFullSyncBatch(bytes) { return CollabBatchSyncRequest.decode(bytes); }
export function decodeFullSyncBatchResponse(bytes) { return CollabBatchSyncResponse.decode(bytes); }
export function encodeFullSyncBatch(value) {
  return CollabBatchSyncResponse.encode(CollabBatchSyncResponse.fromObject(value)).finish();
}
export { Message, CollabBatchSyncRequest, CollabBatchSyncResponse };
