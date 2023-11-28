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

QUnit.test('Logged Out', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.ok(store.db, 'db exists')
  assert.ok(store.db.jedi, 'dataset exists')
  assert.notOk(store.db.jedi.yoda, 'objects dont exist')
})

QUnit.test('DBProxy: Cannot Set Property', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.throws(() => {
    store.db.jedi = { yoda }
  }, /cannot set/)
})

QUnit.test('DBProxy: Cannot Delete Property', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.throws(() => {
    // @ts-expect-error bypass
    delete store.db.jedi
  }, /cannot delete/)
})

QUnit.test('DBProxy: Cannot defineProperty', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.throws(() => {
    Object.defineProperty(store.db, 'answer', {
      value: 42,
      writable: false,
    })
  }, /cannot define/)
})

QUnit.test('DatasetProxy: Cannot defineProperty', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  assert.throws(() => {
    Object.defineProperty(store.db.jedi, 'yoda', {
      value: yoda,
      writable: false,
    })
  }, /cannot define/)
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

QUnit.test('DatasetProxy: Cannot Set Non Object Value', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  // @ts-expect-error mucking with internal state
  store.mem = {}
  assert.throws(() => {
    // @ts-expect-error checking for non object set
    store.db.jedi.yoda = 42
  }, /cannot use non object/)
})

QUnit.test('DatasetProxy: id mismatch', async assert => {
  const store = await initStore<DB>({
    config: fakeConfig(assert.id),
    auth: mockAuth.new(),
    api: apiThrows,
    name: assert.id,
  })
  // @ts-expect-error mucking with internal state
  store.mem = {}
  assert.throws(() => {
    store.db.jedi.yoda = { id: 'joda', name: 'yoda' }
  }, /id mismatch/)
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

QUnit.test('Logged In Integration', async assert => {
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

        store.db.sith.vader = vader
        assert.propContains(store.db.sith.vader, vader, 'expect vader')
      },
      (changes: Changes) => {
        assert.propContains(changes, {
          sith: { vader },
        })

        assert.deepEqual(
          Object.keys(store.db),
          ['jedi', 'sith'],
          'expect both dataset in keys',
        )

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
  assert.deepEqual(Object.keys(store.db), [], 'no datasets')
  assert.false('jedi' in store.db, 'jedi dataset doesnt exist yet')
  assert.ok(store.db.jedi, 'a named dataset always exists')
  assert.notOk(store.db.jedi.yoda, 'yoda doesnt exist')
  store.db.jedi.yoda = yoda
  assert.equal(store.db.jedi.yoda.name, yoda.name, 'expect yoda name')
  assert.equal(store.db.jedi.yoda.age, yoda.age, 'expect yoda age')
  assert.equal(store.db.jedi.yoda.id, 'yoda', 'expect yoda id')
  assert.true('jedi' in store.db, 'jedi dataset now exists')
  await stepsWait

  // TODO: delete all data?
  await store.settle()
  await auth.delete()
})
