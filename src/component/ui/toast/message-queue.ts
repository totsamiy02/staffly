export function enqueueMessage<T extends { id: string }>(queue: T[], message: T): T[] {
  return queue.some(item => item.id === message.id)
    ? queue.map(item => item.id === message.id ? message : item)
    : [...queue, message]
}
