import { MigrationInterface, QueryRunner } from 'typeorm';

/** Named JSON settings, starting with the competition rules. */
export class Settings1760700000000 implements MigrationInterface {
  name = 'Settings1760700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "settings" (
        "key" character varying(40) NOT NULL,
        "value" jsonb NOT NULL,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_settings_key" PRIMARY KEY ("key")
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "settings"`);
  }
}
