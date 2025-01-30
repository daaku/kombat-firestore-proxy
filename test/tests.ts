import QUnit from 'qunit'
import 'qunit/qunit/qunit.css'
import { User } from '@daaku/firebase-auth'
import {
  FirebaseAPI,
  FirebaseConfig,
  makeFirebaseAPI,
} from '@daaku/firebase-rest-api'
import { deleteDB } from 'idb'
import { initStore } from '../src/index.js'
import {
  signUpAnon,
  deleteUser,
  deleteUserData,
} from '@daaku/kombat-firestore/test'
import { Store } from '@daaku/kombat-indexed-db/store'

// @ts-ignore
window.HARNESS_RUN_END && QUnit.on('runEnd', window.HARNESS_RUN_END)

const yoda = Object.freeze({ name: 'yoda', age: 942 })
const vader = Object.freeze({ name: 'vader', convert: true })

const firebaseConfig = new FirebaseConfig({
  apiKey: 'AIzaSyCnFgFqO3d7RbJDcNAp_eO21KSOISCP9IU',
  projectID: 'fidb-unit-test',
})

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
  #user?: User
  #subscribers: { (u: User | undefined): void }[] = []

  constructor(user?: User) {
    this.#user = user
  }

  get user(): User | undefined {
    return this.#user
  }
  set user(user: User | undefined) {
    this.#user = user
    this.#subscribers.forEach(f => f(user))
  }

  subscribe(
    cb: (user: User | undefined) => void,
    immediate = true,
  ): () => void {
    this.#subscribers.push(cb)
    if (immediate) {
      cb(this.user)
    }
    return () => {
      throw new Error('unimplemented')
    }
  }
}

declare global {
  interface Assert {
    id: string
    auth: mockAuth
    api: FirebaseAPI
    store: Store<DB>
  }
}

QUnit.hooks.beforeEach(async assert => {
  assert.id = QUnit.config.current.testName
    .toLowerCase()
    .replaceAll(/[^a-z]/g, '_')

  await deleteDB(assert.id)

  assert.auth = new mockAuth()
  assert.api = makeFirebaseAPI({
    config: firebaseConfig,
    tokenSource: async () => assert.auth.user?.idToken,
  })
  assert.store = await initStore<DB>({
    // @ts-expect-error using a mock
    auth: assert.auth,
    api: assert.api,
    name: assert.id,
    config: firebaseConfig,
  })
})

QUnit.hooks.afterEach(async assert => {
  await assert.store.settle()
  await deleteDB(assert.id)
})

QUnit.test('Logged Out', async assert => {
  assert.ok(assert.store.db, 'db exists')
  assert.notOk('jedi' in assert.store.db, 'dataset in checks are false')
  assert.ok(assert.store.db.jedi, 'but datasets can be accessed')
  assert.notOk('yoda' in assert.store.db.jedi, 'object in checks are false')
  assert.strictEqual(
    assert.store.db.jedi.yoda,
    undefined,
    'objects are undefined',
  )
})

QUnit.test('DatasetProxy: Cannot Set when Logged Out', async assert => {
  assert.throws(() => {
    assert.store.db.jedi.yoda = yoda
  }, /cannot save data without logged in/)
})

QUnit.test('Integration: Multiple Steps', async assert => {
  assert.timeout(30000)

  assert.notOk(assert.auth.user, 'start with no user')
  // @ts-expect-error need to make email optional to support anon users
  const user: User = await signUpAnon(firebaseConfig)
  assert.auth.user = user
  await assert.store.settle()
  assert.store.db.jedi.yoda = yoda
  assert.strictEqual(assert.store.db.jedi.yoda.name, yoda.name, 'yoda name')
  assert.strictEqual(assert.store.db.jedi.yoda.id, 'yoda', 'yoda id')
  assert.store.db.sith.vader = vader
  assert.strictEqual(assert.store.db.sith.vader.name, vader.name, 'vader name')
  await assert.store.settle()
  assert.auth.user = undefined
  await assert.store.settle()
  deleteDB(assert.id)
  assert.strictEqual(assert.store.db.jedi.yoda, undefined, 'yoda is gone')
  assert.strictEqual(assert.store.db.sith.vader, undefined, 'vader is gone')
  assert.auth.user = user
  await assert.store.settle()
  assert.strictEqual(assert.store.db.jedi.yoda.name, yoda.name, 'yoda lives')
  assert.strictEqual(assert.store.db.sith.vader.name, vader.name, 'vader lives')
  await deleteUserData(assert.api, user.localId)
  await deleteUser(firebaseConfig, user.idToken)
})
