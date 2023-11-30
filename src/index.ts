import { Auth as FirebaseAuth, User } from '@daaku/firebase-auth'
import {
  FirebaseAPI,
  FirebaseConfig,
  makeFirebaseAPI,
} from '@daaku/firebase-rest-api'
import { SyncDB } from '@daaku/kombat'
import { RemoteFirestore } from '@daaku/kombat-firestore'
import {
  ChangeListener,
  loadDatasetMem,
  LocalIndexedDB,
  syncDatasetMem,
} from '@daaku/kombat-indexed-db'
import { IDBPDatabase, openDB } from 'idb'
import { dequal } from 'dequal'

export interface Opts {
  readonly config: FirebaseConfig
  readonly auth: FirebaseAuth
  readonly api?: FirebaseAPI
  readonly name?: string
}

// Store provides the DB, that proxy to your various datasets.
export interface Store<DB extends object> {
  // Your datasets, containing the the rows of data.
  readonly db: DB

  // Listen to changes on the data.
  listenChanges(cb: ChangeListener): () => void

  // Settle ensures all background async writes have submitted to the underlying
  // SyncDB. This is important because the proxy provides a synchronous API on
  // what is underneath an asynchronous API.
  settle(): Promise<void>
}

const isPrimitive = (v: unknown) => {
  if (typeof v === 'object') {
    return v === null
  }
  return typeof v !== 'function'
}

class DBProxy {
  #store: TheStore<any>
  constructor(s: TheStore<any>) {
    this.#store = s
  }
  get(_: unknown, dataset: string) {
    return this.#store.datasetProxy(dataset)
  }
  set(): any {
    throw new TypeError('cannot set on DB')
  }
  deleteProperty(): any {
    throw new TypeError('cannot delete on DB')
  }
  ownKeys() {
    return Object.keys(this.#store.mem)
  }
  has(_: unknown, dataset: string) {
    const mem = this.#store.mem
    return mem && dataset in this.#store.mem
  }
  defineProperty(): any {
    throw new TypeError('cannot defineProperty on DB')
  }
  getOwnPropertyDescriptor(_: unknown, p: string) {
    return {
      value: this.#store.datasetProxy(p),
      writable: true,
      enumerable: true,
      configurable: true,
    }
  }
}

class DatasetProxy {
  #store: TheStore<any>
  #dataset: string
  constructor(s: TheStore<any>, dataset: string) {
    this.#store = s
    this.#dataset = dataset
  }
  get(_: unknown, id: string) {
    // only tombstones prevent a get, otherwise let it get created as necessary
    if (!this.#store.mem?.[this.#dataset]?.[id]?.tombstone) {
      return new Proxy({}, new RowProxy(this.#store, this.#dataset, id))
    }
  }
  set(_: unknown, id: string, value: any): any {
    if (!this.#store.mem) {
      throw new Error(
        `cannot save data without logged in user in dataset "${
          this.#dataset
        }" with row id "${id}"`,
      )
    }
    if (typeof value !== 'object') {
      throw new Error(
        `cannot use non object value in dataset "${
          this.#dataset
        }" with row id "${id}"`,
      )
    }

    // work with a clone, since we may modify it
    value = structuredClone(value)

    // ensure we have an ID and it is what we expect
    if ('id' in value) {
      if (id !== value.id) {
        const valueID = value.id
        throw new Error(
          `id mismatch in dataset "${
            this.#dataset
          }" with row id "${id}" and valud id ${valueID}`,
        )
      }
    } else {
      value.id = id
    }

    // only send messages for changed values.
    const existing = this.#store.mem[this.#dataset]?.[id] ?? {}
    this.#store.send(
      // @ts-expect-error typescript doesn't understand filter
      [
        // update changed properties
        ...Object.entries(value)
          .map(([k, v]) => {
            if (existing && dequal(existing[k], v)) {
              return
            }
            return {
              dataset: this.#dataset,
              row: id,
              column: k,
              value: v,
            }
          })
          .filter(v => v),
        // drop missing properties
        ...Object.keys(existing)
          .map(k => {
            if (k in value) {
              return
            }
            return {
              dataset: this.#dataset,
              row: id,
              column: k,
              value: undefined,
            }
          })
          .filter(v => v),
      ],
    )
    // synchronously update our in-memory dataset.
    let dataset = this.#store.mem[this.#dataset]
    if (!dataset) {
      dataset = this.#store.mem[this.#dataset] = {}
    }
    dataset[id] = value
    return true
  }
  deleteProperty(_: unknown, id: string): any {
    this.#store.send([
      {
        dataset: this.#dataset,
        row: id,
        column: 'tombstone',
        value: true,
      },
    ])
    this.#store.mem[this.#dataset][id].tombstone = true
    return true
  }
  ownKeys() {
    const dataset = this.#store.mem?.[this.#dataset]
    if (dataset) {
      // For some reason this filtering isn't necessary. Need to understand why.
      //return Object.keys(dataset).filter(r => !!dataset[r].tombstone)
      return Object.keys(dataset)
    }
    return []
  }
  has(_: unknown, id: string) {
    const row = this.#store.mem?.[this.#dataset]?.[id]
    return row && !row.tombstone
  }
  defineProperty(): any {
    throw new TypeError(`cannot defineProperty on dataset "${this.#dataset}"`)
  }
  getOwnPropertyDescriptor(target: unknown, id: string) {
    const value = this.get(target, id)
    if (value) {
      return {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      }
    }
  }
}

