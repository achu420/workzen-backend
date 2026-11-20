# AppFlowy AI capabilities - discovery and plan to inherit them with your own API keys

Written for: you (owner of this self-hosted stack). Goal: paste an OpenRouter / OpenAI / Claude key, pick a model, and have AppFlowy's AI features use it.

## 1. Bottom line

- The AppFlowy web client already contains the whole AI user interface. It is switched off only because our server says `ai_enabled: false` and has none of the AI endpoints.
- AppFlowy's real AI backend is a **closed, separate service**; the public Cloud repo only forwards requests to it (and is archived; the commercial self-host terms forbid copying or modifying that code). So "inheriting" means **implementing the endpoints the client already calls**, using the client as the specification. No upstream server code is reused.
- Most features are thin proxies to an LLM. The pieces that need real server work are **chat persistence** and **retrieval over your pages**; our new keyword search can stand in for embeddings in a first version.
- There is **no AI settings screen** in the client (no keys, no provider). That is the one new piece of UI to add.

## 2. What AI exists in AppFlowy (client side)

| Feature | What the user sees | Server work | Needs retrieval/vectors? |
|---|---|---|---|
| **AI Chat** (page type "AI chat") | Streaming chat, history, regenerate, related questions, source chips, RAG scope picker, web-search toggle, prompt library, model picker | Chat settings + messages store, answer stream, related questions | Sources/"chat with pages" yes (can degrade) |
| **Editor AI writer** | Slash "Ask AI anything / Continue writing", selection toolbar: continue, improve, fix spelling, explain, make shorter/longer, ask AI; callout "Ask AI" | Stateless streaming proxy + prompt per action | No |
| **Math / code block AI**, **AI meeting summary** | Generate/explain/check code, equations, meeting summary regeneration | Same writer stream with a custom prompt | No |
| **Database AI fields** | "Summary" and "Translate" cell types (hidden when AI is off) | `summarize_row`, `translate_row` (non-streaming) | No |
| **Search AI summary** | Summary above Cmd+K results | `POST /search/{ws}/summary` (client ignores failures) | Yes (can use keyword search) |
| **AI meeting transcription** | Record/import audio, transcript, speakers | Audio storage + a transcription provider (AssemblyAI upstream) | No, but separate provider |
| Image/cover generation | **Not in the web client** | - | - |
| Local AI (Ollama) | Desktop app only (llama3.1 + nomic-embed-text); not in web | - | - |

Notes: the writer has **no** translate/summarize/tone action (those exist only as database cells). Message feedback and chat file/image attachments are not in the web client.

## 3. How upstream does it (what we are matching)

- Cloud stores chats in Postgres (`af_chat`, `af_chat_messages`), loads the question and `rag_ids`, then calls the closed AI service. Embeddings for retrieval live in `af_collab_embeddings` (pgvector, `text-embedding-3-small`), produced by an indexer.
- Model choice is a per-request **`ai-model` header** (`Auto` by default) plus a model list from `GET /api/ai/{ws}/model/list`; the closed service maps names to providers. Chat also remembers the model in its settings (`metadata.ai_model`).
- Streaming is **not SSE**: the body is a run of JSON objects, one per frame, keyed by a numeric type: `"0"` sources metadata, `"1"` text delta, `"2"` image, `"3"` keep-alive, `"4"` comment (writer), `"5"` progress, `"6"` reasoning (ignored). End of stream = connection closes. Errors: non-2xx with `{code,message}`, or a frame with non-zero `code`/string `error` mid-stream.

## 4. Exact client contract we must serve

Envelope `{code:0, data, message}`; auth Bearer token.

- `GET /api/server-info` -> `ai_enabled` (omitted = ON; we currently send false). `self_hosted: true` hides billing/limit UI.
- `GET /api/ai/{ws}/model/list` -> `{models:[{name, provider?, metadata:{is_default, desc}}]}`; on failure the picker shows only `Auto`.
- **Writer** `POST /api/ai/{ws}/v2/complete/stream`, header `ai-model`; body `{text, completion_type 1..8, format, metadata{object_id, workspace_id, rag_ids, completion_history[{role,content}], custom_prompt?{system}}}`; types: 1 improve, 2 spelling, 3 shorter, 4 longer, 5 continue, 6 explain, 7 ask anything, 8 custom prompt. Reply frames `"1"` text / `"4"` comment.
- **Chat**: `GET|POST /api/chat/{ws}/{chat}/settings` (`name, rag_ids, metadata, full_workspace, web_search_enabled`); `GET .../message?limit&before&after`; `POST .../message/question` (returns saved message); `POST .../answer/stream` (`question_id, model_name?`, header `ai-model`); `POST .../message/answer` (client saves the final answer after streaming); `GET .../{qid}/related_question` -> `{message_id, items:[{content}]}`. Message = `{message_id:int, author:{author_type 1 human/2 system/3 AI, author_uuid}, content, created_at, reply_message_id, meta_data[]}`. The chat page itself is a normal page of layout 4 created through the page API (already works).
- `POST /api/ai/{ws}/summarize_row` `{workspace_id, data:{Content:{field:text}}}` -> `{text}`; `POST /api/ai/{ws}/translate_row` `{workspace_id, data:{cells[{title,content}], language, include_header?}}` -> `{items:[{content}]}`.
- `POST /api/search/{ws}/summary` `{query, only_context}` -> `{summaries:[{content, highlights?, sources:[viewIds]}]}`.
- Optional: `GET /api/meeting/summary_templates` (client has a fallback); usage: `GET /api/workspace/{id}/usage-and-limit` only if not `self_hosted`.

