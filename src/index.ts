import { Auth as FirebaseAuth, User } from '@daaku/firebase-auth'
import {
  FirebaseAPI,
  FirebaseConfig,
  makeFirebaseAPI,
} from '@daaku/firebase-rest-api'
import { SyncDB } from '@daaku/kombat'
import { RemoteFirestore } from '@daaku/kombat-firestore'
import {
  loadDatasetMem,
  LocalIndexedDB,
  syncDatasetMem,
} from '@daaku/kombat-indexed-db'
import { IDBPDatabase, openDB } from 'idb'

export interface Opts {
  readonly config: FirebaseConfig
  readonly auth: FirebaseAuth
  readonly api?: FirebaseAPI
  readonly name?: string
}

export interface Store<DB extends object> {
  readonly db: DB
  listenChanges: () => void
}

class S<DB extends object> implements Store<DB> {
  readonly #config: FirebaseConfig
  readonly #auth: FirebaseAuth
  readonly #api: FirebaseAPI
  readonly #name?: string
  readonly #dbProxy: ProxyHandler<DB>

  // this is reset as auth status changes
  #datasetProxies: Record<string, ProxyHandler<Record<string, any>>> = {}

  // these exist if a user is signed in
  #idb?: IDBPDatabase
  #syncDB?: SyncDB
  #mem?: any

  constructor(opts: Opts) {
    this.#config = opts.config
    this.#auth = opts.auth
    this.#name = opts.name
    this.#api =
      opts.api ??
      makeFirebaseAPI({
        config: this.#config,
        tokenSource: () => this.#auth.getBearerToken(),
      })
    this.#auth.subscribe(this.#onAuthChange.bind(this), false)

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const s = this
    // @ts-expect-error type bypass
    this.#dbProxy = new Proxy(Object.freeze({ name: 'rootStore' }), {
      get(_, p: string) {
        return s.dataset(p)
      },
      set() {
        throw new TypeError('cannot set on store')
      },
      deleteProperty() {
        throw new TypeError('cannot delete on store')
      },
      ownKeys() {
        return s.knownDatasets()
      },
      has(_, p: string) {
        return s.hasDataset(p)
      },
      defineProperty() {
        throw new TypeError('cannot defineProperty on store')
      },
      getOwnPropertyDescriptor(_, p: string) {
        return {
          value: s.dataset(p),
          writable: true,
          enumerable: true,
          configurable: false,
        }
      },
    })
  }

  listenChanges() {
    void 0
  }

  static async new(opts: Opts) {
    const s = new S(opts)
    await s.#onAuthChange(s.#auth.user)
    return s
  }

  get db(): DB {
    // @ts-expect-error type bypass
    return this.#dbProxy
  }

  async #onAuthChange(user: User | undefined) {
    if (!user) {
      this.#mem = undefined
      this.#idb?.close()
      this.#idb = undefined
      this.#syncDB = undefined
      this.#datasetProxies = {}
      return
    }

    this.#mem = {}
    this.#datasetProxies = {}

    const local = new LocalIndexedDB()
    local.listenChanges(syncDatasetMem(this.#mem))
    const dbName = this.#name ? `${this.#name}_${user.localId}` : user.localId
    this.#idb = await openDB(dbName, 1, {
      upgrade: db => {
        local.upgradeDB(db)
      },
    })
    await loadDatasetMem(this.#mem, this.#idb)
    local.setDB(this.#idb)

    const groupID = this.#name ? `${user.localId}.${this.#name}` : user.localId
    const remote = new RemoteFirestore({
      config: this.#config,
      api: this.#api,
      groupID,
    })
    this.#syncDB = await SyncDB.new(remote, local)
  }

  knownDatasets() {
    return Object.keys(this.#mem)
  }

  hasDataset(dataset: string) {
    return dataset in this.#mem
  }

  dataset(dataset: string) {
    let proxy = this.#datasetProxies[dataset]
    if (!proxy) {
      // @ts-expect-error type bypass
      proxy = new Proxy(Object.freeze({ name: dataset }), {
        get(_, p) {
          return null
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.#datasetProxies[dataset] = proxy
    }
    return proxy
  }
}

export const initStore = async <DB extends object>(
  opts: Opts,
): Promise<Store<DB>> =>
  // @ts-expect-error type bypass
  S.new(opts)

// on property write, apply the change to in-mem object immediately
// filter writes that did not change values
// syncDB.send the message (it already delays sync)
// schedule a change event in the next tick
// when syncDB applyChanges come thru, apply all chanages to in-mem again
// fire change event after filtering for unchanged values
// make sure id property is immutable and matches key in dataset
