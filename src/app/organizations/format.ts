const participantPlural = new Intl.PluralRules('ru-RU')

export function participantLabel(count: number) {
  const form = participantPlural.select(count)
  return form === 'one' ? 'участник' : form === 'few' ? 'участника' : 'участников'
}
