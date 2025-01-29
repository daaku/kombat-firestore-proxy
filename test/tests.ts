import QUnit from 'qunit'
import 'qunit/qunit/qunit.css'
import { Auth, User } from '@daaku/firebase-auth'
import { FirebaseAPI, FirebaseConfig } from '@daaku/firebase-rest-api'
import { Changes } from '@daaku/kombat-indexed-db'
import { deleteDB } from 'idb'
import { customAlphabet } from 'nanoid'
import { initStore } from '../src/index.js'

// @ts-ignore
window.HARNESS_RUN_END && QUnit.on('runEnd', window.HARNESS_RUN_END)

const userDaaku = 'daaku'
const userShah = 'shah'
const yoda = Object.freeze({ name: 'yoda', age: 942 })
const vader = Object.freeze({ name: 'vader', convert: true })

const apiKey = 'AIzaSyCnFgFqO3d7RbJDcNAp_eO21KSOISCP9IU'
const projectID = 'fidb-unit-test'
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 16)
const domain = '1secmail.com'

interface Jedi {
  id?: string
  name: string
  age?: number
}

interface Sith {
  id?: string
  name: string
  convert: boolean
}

interface DB {
  jedi: Record<string, Jedi>
  sith: Record<string, Sith>
}

class mockAuth {
  localId?: string
  subscribers: { (u: User | undefined): void }[] = []

  static new(localId?: string): Auth {
    const m = new mockAuth()
    m.localId = localId
    // @ts-expect-error type bypass
    return m
  }

  get user(): User | undefined {
    if (this.localId) {
      // @ts-expect-error type bypass
      return { localId: this.localId }
    }
  }

  subscribe(
    cb: (user: User | undefined) => void,
    immediate = true,
  ): () => void {
    this.subscribers.push(cb)
    if (immediate) {
      cb(this.user)
    }
    return () => {
      throw new Error('unimplemented')
    }
  }
}

const apiThrows: FirebaseAPI = (method, path, body?) => {
  console.log(`unexpected firebase API call: ${method} ${path}`, body)
  throw new Error(`unexpected firebase API call: ${method} ${path}`)
}

const fakeConfig = (name: string) =>
  new FirebaseConfig({
    apiKey: name,
    projectID: name,
  })

const testID = () =>
  QUnit.config.current.testName.toLowerCase().replaceAll(/[^a-z]/g, '_')

QUnit.hooks.beforeEach(async assert => {
  assert.id = testID()
  await deleteDB(`${assert.id}_${userDaaku}`)
  await deleteDB(`${assert.id}_${userShah}`)
})

QUnit.test('Logged Out', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.ok(store.db, 'db exists')
  assert.notOk('jedi' in store.db, 'dataset in checks are false')
  assert.ok(store.db.jedi, 'but datasets are lazily created')
  assert.notOk('yoda' in store.db.jedi, 'object in checks are false')
  assert.strictEqual(
    store.db.jedi.yoda,
    undefined,
    'objects are undefined until created created',
  )
})

QUnit.test('DatasetProxy: Cannot Set when Logged Out', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.throws(() => {
    store.db.jedi.yoda = yoda
  }, /cannot save data without logged in/)
})
