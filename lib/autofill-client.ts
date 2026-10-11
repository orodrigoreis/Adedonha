import { MAX_ANSWER_LENGTH, normalize } from "./game-rules.ts";

export function emptyAutofillUpdates(
  current: Record<string, string>,
  suggestions: Record<string, string>,
  categories: string[],
  letter: string,
) {
  return categories.flatMap((category): Array<[string, string]> => {
    const value = suggestions[category];
    if (
      current[category]?.trim() ||
      typeof value !== "string" ||
      !value.trim() ||
      value.length > MAX_ANSWER_LENGTH ||
      !normalize(value).startsWith(letter.toLowerCase())
    )
      return [];
    return [[category, value.trim()]];
  });
}
