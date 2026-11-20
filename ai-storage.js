// Persistence for per-workspace AI settings (provider, encrypted key, models) and AI chats.
// JSON mode keeps three lazily-created maps in the state file (older state files need no
// migration); Postgres mode uses migration 017. Both expose the same async methods.

const nowIso = () => new Date().toISOString();
const clone = (value) => (value === undefined || value === null ? null : structuredClone(value));

const CHAT_DEFAULTS = { name: '', rag_ids: [], metadata: {}, full_workspace: false, web_search_enabled: false };

function mergeChatPatch(previous, patch) {
  const next = { ...CHAT_DEFAULTS, ...previous };

  if (typeof patch.name === 'string') next.name = patch.name;
  if (Array.isArray(patch.rag_ids)) next.rag_ids = patch.rag_ids;
  if (patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)) next.metadata = { ...(previous?.metadata ?? {}), ...patch.metadata };
  if (typeof patch.full_workspace === 'boolean') next.full_workspace = patch.full_workspace;
  if (typeof patch.web_search_enabled === 'boolean') next.web_search_enabled = patch.web_search_enabled;
  return next;
}

function clampLimit(limit) {
  const value = Number(limit);

  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 20;
}

// Removes card chats whose metadata[key] equals value; returns how many were removed.
function removeCardChats(state, workspaceId, key, value) {
  let removed = 0;

  for (const [chatId, chat] of Object.entries(state.aiChats ?? {})) {
    if (chat.workspace_id !== workspaceId || chat.metadata?.scope !== 'card' || chat.metadata?.[key] !== value) continue;
    delete state.aiChats[chatId];
    if (state.aiChatMessages) delete state.aiChatMessages[chatId];
    removed += 1;
  }
  return removed;
}

const messageView = (m) => ({
  message_id: m.message_id,
  author: { author_type: m.author_type, author_uuid: m.author_uuid },
  content: m.content,
  created_at: m.created_at,
  ...(m.reply_message_id ? { reply_message_id: m.reply_message_id } : {}),
  meta_data: m.meta_data ?? [],
});

