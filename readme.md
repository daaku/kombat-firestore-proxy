# kombat-firestore-proxy

Kombat based Firebase backed synchronized offline first persistent object.
Sometimes you just want objects and dictionaries and have them magically be
synchronized.

# Implementation

This works by providing a [Proxy](Proxy) object which lazily creates datasets &
rows as you access them. This has some implications on the API.

- Reading datasets & rows almost always succeeds. Only time a row will be
  `undefined` is if it once existed and then was deleted (that is, the
  `tombstone` property is set to `true`).
- Writing datasets & rows follows the same rules, except a logged in user must
  be present.
- To check if a row with a given ID does in fact exist, use the `in` operator.
  This will only return true the row exists.

[Proxy]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
