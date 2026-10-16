export function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) <= 0x1f) return true;
  }
  return false;
}