export function createAiJsonStorage(store, mutate) {
  const chatMessages = (chatId) => store.state.aiChatMessages?.[chatId] ?? [];

  return {
    getAiSettings: async (workspaceId) => clone(store.state.aiSettings?.[workspaceId]),
    saveAiSettings: async (workspaceId, { provider, keyEnc, model, enabledModels, updatedBy }) => mutate(store, (s) => {
      s.aiSettings ??= {};
      const previous = s.aiSettings[workspaceId];

      s.aiSettings[workspaceId] = {
        workspace_id: workspaceId,
        provider,
        key_enc: keyEnc !== undefined ? keyEnc : previous?.key_enc ?? null,
        model: model ?? null,
        enabled_models: enabledModels ?? [],
        updated_at: nowIso(),
        updated_by: updatedBy ?? null,
      };
      return clone(s.aiSettings[workspaceId]);
    }),
    deleteAiSettings: async (workspaceId) => mutate(store, (s) => { if (s.aiSettings) delete s.aiSettings[workspaceId]; }),

    getAiChat: async (chatId) => clone(store.state.aiChats?.[chatId]),
    // Returns {chat} or {conflict: true} when the id already belongs to another workspace.
    upsertAiChat: async (workspaceId, chatId, patch, userId) => mutate(store, (s) => {
      s.aiChats ??= {};
      const previous = s.aiChats[chatId];

      if (previous && previous.workspace_id !== workspaceId) return { conflict: true };
      const timestamp = nowIso();

      s.aiChats[chatId] = {
        ...mergeChatPatch(previous, patch),
        chat_id: chatId,
        workspace_id: workspaceId,
        created_by: previous?.created_by ?? userId ?? null,
        created_at: previous?.created_at ?? timestamp,
        updated_at: timestamp,
      };
      return { chat: clone(s.aiChats[chatId]) };
    }),
    deleteAiChat: async (chatId) => mutate(store, (s) => {
      if (s.aiChats) delete s.aiChats[chatId];
      if (s.aiChatMessages) delete s.aiChatMessages[chatId];
    }),
    // Card chats (metadata.scope === 'card') belonging to one row / one whole database.
    deleteAiChatsByRow: async (workspaceId, rowId) => mutate(store, (s) => removeCardChats(s, workspaceId, 'row_id', rowId)),
    deleteAiChatsByDatabase: async (workspaceId, databaseId) => mutate(store, (s) => removeCardChats(s, workspaceId, 'database_id', databaseId)),

    // Newest first, like the upstream API. `before`/`after` are message ids.
    listAiChatMessages: async (chatId, { limit, offset, before, after } = {}) => {
      const all = [...chatMessages(chatId)].sort((a, b) => b.message_id - a.message_id);
      const size = clampLimit(limit);
      let page;
      let hasMore;

      if (Number.isInteger(after)) {
        const newer = all.filter((m) => m.message_id > after).reverse();

        page = newer.slice(0, size).reverse();
        hasMore = newer.length > size;
      } else {
        const older = Number.isInteger(before) ? all.filter((m) => m.message_id < before) : all.slice(Number.isInteger(offset) && offset > 0 ? offset : 0);

        page = older.slice(0, size);
        hasMore = older.length > size;
      }
      return { messages: page.map(messageView), has_more: hasMore, total: all.length };
    },
    getAiChatMessage: async (chatId, messageId) => {
      const found = chatMessages(chatId).find((m) => m.message_id === messageId);

      return found ? messageView(found) : null;
    },
    // Allocates the question id and reserves the id of its future answer (reply_message_id).
    addAiChatQuestion: async (chatId, { authorUuid, content, metaData }) => mutate(store, (s) => {
      s.aiChatMessages ??= {};
      s.aiMessageSeq = (s.aiMessageSeq ?? 0) + 1;
      const messageId = s.aiMessageSeq;

      s.aiMessageSeq += 1;
      const message = {
        message_id: messageId,
        chat_id: chatId,
        author_type: 1,
        author_uuid: authorUuid ?? '',
        content,
        reply_message_id: s.aiMessageSeq,
        meta_data: metaData ?? [],
        created_at: nowIso(),
      };

      (s.aiChatMessages[chatId] ??= []).push(message);
      return messageView(message);
    }),
    saveAiChatAnswer: async (chatId, questionId, { content, metaData }) => mutate(store, (s) => {
      const list = s.aiChatMessages?.[chatId];
      const question = list?.find((m) => m.message_id === questionId && m.author_type === 1);

      if (!question) return null;
      const answerId = question.reply_message_id;
      const answer = {
        message_id: answerId,
        chat_id: chatId,
        author_type: 3,
        author_uuid: 'appflowy-ai',
        content,
        reply_message_id: questionId,
        meta_data: metaData ?? [],
        created_at: nowIso(),
      };
      const index = list.findIndex((m) => m.message_id === answerId);

      if (index >= 0) list[index] = answer;
      else list.push(answer);
      list.sort((a, b) => a.message_id - b.message_id);
      return messageView(answer);
    }),
  };
}

