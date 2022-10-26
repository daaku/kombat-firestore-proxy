import { Auth, User } from '@daaku/firebase-auth'
import { FirebaseAPI, FirebaseConfig } from '@daaku/firebase-rest-api'
import { deleteDB } from 'idb'

import { initStore } from '../src/index.js'

const userDaaku = 'daaku'
const userShah = 'shah'
const yoda = Object.freeze({ name: 'yoda', age: 942 })

interface Jedi {
  id?: string
  name: string
  age: number
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

QUnit.test('Test Logged Out', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.ok(store.db, 'db exists')
  assert.ok(store.db.jedi, 'collection exists')
  assert.notOk(store.db.jedi.yoda, 'objects dont exist')
})

QUnit.test('Test Logged In', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(userDaaku),
    api: async () => [{ missing: true }],
    name: assert.id,
  })
  assert.ok(store.db, 'db exists')
  assert.ok(store.db.jedi, 'collection exists')
  assert.notOk(store.db.jedi.yoda, 'yoda doesnt exist')
  store.db.jedi.yoda = yoda
  assert.equal(store.db.jedi.yoda.name, yoda.name, 'expect yoda name')
  assert.equal(store.db.jedi.yoda.age, yoda.age, 'expect yoda age')
  assert.equal(store.db.jedi.yoda.id, 'yoda', 'expect yoda id')
  delete store.db.jedi.yoda
  assert.notOk(store.db.jedi.yoda, 'yoda should be deleted')
})
