/**
 * Shared System One vocabulary for the decision consultant.
 *
 * @module @deepseek-ai/dsh-experimental-decision-consultant
 */

/** Yes/no question with optional meaning for each side. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria?: { readonly true?: string; readonly false?: string }
}

/** Single-choice question over a bounded option set. */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string | null>>
}

/** Ordered-rubric question. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly criteria: readonly string[]
}

/** One typed question the consultant asks the model. */
export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Question id to typed question. */
export type QuestionMap = Readonly<Record<string, SystemOneQuestion>>

/** Probability of the yes answer. */
export interface NoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

/** Most likely option plus probability distribution. */
export interface ChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly confidence?: number
  readonly probabilities?: Readonly<Record<string, number>>
}

/** Mean rubric level plus its distribution. */
export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly confidence?: number
}

/** One typed answer keyed by question id. */
export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** Answer id to typed answer. */
export type AnswerMap = Readonly<Record<string, SystemOneAnswer>>

/** Successful consultation result. */
export interface ConsultResult {
  readonly answers: AnswerMap
  readonly latencyMs: number
  readonly requestId?: string
}

/** Bounded, redacted state sent as the model's `state` input. */
export interface GateState {
  readonly tool: string
  readonly arguments: string
  readonly policy?: string
}

/** Conservative hardening the consultant may add on top of the host decision. */
export type Hardening =
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason: string }
