import { QUESTION_TYPES, QuestionType } from '../questions/question.types';

/**
 * The competition's rules, managed from the dashboard. A match copies them
 * when it is created, so changes never affect a match already running.
 */
export interface MatchRules {
  /** Questions in each round by default (the show uses 4). */
  questionsPerRound: number;
  /**
   * Most questions a referee may give one round, and a whole match, when
   * choosing the rounds and their counts while preparing.
   */
  maxPerRound: number;
  maxQuestions: number;
  rounds: {
    /**
     * The point goes to the opponent of the player who runs out of strikes:
     * [cleanPoints] if the winner made no mistake, else [points]. Each player
     * may pass once per question.
     */
    what_do_you_know: {
      enabled: boolean;
      points: number;
      cleanPoints: number;
      strikes: number;
    };
    ayah_number: { enabled: boolean; points: number; seconds: number };
    auction: {
      enabled: boolean;
      points: number;
      bidSeconds: number;
      reciteSeconds: number;
    };
    similar: {
      enabled: boolean;
      strikes: number;
      /** A correct answer within [fastSeconds] scores [fastPoints], within [slowSeconds] [slowPoints]. */
      fastSeconds: number;
      fastPoints: number;
      slowSeconds: number;
      slowPoints: number;
    };
    /** Players say the ayah's last word; [strikes] tries each. */
    sard: {
      enabled: boolean;
      points: number;
      seconds: number;
      strikes: number;
    };
    /** Each player's run of openings, [itemSeconds] each; more right wins. */
    right_left: { enabled: boolean; points: number; itemSeconds: number };
    buzzer: { enabled: boolean; points: number; seconds: number };
  };
}

export const DEFAULT_RULES: MatchRules = {
  questionsPerRound: 4,
  maxPerRound: 30,
  maxQuestions: 60,
  rounds: {
    what_do_you_know: { enabled: true, points: 1, cleanPoints: 2, strikes: 3 },
    ayah_number: { enabled: true, points: 1, seconds: 60 },
    auction: { enabled: true, points: 1, bidSeconds: 60, reciteSeconds: 45 },
    similar: {
      enabled: true,
      strikes: 3,
      fastSeconds: 15,
      fastPoints: 3,
      slowSeconds: 45,
      slowPoints: 2,
    },
    sard: { enabled: true, points: 1, seconds: 30, strikes: 2 },
    right_left: { enabled: true, points: 1, itemSeconds: 3 },
    buzzer: { enabled: true, points: 1, seconds: 60 },
  },
};

export class RulesError extends Error {}

/** Allowed range of every number, by field name. */
const RANGES: Record<string, [number, number]> = {
  questionsPerRound: [1, 100],
  maxPerRound: [1, 100],
  maxQuestions: [1, 300],
  points: [1, 10],
  cleanPoints: [1, 10],
  strikes: [1, 10],
  seconds: [10, 600],
  bidSeconds: [10, 600],
  reciteSeconds: [10, 600],
  fastSeconds: [5, 600],
  slowSeconds: [5, 600],
  fastPoints: [1, 10],
  slowPoints: [1, 10],
  itemSeconds: [1, 30],
};

/**
 * Merges [input] over [base] (anything missing keeps its value), checking
 * every number's range. At least one round must stay on, المتشابهات' fast
 * tier must come before its slow one, and the default match (every round on
 * at [questionsPerRound]) must fit the limits.
 */
export function validateRules(
  input: unknown,
  base: MatchRules = DEFAULT_RULES,
): MatchRules {
  const b = (input ?? {}) as Record<string, any>;
  const num = (key: string, value: unknown, current: number) => {
    if (value === undefined) return current;
    const n = Number(value);
    const [min, max] = RANGES[key];
    if (!Number.isInteger(n) || n < min || n > max)
      throw new RulesError(`invalid_${key}`);
    return n;
  };
  const bool = (value: unknown, current: boolean) =>
    value === undefined ? current : value === true;

  const rules: MatchRules = JSON.parse(JSON.stringify(base));
  rules.questionsPerRound = num(
    'questionsPerRound',
    b.questionsPerRound,
    base.questionsPerRound,
  );
  rules.maxPerRound = num('maxPerRound', b.maxPerRound, base.maxPerRound);
  rules.maxQuestions = num('maxQuestions', b.maxQuestions, base.maxQuestions);
  for (const type of QUESTION_TYPES) {
    const given = (b.rounds?.[type] ?? {}) as Record<string, unknown>;
    const round = rules.rounds[type] as unknown as Record<
      string,
      number | boolean
    >;
    for (const [key, current] of Object.entries(round)) {
      round[key] =
        typeof current === 'boolean'
          ? bool(given[key], current)
          : num(key, given[key], current);
    }
  }
  if (!QUESTION_TYPES.some((t) => rules.rounds[t].enabled))
    throw new RulesError('no_rounds');
  const s = rules.rounds.similar;
  if (s.fastSeconds >= s.slowSeconds) throw new RulesError('similar_tiers');
  if (rules.questionsPerRound > rules.maxPerRound)
    throw new RulesError('per_round_over_limit');
  if (
    enabledRounds(rules).length * rules.questionsPerRound >
    rules.maxQuestions
  ) {
    throw new RulesError('match_over_limit');
  }
  return rules;
}

/** The rounds that are on, in the show's order. */
export function enabledRounds(rules: MatchRules): QuestionType[] {
  return QUESTION_TYPES.filter((t) => rules.rounds[t].enabled);
}
