import { MigrationInterface, QueryRunner } from 'typeorm';

/** Chosen match IDs can be up to 20 characters; the column held only 8. */
export class LongerMatchCode1760800000000 implements MigrationInterface {
  name = 'LongerMatchCode1760800000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "match_results" ALTER COLUMN "code" TYPE character varying(24)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "match_results" ALTER COLUMN "code" TYPE character varying(8)`,
    );
  }
}
