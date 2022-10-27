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

export interface Opts {
  readonly config: FirebaseConfig
  readonly auth: FirebaseAuth
  readonly api?: FirebaseAPI
  readonly name?: string
}

export interface Store<DB extends object> {
  readonly db: DB
  listenChanges(cb: ChangeListener): () => void
}

const isPrimitive = (v: any) => {
  if (typeof v === 'object') {
    return v === null
  }
  return typeof v !== 'function'
}

// TODO: fixme
const deepEqual = (a: any, b: any) => {
  return a === b
}

class DBProxy {
  #s: S<any>
  constructor(s: S<any>) {
    this.#s = s
  }
  get(_: any, dataset: string) {
    return this.#s.datasetProxy(dataset)
  }
  set(): any {
    throw new TypeError('cannot set on DB')
  }
  deleteProperty(): any {
    throw new TypeError('cannot delete on DB')
  }
  ownKeys() {
    return Object.keys(this.#s.mem)
  }
  has(_: any, dataset: string) {
    const mem = this.#s.mem
    return mem && dataset in this.#s.mem
  }
  defineProperty(): any {
    throw new TypeError('cannot defineProperty on DB')
  }
  getOwnPropertyDescriptor(_: any, p: string) {
    return {
      value: this.#s.datasetProxy(p),
      writable: true,
      enumerable: true,
      configurable: true,
    }
  }
}

class RowProxy {
  #s: S<any>
  #dataset: string
  #id: string
  constructor(s: S<any>, dataset: string, id: string) {
    this.#s = s
    this.#dataset = dataset
    this.#id = id
  }
  get(_: any, prop: string) {
    const row = this.#s.mem[this.#dataset][this.#id]
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
  set(_: any, prop: string, value: any): any {
    this.#s.mem[this.#dataset][this.#id][prop] = value
    this.#s.syncDB?.send([
      {
        dataset: this.#dataset,
        row: this.#id,
        column: prop,
        value: value,
      },
    ])
    return true
  }
  deleteProperty(_: any, prop: string): any {
    delete this.#s.mem[this.#dataset][this.#id][prop]
    this.#s.syncDB?.send([
      {
        dataset: this.#dataset,
        row: this.#id,
        column: prop,
        value: undefined,
      },
    ])
    return true
  }
  ownKeys() {
    return Object.keys(this.#s.mem[this.#dataset][this.#id])
  }
  has(_: any, p: string) {
    return p in this.#s.mem[this.#dataset][this.#id]
  }
  defineProperty(): any {
    throw new TypeError('cannot defineProperty on store')
  }
  getOwnPropertyDescriptor(target: any, prop: string) {
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

class DatasetProxy {
  #s: S<any>
  #dataset: string
  constructor(s: S<any>, dataset: string) {
    this.#s = s
    this.#dataset = dataset
  }
  get(_: any, id: string) {
    const dataset = this.#s.mem?.[this.#dataset]
    if (dataset && id in dataset && !dataset[id].tombstone) {
      return new Proxy({}, new RowProxy(this.#s, this.#dataset, id))
    }
  }
  set(_: any, id: string, value: object): any {
    if (!this.#s.mem) {
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

    // work with a shallow clone
    // TODO: consider deep clone?
    value = { ...value }

    // ensure we have an ID and it is what we expect
    if ('id' in value) {
      // @ts-expect-error id is special
      if (id !== value.id) {
        // @ts-expect-error id is special
        const valueID = value.id
        throw new Error(
          `id mismatch in dataset "${
            this.#dataset
          }" with row id "${id}" and valud id ${valueID}`,
        )
      }
    } else {
      // @ts-expect-error id is special
      value.id = id
    }

    const existing = this.#s.mem[this.#dataset]?.[id] ?? {}
    this.#s.syncDB?.send(
      // @ts-expect-error typescript doesn't understand filter
      [
        // update changed properties
        ...Object.entries(value)
          .map(([k, v]) => {
            if (existing && deepEqual(existing[k], v)) {
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
    let dataset = this.#s.mem[this.#dataset]
    if (!dataset) {
      dataset = this.#s.mem[this.#dataset] = {}
    }
    dataset[id] = value
    return true
  }
  deleteProperty(_: any, id: string): any {
    this.#s.mem[this.#dataset][id].tombstone = true
    this.#s.syncDB?.send([
      {
        dataset: this.#dataset,
        row: id,
        column: 'tombstone',
        value: true,
      },
    ])
    return true
  }
  ownKeys() {
    const dataset = this.#s.mem[this.#dataset]
    if (dataset) {
      return Object.keys(dataset)
    }
    return []
  }
  has(_: any, id: string) {
    const dataset = this.#s.mem[this.#dataset]
    return dataset && !!dataset[id]
  }
  defineProperty(): any {
    throw new TypeError('cannot defineProperty on dataset')
  }
  getOwnPropertyDescriptor(target: any, id: string) {
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

  listenChanges(cb: ChangeListener): () => void {
    if (!this.#local) {
      throw new Error('cannot listenChanges without a logged in user')
    }
    return this.#local.listenChanges(cb)
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
  }

  datasetProxy(dataset: string) {
    let proxy = this.#datasetProxies[dataset]
    if (!proxy) {
      proxy = new Proxy({}, new DatasetProxy(this, dataset))
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