export function createAiPostgresStorage(pool) {
  const withClient = async (fn) => {
    const client = await pool.connect();

    try { return await fn(client); } finally { client.release(); }
  };
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  const settingsRow = (r) => ({
    workspace_id: r.workspace_id, provider: r.provider, key_enc: r.key_enc ?? null, model: r.model ?? null,
    enabled_models: r.enabled_models ?? [], updated_at: iso(r.updated_at), updated_by: r.updated_by ?? null,
  });
  const chatRow = (r) => ({
    chat_id: r.chat_id, workspace_id: r.workspace_id, name: r.name, rag_ids: r.rag_ids ?? [], metadata: r.metadata ?? {},
    full_workspace: !!r.full_workspace, web_search_enabled: !!r.web_search_enabled, created_by: r.created_by ?? null,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
  const messageRow = (r) => messageView({
    message_id: Number(r.message_id), author_type: r.author_type, author_uuid: r.author_uuid, content: r.content,
    reply_message_id: r.reply_message_id === null ? null : Number(r.reply_message_id), meta_data: r.meta_data, created_at: iso(r.created_at),
  });

  return {
    getAiSettings: (workspaceId) => withClient(async (c) => {
      const r = await c.query('SELECT * FROM ai_settings WHERE workspace_id=$1', [workspaceId]);

      return r.rows[0] ? settingsRow(r.rows[0]) : null;
    }),
    saveAiSettings: (workspaceId, { provider, keyEnc, model, enabledModels, updatedBy }) => withClient(async (c) => {
      const r = await c.query(
        `INSERT INTO ai_settings(workspace_id,provider,key_enc,model,enabled_models,updated_at,updated_by)
         VALUES($1,$2,$3::jsonb,$4,$5::jsonb,now(),$6)
         ON CONFLICT (workspace_id) DO UPDATE SET provider=EXCLUDED.provider,
           key_enc=CASE WHEN $7::boolean THEN EXCLUDED.key_enc ELSE ai_settings.key_enc END,
           model=EXCLUDED.model, enabled_models=EXCLUDED.enabled_models, updated_at=now(), updated_by=EXCLUDED.updated_by
         RETURNING *`,
        [workspaceId, provider, keyEnc === undefined || keyEnc === null ? null : JSON.stringify(keyEnc), model ?? null, JSON.stringify(enabledModels ?? []), updatedBy ?? null, keyEnc !== undefined]
      );

      return settingsRow(r.rows[0]);
    }),
    deleteAiSettings: (workspaceId) => withClient((c) => c.query('DELETE FROM ai_settings WHERE workspace_id=$1', [workspaceId])),

    getAiChat: (chatId) => withClient(async (c) => {
      const r = await c.query('SELECT * FROM ai_chats WHERE chat_id=$1', [chatId]);

      return r.rows[0] ? chatRow(r.rows[0]) : null;
    }),
    upsertAiChat: (workspaceId, chatId, patch, userId) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const existing = await c.query('SELECT * FROM ai_chats WHERE chat_id=$1 FOR UPDATE', [chatId]);
        const previous = existing.rows[0] ? chatRow(existing.rows[0]) : null;

        if (previous && previous.workspace_id !== workspaceId) {
          await c.query('ROLLBACK');
          return { conflict: true };
        }
        const next = mergeChatPatch(previous, patch);
        const r = await c.query(
          `INSERT INTO ai_chats(chat_id,workspace_id,name,rag_ids,metadata,full_workspace,web_search_enabled,created_by,created_at,updated_at)
           VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,now(),now())
           ON CONFLICT (chat_id) DO UPDATE SET name=EXCLUDED.name,rag_ids=EXCLUDED.rag_ids,metadata=EXCLUDED.metadata,
             full_workspace=EXCLUDED.full_workspace,web_search_enabled=EXCLUDED.web_search_enabled,updated_at=now()
           RETURNING *`,
          [chatId, workspaceId, next.name, JSON.stringify(next.rag_ids), JSON.stringify(next.metadata), next.full_workspace, next.web_search_enabled, userId ?? null]
        );

        await c.query('COMMIT');
        return { chat: chatRow(r.rows[0]) };
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      }
    }),
    deleteAiChat: (chatId) => withClient((c) => c.query('DELETE FROM ai_chats WHERE chat_id=$1', [chatId])),
    // Messages go with the chat (ON DELETE CASCADE).
    deleteAiChatsByRow: (workspaceId, rowId) => withClient(async (c) => (await c.query(
      "DELETE FROM ai_chats WHERE workspace_id=$1 AND metadata->>'scope'='card' AND metadata->>'row_id'=$2", [workspaceId, rowId]
    )).rowCount),
    deleteAiChatsByDatabase: (workspaceId, databaseId) => withClient(async (c) => (await c.query(
      "DELETE FROM ai_chats WHERE workspace_id=$1 AND metadata->>'scope'='card' AND metadata->>'database_id'=$2", [workspaceId, databaseId]
    )).rowCount),

    listAiChatMessages: (chatId, { limit, offset, before, after } = {}) => withClient(async (c) => {
      const size = clampLimit(limit);
      const total = Number((await c.query('SELECT count(*) AS n FROM ai_chat_messages WHERE chat_id=$1', [chatId])).rows[0].n);
      let rows;
      let hasMore;

      if (Number.isInteger(after)) {
        const r = await c.query('SELECT * FROM ai_chat_messages WHERE chat_id=$1 AND message_id>$2 ORDER BY message_id ASC LIMIT $3', [chatId, after, size + 1]);

        hasMore = r.rows.length > size;
        rows = r.rows.slice(0, size).reverse();
      } else {
        const r = Number.isInteger(before)
          ? await c.query('SELECT * FROM ai_chat_messages WHERE chat_id=$1 AND message_id<$2 ORDER BY message_id DESC LIMIT $3', [chatId, before, size + 1])
          : await c.query('SELECT * FROM ai_chat_messages WHERE chat_id=$1 ORDER BY message_id DESC OFFSET $2 LIMIT $3', [chatId, Number.isInteger(offset) && offset > 0 ? offset : 0, size + 1]);

        hasMore = r.rows.length > size;
        rows = r.rows.slice(0, size);
      }
      return { messages: rows.map(messageRow), has_more: hasMore, total };
    }),
    getAiChatMessage: (chatId, messageId) => withClient(async (c) => {
      const r = await c.query('SELECT * FROM ai_chat_messages WHERE chat_id=$1 AND message_id=$2', [chatId, messageId]);

      return r.rows[0] ? messageRow(r.rows[0]) : null;
    }),
    addAiChatQuestion: (chatId, { authorUuid, content, metaData }) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const ids = await c.query("SELECT nextval('ai_chat_message_id_seq') AS question_id, nextval('ai_chat_message_id_seq') AS answer_id");
        const r = await c.query(
          `INSERT INTO ai_chat_messages(message_id,chat_id,author_type,author_uuid,content,reply_message_id,meta_data,created_at)
           VALUES($1,$2,1,$3,$4,$5,$6::jsonb,now()) RETURNING *`,
          [ids.rows[0].question_id, chatId, authorUuid ?? '', content, ids.rows[0].answer_id, JSON.stringify(metaData ?? [])]
        );

        await c.query('COMMIT');
        return messageRow(r.rows[0]);
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      }
    }),
    saveAiChatAnswer: (chatId, questionId, { content, metaData }) => withClient(async (c) => {
      const question = await c.query('SELECT reply_message_id FROM ai_chat_messages WHERE chat_id=$1 AND message_id=$2 AND author_type=1', [chatId, questionId]);

      if (!question.rows[0]) return null;
      const r = await c.query(
        `INSERT INTO ai_chat_messages(message_id,chat_id,author_type,author_uuid,content,reply_message_id,meta_data,created_at)
         VALUES($1,$2,3,'appflowy-ai',$3,$4,$5::jsonb,now())
         ON CONFLICT (message_id) DO UPDATE SET content=EXCLUDED.content, meta_data=EXCLUDED.meta_data
         WHERE ai_chat_messages.chat_id=EXCLUDED.chat_id RETURNING *`,
        [question.rows[0].reply_message_id, chatId, content, questionId, JSON.stringify(metaData ?? [])]
      );

      return r.rows[0] ? messageRow(r.rows[0]) : null;
    }),
  };
}
