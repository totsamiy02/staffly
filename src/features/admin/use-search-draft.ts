import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** URL navigation restores applied text; edits made after submitting survive its delayed commit. */
export function useSearchDraft(query: string, queryKey='search') {
  const [search, setValue] = useState(query), previous = useRef(query), revision = useRef(0)
  const pending = useRef<{ value: string; revision: number } | null>(null)
  const editedAfterNavigation = useRef<string|null>(null), rendered = useRef(query)
  rendered.current=query
  useLayoutEffect(() => {
    // Router transitions may commit after the URL has changed and the user has
    // already started typing. That new edit belongs to the destination list.
    if(editedAfterNavigation.current!==null){
      if(query===editedAfterNavigation.current){previous.current=query;editedAfterNavigation.current=null;pending.current=null;return}
      if((new URLSearchParams(window.location.search).get(queryKey)??'')===editedAfterNavigation.current)return
      editedAfterNavigation.current=null
    }
    if (query === previous.current) return
    const submitted = pending.current
    if (!submitted || submitted.value !== query || submitted.revision === revision.current) setValue(query)
    pending.current = null
    previous.current = query
  }, [query,queryKey])
  const setSearch = useCallback((value: string) => { const actual=new URLSearchParams(window.location.search).get(queryKey)??'';if(actual!==rendered.current)editedAfterNavigation.current=actual;revision.current++; setValue(value) },[queryKey])
  const applied = useCallback((value: string) => { pending.current = { value, revision: revision.current } },[])
  return [search, setSearch, applied] as const
}
