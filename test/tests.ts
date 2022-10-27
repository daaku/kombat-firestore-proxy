import { Auth, User } from '@daaku/firebase-auth'
import { FirebaseAPI, FirebaseConfig } from '@daaku/firebase-rest-api'
import { Changes } from '@daaku/kombat-indexed-db'
import { deleteDB } from 'idb'
import { customAlphabet } from 'nanoid'

import { initStore } from '../src/index.js'

const userDaaku = 'daaku'
const userShah = 'shah'
const yoda = Object.freeze({ name: 'yoda', age: 942 })

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

const waitFor = (): [Promise<void>, () => void] => {
  let finish: () => void
  const promise = new Promise<void>(resolve => {
    finish = resolve
  })
  // @ts-expect-error bypass
  return [promise, finish]
}

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

const steps = (fns: any) => {
  let count = 0
  return (...rest: any) => {
    const fn = fns[count]
    if (!fn) {
      console.error(`unexpected step count: ${count}`, ...rest)
      throw new Error(`unexpected step count: ${count}`)
    }
    count++
    return fn(...rest)
  }
}

QUnit.test('Test Logged In', async assert => {
  const login = nanoid()
  const password = nanoid()
  const email = `${login}@${domain}`

  const auth = await Auth.new({
    apiKey,
    name: assert.id,
  })
  await auth.signUp({
    email,
    password,
  })
  assert.ok(auth.user, 'expect signed in user')

  const store = await initStore<DB>({
    name: assert.id,
    config: new FirebaseConfig({ apiKey, projectID }),
    auth,
  })

  const [stepsWait, stepsDone] = waitFor()
  store.listenChanges(
    steps([
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              id: 'yoda',
              age: 942,
              name: 'yoda',
            },
          },
        })

        store.db.jedi.yoda.age = yoda.age + 1
        assert.equal(
          store.db.jedi.yoda.age,
          yoda.age + 1,
          'expect new yoda age',
        )
      },
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              age: yoda.age + 1,
            },
          },
        })

        delete store.db.jedi.yoda.age
        assert.notOk(store.db.jedi.yoda.age, 'expect no age')
      },
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              age: undefined,
            },
          },
        })

        assert.propEqual(store.db.jedi, {
          yoda: {
            id: 'yoda',
            name: 'yoda',
          },
        })

        delete store.db.jedi.yoda
        assert.notOk(store.db.jedi.yoda, 'yoda should be deleted')
      },
      (changes: Changes) => {
        assert.deepEqual(changes, {
          jedi: {
            yoda: {
              tombstone: true,
            },
          },
        })
        stepsDone()
      },
    ]),
  )

  assert.ok(store.db, 'db exists')
  assert.ok(store.db.jedi, 'collection exists')
  assert.notOk(store.db.jedi.yoda, 'yoda doesnt exist')
  store.db.jedi.yoda = yoda
  assert.equal(store.db.jedi.yoda.name, yoda.name, 'expect yoda name')
  assert.equal(store.db.jedi.yoda.age, yoda.age, 'expect yoda age')
  assert.equal(store.db.jedi.yoda.id, 'yoda', 'expect yoda id')
  await stepsWait

  // TODO: how to ensure API calls have finished before executing this?
  // TODO: delete all data?
  //await auth.delete()
})
