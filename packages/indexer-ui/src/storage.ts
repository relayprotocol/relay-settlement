export const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
