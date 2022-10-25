import { Auth, User } from '@daaku/firebase-auth'
import { FirebaseAPI, FirebaseConfig } from '@daaku/firebase-rest-api'
import { deleteDB } from 'idb'

import { initStore } from '../src/index.js'

const userDaaku = 'daaku'
const userShah = 'shah'

interface Jedi {
  name: string
  age: number
}

interface Sith {
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

const testID = () => {
  return QUnit.config.current.testName.toLowerCase().replaceAll(/[^a-z]/g, '_')
}

QUnit.hooks.beforeEach(assert => {
  assert.id = testID()
})

QUnit.hooks.afterEach(async assert => {
  if (assert.store) {
    await assert.store?.close()
    await deleteDB(`${assert.id}_${userDaaku}`)
    await deleteDB(`${assert.id}_${userShah}`)
  }
})

QUnit.test('Test Logged Out', async assert => {
  const store = (assert.store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  }))
  assert.ok(store.db, 'db exists')
  assert.ok(store.db.jedi, 'collection exists')
  assert.notOk(store.db.jedi.yoda, 'objects dont exist')
})

QUnit.test('Test Logged In', async assert => {
  const store = (assert.store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(userDaaku),
    api: apiThrows,
    name: assert.id,
  }))
  assert.ok(store.db, 'db exists')
  assert.ok(store.db.jedi, 'collection exists')
  assert.notOk(store.db.jedi.yoda, 'objects dont exist')
})
