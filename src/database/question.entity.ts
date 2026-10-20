import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AyahRef, QuestionType } from '../questions/question.types';

/** A saved question of any round (generated or added by hand). */
@Entity('questions')
export class QuestionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ length: 24 })
  type!: QuestionType;

  @Column({ length: 12 })
  source!: 'generated' | 'manual';

  @Column('text')
  prompt!: string;

  @Column('text')
  answer!: string;

  @Column('jsonb', { default: [] })
  refs!: AyahRef[];

  @Column('int', { default: 60 })
  timeLimitSeconds!: number;

  @Column('jsonb', { default: {} })
  meta!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;
}
