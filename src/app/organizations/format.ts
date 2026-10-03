const participantPlural = new Intl.PluralRules('ru-RU')

export function participantLabel(count: number) {
  const form = participantPlural.select(count)
  return form === 'one' ? 'участник' : form === 'few' ? 'участника' : 'участников'
}

// The same point keeps its accent in the roster, documents and requests.
export function locationTone(id: string) {
  let hash = 0
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return ['teal', 'cyan', 'rose', 'clay'][hash % 4]
}
