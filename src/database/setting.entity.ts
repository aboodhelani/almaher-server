import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One named setting stored as JSON (e.g. the competition rules). */
@Entity('settings')
export class SettingEntity {
  @PrimaryColumn({ length: 40 })
  key!: string;

  @Column('jsonb')
  value!: unknown;

  @UpdateDateColumn()
  updatedAt!: Date;
}
