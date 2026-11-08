import { useEffect, useRef, useState } from 'react'
import { useAdmin } from '../admin-data.tsx'
import type { Candidate } from './contracts.ts'

export function useCandidateSearch() {
  const { request } = useAdmin(), [search, setValue] = useState(''), [person, setPerson] = useState<Candidate | null>(null)
  const [finding, setFinding] = useState(false), [findError, setError] = useState<Error | null>(null), [appliedSearch, setAppliedSearch] = useState('')
  const current = useRef(0), controller = useRef<AbortController | null>(null)
  useEffect(() => () => { current.current++; controller.current?.abort() }, [])
  const setSearch = (value: string) => { current.current++; controller.current?.abort(); setValue(value); setPerson(null); setError(null); setFinding(false); setAppliedSearch('') }
  const run = async (term: string) => {
    controller.current?.abort(); const active = new AbortController(), version = ++current.current; controller.current = active
    setFinding(true); setError(null); setPerson(null)
    try {
      const candidate = await request<Candidate>('/management/administrators/candidate?search=' + encodeURIComponent(term), { signal: active.signal })
      if (version === current.current && !active.signal.aborted) { setPerson(candidate); setAppliedSearch(term) }
    } catch (error) { if (version === current.current && !active.signal.aborted) setError(error instanceof Error ? error : new Error('Не удалось найти аккаунт.')) }
    finally { if (version === current.current) setFinding(false) }
  }
  return { search, setSearch, person, finding, findError, appliedSearch, lookup: () => run(search.trim()), refresh: () => person ? run(String(person.publicId)) : Promise.resolve() }
}
