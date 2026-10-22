/** Storage abstraction over Firestore so logic can be unit-tested with an in-memory fake. */

export type Unsubscribe = () => void;

export type ClaimDecision =
  /** Not ours to touch (already claimed, missing, not approved). */
  | { action: 'skip' }
  /** approved -> claimed */
  | { action: 'claim'; fields: Record<string, unknown> }
  /** approved -> rejected / expired (never executed) */
  | { action: 'close'; fields: Record<string, unknown> };

export interface HubStore {
  set(path: string, data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
  update(path: string, fields: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  /** Add a doc with an auto id to a collection; returns the id. */
  add(collectionPath: string, data: Record<string, unknown>): Promise<string>;
  /** Live doc listener (null when missing). Re-subscribes itself on errors. */
  watchDoc(path: string, onData: (data: Record<string, unknown> | null) => void): Unsubscribe;
  /** Live list of homeCommands ids with status == 'approved'. Re-subscribes itself on errors. */
  watchApprovedCommands(onIds: (ids: string[]) => void): Unsubscribe;
  /** Transaction: read the command, let `decide` choose, write the decision atomically. */
  claim(id: string, decide: (raw: Record<string, unknown> | null) => ClaimDecision): Promise<ClaimDecision>;
}
