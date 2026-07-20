/**
 * UTF-8 transport invariant for Git and filesystem identity strings.
 * Valid surrogate pairs are accepted; U+FFFD and unpaired surrogates are not.
 */
export function isWellFormedGitText(value: string): boolean {
  if (value.includes("\uFFFD")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

export function assertWellFormedGitText(value: string, label: string): string {
  if (!isWellFormedGitText(value)) throw new TypeError(`${label} is not well-formed Unicode`);
  return value;
}
