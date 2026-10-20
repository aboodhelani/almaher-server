import type { QuestionType } from '../../questions/question.types';

export type Role = 'player1' | 'player2' | 'referee';
export type PlayerRole = 'player1' | 'player2';
export const PLAYERS: PlayerRole[] = ['player1', 'player2'];

/** On stage together (phones are buttons only) or apart (needs live audio/video). */
export type MatchMode = 'same_room' | 'remote';

export type MatchStatus = 'lobby' | 'playing' | 'finished';

/** The rounds of a match, in the show's order. */
export const ROUND_ORDER: QuestionType[] = [
  'what_do_you_know',
  'ayah_number',
  'auction',
  'similar',
  'sard',
  'right_left',
  'buzzer',
];

// Round timers, points and strikes live in the rules (src/rules).

export interface GameRef {
  surah: number;
  ayah: number;
  surahName: string;
  text: string;
}

/** A question as played in a match (from the bank or generated). */
export interface GameQuestion {
  type: QuestionType;
  prompt: string;
  answer: string;
  refs: GameRef[];
  timeLimitSeconds: number;
  meta: Record<string, unknown>;
}

export interface Participant {
  name: string;
  connected: boolean;
  /** The account in this seat (absent for the dashboard as referee). */
  userId?: string;
  /** Epoch ms when they went offline; absent while connected. */
  offlineSince?: number;
}
