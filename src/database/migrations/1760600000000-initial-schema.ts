import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema as it stood when migrations replaced `synchronize`. Written
 * with IF NOT EXISTS so databases created by `synchronize` earlier take it
 * without changes. New schema changes go in new migrations after this one.
 */
export class InitialSchema1760600000000 implements MigrationInterface {
  name = 'InitialSchema1760600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "match_results" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" character varying(8) NOT NULL,
        "mode" character varying(16) NOT NULL,
        "player1Name" character varying NOT NULL,
        "player2Name" character varying NOT NULL,
        "refereeName" character varying,
        "player1Score" integer NOT NULL,
        "player2Score" integer NOT NULL,
        "winner" character varying(8) NOT NULL,
        "finishedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_788799fb3b8324d976620b485f2" PRIMARY KEY ("id")
      )`);
    // Added after the first results were kept.
    await q.query(
      `ALTER TABLE "match_results" ADD COLUMN IF NOT EXISTS "player1UserId" character varying`,
    );
    await q.query(
      `ALTER TABLE "match_results" ADD COLUMN IF NOT EXISTS "player2UserId" character varying`,
    );
    await q.query(`
      CREATE TABLE IF NOT EXISTS "questions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" character varying(24) NOT NULL,
        "source" character varying(12) NOT NULL,
        "prompt" text NOT NULL,
        "answer" text NOT NULL,
        "refs" jsonb NOT NULL DEFAULT '[]',
        "timeLimitSeconds" integer NOT NULL DEFAULT 60,
        "meta" jsonb NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_08a6d4b0f49ff300bf3a0ca60ac" PRIMARY KEY ("id")
      )`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e3727a7829444b69ba3c74c138" ON "questions" ("type")`,
    );
    await q.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "displayName" character varying(40) NOT NULL,
        "passwordHash" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"),
        CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "users"`);
    await q.query(`DROP INDEX "IDX_e3727a7829444b69ba3c74c138"`);
    await q.query(`DROP TABLE "questions"`);
    await q.query(`DROP TABLE "match_results"`);
  }
}
