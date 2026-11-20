// Who is making a change right now, carried through async calls without threading it through every function. The web
// socket handlers pass their user explicitly; agent tool calls and "undo" / "restore" requests run inside runAsActor so
// that anything that records history (card history, ...) can credit the right person - and, for an agent, the agent.
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** @param {{userId: string, via?: string|null}} actor */
export const runAsActor = (actor, fn) => storage.run({ userId: actor.userId, via: actor.via ?? null }, fn);

/** @returns {{userId: string, via: string|null} | undefined} */
export const currentActor = () => storage.getStore();
