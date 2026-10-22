/**
 * Firebase JS SDK (modular) implementation of HubStore, signed in as the paired device
 * (custom token uid `device:<deviceId>`). Realtime listeners re-subscribe with backoff; auth
 * failures trigger a (single-flight, rate-limited) token re-exchange.
 */
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, type Auth } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  terminate,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { PATHS } from './contract.js';
import { exchangeToken, isAuthError, logAuthError, singleFlight } from './hubAuth.js';
import { errMsg, logger } from './log.js';
import { HttpError, type DeviceRecord, type FetchFn } from './pairing.js';
import type { ClaimDecision, HubStore, Unsubscribe } from './store.js';
import { backoffMs, retryForever, sleep } from './util.js';

const log = logger('hub');
const MIN_REAUTH_GAP_MS = 30_000;

export class HubSession {
  private app: FirebaseApp | null = null;
  private authInst: Auth | null = null;
  private dbInst: Firestore | null = null;
  private lastSignIn = 0;

  constructor(
    private readonly hubUrl: string,
    private readonly device: DeviceRecord,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get db(): Firestore {
    if (!this.dbInst) throw new Error('Hub session not connected');
    return this.dbInst;
  }

  private async signInOnce(): Promise<void> {
    const tok = await exchangeToken(this.hubUrl, this.device, this.fetchFn);
    if (!this.app) {
      this.app = initializeApp(tok.firebaseConfig, 'home-hub-addon');
      this.authInst = getAuth(this.app);
      this.dbInst = initializeFirestore(this.app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
    }
    await signInWithCustomToken(this.authInst as Auth, tok.customToken);
    this.lastSignIn = Date.now();
  }

  /** Sign in, retrying forever with backoff (never fatal: the Hub or network may be down). */
  async connect(): Promise<void> {
    await retryForever(() => this.signInOnce(), {
      capMs: 10 * 60 * 1000,
      onError: (e, attempt, wait) => {
        const hint =
          e instanceof HttpError && (e.status === 401 || e.status === 403)
            ? ' The Hub rejected this device; if it was unpaired, set a new pairing_code and restart.'
            : '';
        log.warn(`Hub sign-in failed; retrying in ${Math.round(wait / 1000)}s.${hint}`, { attempt, error: errMsg(e) });
      },
    });
    log.info('Signed in to Home Hub');
  }

  /** Re-exchange the token after an auth failure. Shared by concurrent callers; at most every 30 s. */
  readonly reauth = singleFlight(async () => {
    const gap = Date.now() - this.lastSignIn;
    if (gap < MIN_REAUTH_GAP_MS) await sleep(MIN_REAUTH_GAP_MS - gap);
    await this.connect();
  });

  async close(): Promise<void> {
    if (this.dbInst) await terminate(this.dbInst).catch(() => {});
    if (this.app) await deleteApp(this.app).catch(() => {});
  }
}

export class FirestoreHubStore implements HubStore {
  constructor(private readonly session: HubSession) {}

  private async withAuthRetry<T>(what: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (!isAuthError(e)) throw e;
      logAuthError(what, e);
      await this.session.reauth();
      return op();
    }
  }

  set(path: string, data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    return this.withAuthRetry(`set ${path}`, () => setDoc(doc(this.session.db, path), data, { merge: opts?.merge ?? false }));
  }

  update(path: string, fields: Record<string, unknown>): Promise<void> {
    return this.withAuthRetry(`update ${path}`, () => updateDoc(doc(this.session.db, path), fields));
  }

  remove(path: string): Promise<void> {
    return this.withAuthRetry(`delete ${path}`, () => deleteDoc(doc(this.session.db, path)));
  }

  async add(collectionPath: string, data: Record<string, unknown>): Promise<string> {
    const ref = await this.withAuthRetry(`add ${collectionPath}`, () => addDoc(collection(this.session.db, collectionPath), data));
    return ref.id;
  }

  private resilient(label: string, subscribe: (onOk: () => void, onErr: (e: unknown) => void) => () => void): Unsubscribe {
    let stopped = false;
    let unsub: (() => void) | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const start = () => {
      if (stopped) return;
      unsub = subscribe(
        () => {
          attempt = 0;
        },
        (e) => {
          unsub = null;
          logAuthError(`listener ${label}`, e);
          const again = () => {
            const wait = backoffMs(attempt++, 1000, 5 * 60 * 1000);
            timer = setTimeout(start, wait);
          };
          if (isAuthError(e)) this.session.reauth().then(again, again);
          else again();
        },
      );
    };
    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsub?.();
    };
  }

  watchDoc(path: string, onData: (data: Record<string, unknown> | null) => void): Unsubscribe {
    return this.resilient(path, (ok, err) =>
      onSnapshot(
        doc(this.session.db, path),
        (snap) => {
          ok();
          onData(snap.exists() ? (snap.data() as Record<string, unknown>) : null);
        },
        err,
      ),
    );
  }

  watchApprovedCommands(onIds: (ids: string[]) => void): Unsubscribe {
    return this.resilient(PATHS.homeCommands, (ok, err) =>
      onSnapshot(
        query(collection(this.session.db, PATHS.homeCommands), where('status', '==', 'approved')),
        (snap) => {
          ok();
          onIds(snap.docs.map((d) => d.id));
        },
        err,
      ),
    );
  }

  claim(id: string, decide: (raw: Record<string, unknown> | null) => ClaimDecision): Promise<ClaimDecision> {
    return this.withAuthRetry(`claim ${id}`, () =>
      runTransaction(this.session.db, async (tx) => {
        const ref = doc(this.session.db, PATHS.homeCommand(id));
        const snap = await tx.get(ref);
        const decision = decide(snap.exists() ? (snap.data() as Record<string, unknown>) : null);
        if (decision.action !== 'skip') tx.update(ref, decision.fields);
        return decision;
      }),
    );
  }
}
