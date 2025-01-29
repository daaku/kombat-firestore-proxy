import { Auth as FirebaseAuth, User } from '@daaku/firebase-auth'
import {
  FirebaseAPI,
  FirebaseConfig,
  makeFirebaseAPI,
} from '@daaku/firebase-rest-api'
import { RemoteFirestore } from '@daaku/kombat-firestore'
import { ChangeListener } from '@daaku/kombat-indexed-db'
import {
  initStore as initBaseStore,
  Store,
} from '@daaku/kombat-indexed-db/store'

const loggedOutDataset = new Proxy(Object.freeze({}), {
  set() {
    throw new TypeError('cannot save data without logged in user')
  },
  deleteProperty() {
    throw new TypeError('cannot delete data without logged in user')
  },
})
const loggedOutDB = new Proxy(Object.freeze({}), {
  get() {
    return loggedOutDataset
  },
  set() {
    throw new TypeError('cannot set on DB')
  },
  deleteProperty() {
    throw new TypeError('cannot delete on DB')
  },
})

export interface Opts {
  readonly config: FirebaseConfig
  readonly auth: FirebaseAuth
  readonly api?: FirebaseAPI
  readonly name?: string
  readonly groupID?: string
}

interface ChangeListenerWrapper {
  listener: ChangeListener
  un?: () => void
}

class TheFireStore<DB extends object> implements Store<DB> {
  readonly #config: FirebaseConfig
  readonly #auth: FirebaseAuth
  readonly #api: FirebaseAPI
  readonly #name?: string
  readonly #groupID?: string
  #listeners: ChangeListenerWrapper[] = []
  #store?: Store<DB>

  constructor(opts: Opts) {
    this.#config = opts.config
    this.#auth = opts.auth
    this.#name = opts.name
    this.#groupID = opts.groupID
    this.#api =
      opts.api ??
      makeFirebaseAPI({
        config: opts.config,
        tokenSource: () => this.#auth.getBearerToken(),
      })
    this.#auth.subscribe(this.#onAuthChange.bind(this), false)
  }

  close(): void {
    this.#store?.close()
  }

  async settle(): Promise<void> {
    await this.#store?.settle()
  }

  listenChanges(cb: ChangeListener): () => void {
    let un: (() => void) | undefined = undefined
    if (this.#store) {
      un = this.#store.listenChanges(cb)
    }
    this.#listeners.push({
      listener: cb,
      un,
    })
    return () => {
      this.#listeners = this.#listeners.filter(e => {
        if (e.listener === cb) {
          if (e.un) {
            e.un()
          }
          return false
        }
        return true
      })
    }
  }

  static async new(opts: Opts) {
    const s = new TheFireStore(opts)
    await s.#onAuthChange(s.#auth.user)
    return s
  }

  get db(): DB {
    if (!this.#store) {
      // @ts-expect-error type bypass
      return loggedOutDB
    }
    return this.#store.db
  }

  async #onAuthChange(user: User | undefined) {
    if (!user) {
      if (this.#store) {
        this.#store.close()
        this.#store = undefined
      }
      return
    }

    const dbName = this.#name ? `${this.#name}_${user.localId}` : user.localId
    const groupID = this.#groupID
      ? this.#groupID
      : this.#name
      ? `${user.localId}.${this.#name}`
      : user.localId
    const remote = new RemoteFirestore({
      config: this.#config,
      api: this.#api,
      groupID,
    })

    this.#store = await initBaseStore({
      dbName,
      remote,
    })
    this.#listeners.forEach(l => {
      if (l.un) {
        l.un()
      }
      l.un = this.#store!.listenChanges(l.listener)
    })
  }
}

export const initStore = <DB extends object>(opts: Opts): Promise<Store<DB>> =>
  // @ts-expect-error type bypass
  TheFireStore.new(opts)