## 5. Proposed design: your keys, your model

**Settings (new, per workspace, owner/admin only).** A new "AI" panel in Settings (`components/app/settings/`, next to Plan/Billing): provider (OpenRouter / OpenAI / Anthropic), API key (write-only), "Test key", model dropdown filled from the provider's own model list, default model, optional per-feature override later. Server endpoints: `GET/PUT/DELETE /api/workspace/{id}/ai-settings` (returns `{provider, hint:"...abcd", model, hasKey}`, never the key), `POST .../ai-settings/test`, `GET .../ai-settings/models`.

**Provider layer (one module, no SDKs).** `streamChat({provider, apiKey, model, messages, system, maxTokens, signal})` yields text deltas:
- OpenRouter: `https://openrouter.ai/api/v1/chat/completions`, Bearer key, SSE `data:` JSON deltas, `[DONE]`, skip `:` keep-alive lines; `max_tokens`; send attribution headers; key check `GET /api/v1/key`, models `GET /api/v1/models` (has vision modality, pricing, context length).
- OpenAI: `https://api.openai.com/v1/chat/completions`, Bearer key, same SSE shape, `max_completion_tokens`; models `GET /v1/models` (filter out embedding/whisper/tts/image).
- Anthropic: `https://api.anthropic.com/v1/messages`, `x-api-key` + `anthropic-version`, `max_tokens` required, top-level `system`, SSE events `content_block_delta/text_delta`, `message_stop`, mid-stream `event: error`; models `GET /v1/models` (has image-input flag).
- A small adapter re-emits every provider's text as the client's `{"1": delta}` frames and maps errors (401 key invalid, 402 credits, 429 rate limit, context overflow, provider down) to readable messages, delivered as the client's error frame.

**Model list/selection semantics.** `Auto` = the workspace default model; the list endpoint returns `Auto` + the models the owner enabled, one flagged `is_default`. Chat keeps its per-chat model (client already stores it in chat settings); the editor remembers its own choice (client localStorage). Row summarize/translate and search summary have no model parameter, so they use the workspace default.

**Key security.** AES-256-GCM at rest with a server secret from env, workspace id as AAD; never returned or logged; owner/admin-only; per-user/workspace rate limits, body-size and timeout caps; hard-coded provider hosts (no custom base URL, to avoid server-side request forgery; revisit if you want Ollama/Azure).

**Gating.** Report `ai_enabled: true` and `self_hosted: true`. When no key is configured, every AI call returns a clear "Add an API key in Settings > AI" error so nothing looks broken.

**Prompts.** Server-side system prompts for writer types 1-7 (and custom prompt passthrough for 8), plus row summarize/translate and related questions; drafts already prepared (provider-neutral, "output only the result").

**Retrieval for chat/search summary without embeddings (phase 2).** Use the new keyword search: extract keywords (or ask the model for 3-5 queries), take the top 5-8 readable pages within `rag_ids`/`full_workspace`, truncate, put them in the prompt with ids, return the ids as the `"0"` sources frame. Works for lookups sharing vocabulary; weaker for paraphrase. Embeddings (OpenAI/OpenRouter embedding endpoints, pgvector) are a later upgrade; Anthropic has no embedding API.

## 6. Phases

1. **Foundation + writer + model list** (smallest useful slice): storage (encrypted settings), provider layer, `ai-settings` routes + Settings > AI panel, `server-info`, model list, writer stream, row summarize/translate. Unlocks editor AI, math/code AI, meeting summary, database AI fields.
2. **Chat**: chat/message tables (JSON + Postgres), settings/question/answer/related-question routes, streaming answer with history context.
3. **Retrieval**: keyword-search RAG for chat sources and `search/summary`.
4. **Later/optional**: embeddings, web-search toggle (needs a search provider), meeting transcription (needs audio storage + transcription provider), usage metering, local/custom base URL.

Rough size: phase 1 about the size of the comments work, phase 2 a bit larger, phase 3 small once search exists.

## 7. Risks and open points

- Upstream's closed service decides how names like `Auto`/`Default` are routed and what suggested-question/follow-up frames look like; we define our own behaviour (client tolerates it).
- Chat answers are saved by the client after streaming via `POST .../message/answer`, so we need not persist during the stream, but should truncate history to fit the model's context.
- Official AppFlowy AI feature docs and OpenAI docs could not be fetched during research (OpenAI shapes are from prior knowledge; Anthropic's current `anthropic-version` value should be confirmed at build time).
- Cost control: add per-workspace daily token/request caps early; keys belong to the owner and spend is theirs.
- Licence: reuse nothing from the archived Cloud/commercial server code; we implement the public client contract only.
