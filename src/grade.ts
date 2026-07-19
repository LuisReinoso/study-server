// Answer grading: judges a free-text user answer against the correct answer
// by meaning (not exact wording), via a JSON-constrained LLM call that
// returns { "score": number }. This module holds the pure, testable pieces.

export function gradeSystemPrompt(): string {
  return `You are a grading assistant for a study app. Compare the user's answer to the correct answer.

Judge by MEANING, not exact wording. Give credit for paraphrases, synonyms, and partially correct answers.

Return a score from 0 to 1:
- 1.0: fully correct, captures the key idea
- 0.5-0.9: partially correct, missing some detail or slightly imprecise
- 0.1-0.4: mostly wrong but shows some relevant understanding
- 0.0: wrong, irrelevant, or blank

OUTPUT FORMAT: {"score": X}
The root key MUST be "score", a number between 0 and 1.`;
}

/** Clamps a possibly-out-of-range or non-finite value into [0, 1]. */
export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Extracts and clamps a score out of a parsed model JSON response. */
export function parseScore(result: any): number {
  const raw =
    typeof result?.score === "number"
      ? result.score
      : typeof result?.score === "string"
      ? parseFloat(result.score)
      : NaN;
  return clampScore(raw);
}
