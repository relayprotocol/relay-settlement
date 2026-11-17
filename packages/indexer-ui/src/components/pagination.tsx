import { useState } from "react"
import { PAGE_SIZE } from "../api/queries"
import { Pager } from "./ui"

const useResettable = <T,>(initial: T, resetKey: string) => {
  const [state, setState] = useState({ key: resetKey, value: initial })
  if (state.key !== resetKey) setState({ key: resetKey, value: initial })
  return [
    state.key === resetKey ? state.value : initial,
    (value: T) => setState({ key: resetKey, value }),
  ] as const
}

export const useCursorPages = (resetKey = "") => {
  const [cursors, setCursors] = useResettable<string[]>([], resetKey)
  return {
    cursor: cursors.at(-1),
    next: (cursor: string) => setCursors([...cursors, cursor]),
    page: cursors.length + 1,
    previous: () => setCursors(cursors.slice(0, -1)),
  }
}

export function CursorPager({
  pages,
  next,
}: {
  pages: ReturnType<typeof useCursorPages>
  next?: string | null
}) {
  return (
    <Pager
      page={pages.page}
      hasPrevious={pages.page > 1}
      hasNext={!!next}
      onPrevious={pages.previous}
      onNext={() => next && pages.next(next)}
    />
  )
}

export const useListPages = (total = 0, resetKey = "", size = PAGE_SIZE) => {
  const [page, setPage] = useResettable(1, resetKey)
  const last = Math.max(1, Math.ceil(total / size))
  const number = Math.min(page, last)
  return {
    last,
    number,
    reset: () => setPage(1),
    set: setPage,
    size,
  }
}

export function ListPager({
  pages,
}: {
  pages: ReturnType<typeof useListPages>
}) {
  return (
    <Pager
      page={pages.number}
      pages={pages.last}
      hasPrevious={pages.number > 1}
      hasNext={pages.number < pages.last}
      onPrevious={() => pages.set(pages.number - 1)}
      onNext={() => pages.set(pages.number + 1)}
    />
  )
}
