interface Assert {
  id: string
  store?: { close(): Promise<void> }
}
