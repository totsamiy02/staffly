// Local mitigation for CVE-2026-112366 in the published picomatch 4.0.7.
// Based on the collapse approach and its capture/quoting correction:
// https://github.com/micromatch/picomatch/pull/237
// https://github.com/micromatch/picomatch/pull/246
// Extended to guard non-reducible wildcard branches and literal prefix overlap.
// https://github.com/micromatch/picomatch/issues/175
// Upstream licence: LICENSE.picomatch. Its installed licence is left intact.
// Keep the upstream package identity/version intact so npm audit stays honest.
import { createHash } from 'node:crypto'

export const version = '4.0.7'
export const originalHash = '4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4'
export const patchedHash = '221a867b80dc4701a70373f86ebd51d43e009442a6927a4be6dde7db2411e28f'

export const changes = [
  {
    before: String.raw`const analyzeRepeatedExtglob = (body, options) => {`,
    after: String.raw`// A plain branch containing an ordinary star absorbs its own repetition.
// Do not rewrite escapes, quoting, paths or other glob/regex syntax.
const isSelfRepeatingStarBranch = branch => {
  return branch.includes('*') &&
    !branch.includes('**') &&
    !/[\\/"?()[\]{}|!+@]/.test(branch);
};

// The remaining wildcard-star branches cannot safely be flattened. Reuse the
// parser's existing literal fallback instead of emitting nested quantifiers.
const hasUnescapedGlobStar = branch => {
  let escaped = false;
  let quoted = false;
  let bracket = false;
  for (const ch of branch) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (!bracket && ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (bracket) {
      if (ch === ']') bracket = false;
      continue;
    }
    if (ch === '[') {
      bracket = true;
      continue;
    }
    if (ch === '*') return true;
  }
  return false;
};

const analyzeRepeatedExtglob = (body, options) => {`,
  },
  {
    before: String.raw`  return { risky: false };
};

/**
 * Parse the given input string.`,
    after: String.raw`  if (branches.length === 1 && isSelfRepeatingStarBranch(branches[0])) {
    // Flattening changes repeated captures. Retain the existing safe literal
    // fallback in capture mode instead of silently changing the captures.
    return options.capture === true ? { risky: true } : { risky: false, collapse: true };
  }

  if (branches.some(hasUnescapedGlobStar)) {
    return { risky: true };
  }

  return { risky: false };
};

/**
 * Parse the given input string.`,
  },
  {
    before: String.raw`    let output = token.close + (opts.capture ? ')' : '');`,
    after: String.raw`    if (analysis.collapse === true && (token.type === 'plus' || token.type === 'star')) {
      token.close = token.type === 'plus' ? ')' : ')?';
    }

    let output = token.close + (opts.capture ? ')' : '');`,
  },
  {
    before: String.raw`      const char = a[0];

      if (!char || a !== char.repeat(a.length) || b !== char.repeat(b.length)) {
        continue;
      }

      if (a === b || a.startsWith(b) || b.startsWith(a)) {`,
    after: String.raw`      if (a && b && (a === b || a.startsWith(b) || b.startsWith(a))) {`,
  },
]

export function patchPicomatch(source) {
  const digest = createHash('sha256').update(source).digest('hex')
  if (digest === patchedHash) return source
  if (digest !== originalHash) throw new Error('Unexpected picomatch parser: review the dependency and security patch before continuing')
  let result = source
  for (const { before, after } of changes) {
    if (result.split(before).length !== 2) throw new Error('Picomatch patch does not match the expected source')
    result = result.replace(before, after)
  }
  if (createHash('sha256').update(result).digest('hex') !== patchedHash) throw new Error('Picomatch security patch checksum mismatch')
  return result
}
