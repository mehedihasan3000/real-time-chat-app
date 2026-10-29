export function firstGrapheme(value: string): string {
  const trimmed = value.trim();

  if (trimmed === "") {
    return "?";
  }

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

    for (const { segment } of segmenter.segment(trimmed)) {
      return segment;
    }
  }

  return Array.from(trimmed)[0] ?? "?";
}

export function avatarToneFor(userId: string): number {
  let hash = 0;

  for (let index = 0; index < userId.length; index += 1) {
    hash = Math.imul(hash, 31) + userId.charCodeAt(index);
    hash >>>= 0;
  }

  return hash % 360;
}
