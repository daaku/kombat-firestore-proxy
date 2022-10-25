import { Auth, User } from '@daaku/firebase-auth'
import { FirebaseAPI, FirebaseConfig } from '@daaku/firebase-rest-api'

import { initStore } from '../src/index.js'

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
  user?: User
  subscribers: { (u: User | undefined): void }[] = []

  static new(user?: User): Auth {
    const m = new mockAuth()
    m.user = user
    // @ts-expect-error type bypass
    return m
  }

  public subscribe(
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

QUnit.test('Test Logged Out', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig('test_logged_out'),
    auth: mockAuth.new(),
    api: apiThrows,
  })
  assert.ok(store.db, 'db exists')
  assert.ok(store.db.jedi, 'collection exists exists')
  assert.notOk(store.db.jedi.yoda, 'objects dont exist')
})