class RowProxy {
  #store: TheStore<any>
  #dataset: string
  #id: string
  constructor(store: TheStore<any>, dataset: string, id: string) {
    this.#store = store
    this.#dataset = dataset
    this.#id = id
  }
  get(_: unknown, prop: string) {
    const row = this.#store.mem?.[this.#dataset]?.[this.#id]
    if (!row) {
      return
    }
    const val = row[prop]
    // hasOwn allows pass-thru of prototype properties like constructor
    if (isPrimitive(val) || !Object.hasOwn(row, prop)) {
      return val
    }
    throw new Error(
      `non primitive value for dataset "${this.#dataset}" row with id "${
        this.#id
      }" and property "${prop}" of type "${typeof val}" and value "${val}"`,
    )
  }
  set(_: any, prop: string, value: unknown): any {
    this.#store.send([
      {
        dataset: this.#dataset,
        row: this.#id,
        column: prop,
        value: value,
      },
    ])
    let dataset = this.#store.mem[this.#dataset]
    if (!dataset) {
      dataset = this.#store.mem[this.#dataset] = {}
    }
    let row = dataset[this.#id]
    if (!row) {
      row = dataset[this.#id] = { id: this.#id }
    }
    row[prop] = value
    return true
  }
  deleteProperty(_: unknown, prop: string): any {
    this.#store.send([
      {
        dataset: this.#dataset,
        row: this.#id,
        column: prop,
        value: undefined,
      },
    ])
    delete this.#store.mem[this.#dataset]?.[this.#id]?.[prop]
    return true
  }
  ownKeys() {
    const row = this.#store.mem?.[this.#dataset]?.[this.#id]
    return row ? Object.keys(row) : []
  }
  has(_: unknown, p: string) {
    const row = this.#store.mem?.[this.#dataset]?.[this.#id]
    return row ? p in row : false
  }
  defineProperty(): any {
    throw new TypeError(
      `cannot defineProperty on dataset "${this.#dataset}" with row id ${
        this.#id
      }`,
    )
  }
  getOwnPropertyDescriptor(target: unknown, prop: string) {
    const value = this.get(target, prop)
    if (value) {
      return {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      }
    }
  }
}

// TheStore is the internal concrete implementation which is returned. The
// TypeScript API is limited by the interface it implements. The other bits are
// for internal consumption.
class TheStore<DB extends object> implements Store<DB> {
  readonly #config: FirebaseConfig
  readonly #auth: FirebaseAuth
  readonly #api: FirebaseAPI
  readonly #name?: string
  readonly #dbProxy: ProxyHandler<DB>
  readonly #pending: Set<Promise<void>> = new Set()

  // this is reset as auth status changes
  #datasetProxies: Record<string, ProxyHandler<Record<string, any>>> = {}

  // these exist if a user is signed in
  #idb?: IDBPDatabase
  #local?: LocalIndexedDB
  syncDB?: SyncDB
  mem?: any

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
    this.#dbProxy = new Proxy({}, new DBProxy(this))
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.#pending.values())
    await this.syncDB?.settle()
  }

  listenChanges(cb: ChangeListener): () => void {
    if (!this.#local) {
      throw new Error('cannot listenChanges without a logged in user')
    }
    return this.#local.listenChanges(cb)
  }

  static async new(opts: Opts) {
    const s = new TheStore(opts)
    await s.#onAuthChange(s.#auth.user)
    return s
  }

  get db(): DB {
    // @ts-expect-error type bypass
    return this.#dbProxy
  }

  async #onAuthChange(user: User | undefined) {
    if (!user) {
      this.mem = undefined
      this.#idb?.close()
      this.#idb = undefined
      this.syncDB = undefined
      this.#datasetProxies = {}
      return
    }

    this.mem = {}
    this.#datasetProxies = {}

    const local = new LocalIndexedDB()
    local.listenChanges(syncDatasetMem(this.mem))
    const dbName = this.#name ? `${this.#name}_${user.localId}` : user.localId
    this.#idb = await openDB(dbName, 1, {
      upgrade: db => local.upgradeDB(db),
      blocking: () => this.#idb?.close(),
    })
    await loadDatasetMem(this.mem, this.#idb)
    local.setDB(this.#idb)
    this.#local = local

    const groupID = this.#name ? `${user.localId}.${this.#name}` : user.localId
    const remote = new RemoteFirestore({
      config: this.#config,
      api: this.#api,
      groupID,
    })
    this.syncDB = await SyncDB.new(remote, local)

    const r = this.syncDB.sync()
    this.#pending.add(r)
    r.finally(() => this.#pending.delete(r))
  }

  datasetProxy(dataset: string) {
    let proxy = this.#datasetProxies[dataset]
    if (!proxy) {
      this.#datasetProxies[dataset] = proxy = new Proxy(
        {},
        new DatasetProxy(this, dataset),
      )
    }
    return proxy
  }

  // wrap the syncDB send and hold on to the promises until they settle,
  // allowing callers to let things settle.
  send(...args: Parameters<SyncDB['send']>) {
    const r = this.syncDB!.send(...args)
    this.#pending.add(r)
    r.finally(() => this.#pending.delete(r))
  }
}

export const initStore = <DB extends object>(opts: Opts): Promise<Store<DB>> =>
  // @ts-expect-error type bypass
  TheStore.new(opts)
