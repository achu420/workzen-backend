// Provider-neutral system prompts. User text always goes in the user turn, never in
// the system prompt, so selected document text cannot rewrite the instructions.

const OUTPUT_ONLY = 'Output only the result, with no preamble, no quotes and no explanations.';

export const COMPLETION_TYPES = {
  IMPROVE_WRITING: 1,
  FIX_SPELLING: 2,
  MAKE_SHORTER: 3,
  MAKE_LONGER: 4,
  CONTINUE_WRITING: 5,
  EXPLAIN: 6,
  ASK_AI: 7,
  CUSTOM_PROMPT: 8,
};

const WRITER_SYSTEM = {
  1: `You are a writing assistant. Improve the clarity, flow and word choice of the text. Keep the meaning, the language and the formatting (markdown). ${OUTPUT_ONLY}`,
  2: `You are a proofreader. Fix spelling, grammar and punctuation only. Do not change the wording, style or meaning. Keep the language and formatting. ${OUTPUT_ONLY}`,
  3: `You are a writing assistant. Rewrite the text to about half its length, keeping the key points, the language and the formatting. ${OUTPUT_ONLY}`,
  4: `You are a writing assistant. Expand the text with relevant detail to about twice its length without inventing facts. Keep the language and formatting. ${OUTPUT_ONLY}`,
  5: `You are a writing assistant. Continue the text naturally in the same language, tone and format. Write one to three paragraphs and do not repeat the given text. ${OUTPUT_ONLY}`,
  6: 'You are a helpful assistant. Explain the text simply for a general reader, in the same language as the text.',
  7: 'You are a helpful assistant inside a note-taking and documentation workspace. Answer the request directly and concisely, using markdown when it helps.',
  8: 'You are a helpful assistant inside a note-taking and documentation workspace.',
};

export function isCompletionType(value) {
  return Number.isInteger(value) && value >= 1 && value <= 8;
}

// completion_history is [{role: 'ai'|'human', content}] of earlier turns of the same
// editing session; the current request is the final user turn.
export function buildWriterPrompt({ type, text, history = [], customSystem }) {
  const system = type === COMPLETION_TYPES.CUSTOM_PROMPT && customSystem ? customSystem : WRITER_SYSTEM[type];
  const messages = [];

  for (const turn of history.slice(-20)) {
    if (!turn || typeof turn.content !== 'string' || !turn.content) continue;
    messages.push({ role: turn.role === 'ai' ? 'assistant' : 'user', content: turn.content });
  }
  messages.push({ role: 'user', content: text });
  return { system, messages };
}

export const CHAT_SYSTEM = 'You are the AI assistant of a note-taking and documentation workspace. Answer helpfully and concisely in the language of the question, using markdown when it helps. If you do not know something, say so instead of guessing.';

export const SUMMARIZE_ROW_SYSTEM = 'You are given a database row as JSON of field names and values. Summarize it in one or two sentences using only the given data. Output only the summary.';

export function translateRowPrompt({ language, includeHeader }) {
  return `You translate database cell values into ${language}. You receive a JSON array of strings${includeHeader ? ' (each is a field name and its value)' : ''}. Return a JSON array of the same length containing only the translated strings, in the same order, keeping numbers, URLs and proper nouns. Output only the JSON array.`;
}

export const RELATED_QUESTIONS_SYSTEM = 'Given a conversation, suggest three short follow-up questions the user might ask next, in the language of the conversation. Output only a JSON array of three strings.';

// Tolerant extraction of a JSON array of strings from a model reply.
export function parseJsonStringArray(text) {
  const match = String(text ?? '').match(/\[[\s\S]*\]/);

  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);

    return Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item))) : null;
  } catch {
    return null;
  }
}
