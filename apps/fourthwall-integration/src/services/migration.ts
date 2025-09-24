import { Migration, migrations } from '../migrations/index.js';

export class MigrationService {
  private hasRun = false;

  constructor(private db: D1Database) {}

  async runMigrations(): Promise<void> {
    // Ensure migrations only run once per worker instance
    if (this.hasRun) {
      console.log('[MIGRATION] Migrations already run in this instance, skipping');
      return;
    }

    console.log('[MIGRATION] Starting database migrations');
    
    try {
      // First, ensure the migrations table exists
      await this.ensureMigrationsTable();

      // Get list of already applied migrations
      const appliedMigrations = await this.getAppliedMigrations();
      console.log('[MIGRATION] Applied migrations count:', appliedMigrations.size);

      // Run each migration that hasn't been applied yet
      let migrationsRun = 0;
      for (const migration of migrations) {
        if (!appliedMigrations.has(migration.id)) {
          await this.runMigration(migration);
          migrationsRun++;
        }
      }

      if (migrationsRun > 0) {
        console.log(`[MIGRATION] Successfully ran ${migrationsRun} new migrations`);
      } else {
        console.log('[MIGRATION] No new migrations to run');
      }

      this.hasRun = true;
    } catch (error) {
      console.error('[MIGRATION] Error running migrations:', error);
      console.error('[MIGRATION] Error stack:', error instanceof Error ? error.stack : 'No stack');
      // Don't throw - allow the worker to start even if migrations fail
      // This prevents the worker from being completely broken if there's a migration issue
    }
  }

  private async ensureMigrationsTable(): Promise<void> {
    // This is always safe to run as it uses IF NOT EXISTS
    const sql = `
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `;

    try {
      await this.db.prepare(sql).run();
      console.log('[MIGRATION] Migrations table ready');
    } catch (error) {
      console.error('[MIGRATION] Error creating migrations table:', error);
      throw error;
    }
  }

  private async getAppliedMigrations(): Promise<Set<string>> {
    try {
      const result = await this.db
        .prepare('SELECT id FROM migrations')
        .all<{ id: string }>();

      const appliedSet = new Set<string>();
      if (result.results) {
        for (const row of result.results) {
          appliedSet.add(row.id);
        }
      }
      
      return appliedSet;
    } catch {
      // If the table doesn't exist yet, return empty set
      console.log('[MIGRATION] Could not fetch applied migrations, assuming none applied');
      return new Set<string>();
    }
  }

  private async runMigration(migration: Migration): Promise<void> {
    console.log(`[MIGRATION] Running migration: ${migration.id} - ${migration.name}`);

    try {
      // Start a transaction for the migration
      const statements = migration.sql
        .split(';')
        .filter(stmt => stmt.trim().length > 0)
        .map(stmt => stmt.trim() + ';');

      // Run each statement in the migration
      for (const statement of statements) {
        if (statement.trim()) {
          await this.db.prepare(statement).run();
        }
      }

      // Record that this migration has been applied
      await this.db
        .prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .bind(migration.id, migration.name, new Date().toISOString())
        .run();

      console.log(`[MIGRATION] Successfully applied migration: ${migration.id}`);
    } catch (error) {
      console.error(`[MIGRATION] Error applying migration ${migration.id}:`, error);
      throw error;
    }
  }

  // Utility method to check if migrations are needed
  async needsMigration(): Promise<boolean> {
    try {
      const appliedMigrations = await this.getAppliedMigrations();
      return migrations.some(m => !appliedMigrations.has(m.id));
    } catch {
      // If we can't check, assume migrations are needed
      return true;
    }
  }
}