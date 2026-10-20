import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A finished match, kept for history and the dashboard. */
@Entity('match_results')
export class MatchResultEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The match ID: 6 digits, or a chosen ID of up to 20 characters. */
  @Column({ length: 24 })
  code!: string;

  @Column({ length: 16 })
  mode!: string;

  @Column()
  player1Name!: string;

  @Column()
  player2Name!: string;

  /** Accounts that played, for stats (null for older results). */
  @Column({ nullable: true, type: 'varchar' })
  player1UserId!: string | null;

  @Column({ nullable: true, type: 'varchar' })
  player2UserId!: string | null;

  @Column({ nullable: true, type: 'varchar' })
  refereeName!: string | null;

  @Column('int')
  player1Score!: number;

  @Column('int')
  player2Score!: number;

  /** 'player1', 'player2' or 'draw'. */
  @Column({ length: 8 })
  winner!: string;

  @CreateDateColumn()
  finishedAt!: Date;
}
