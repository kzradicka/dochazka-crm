import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Railway poskytuje DATABASE_URL automaticky po připojení Postgres databáze.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// Spustí schema.sql – vytvoří tabulky, pokud ještě neexistují.
// Schéma rozdělíme na jednotlivé příkazy a spouštíme je po jednom, aby:
//  1) případná chyba v jednom příkazu nezablokovala celý zbytek (a bylo jasné, KTERÝ padl),
//  2) šlo přesně vidět, na čem to selhává (dřív se chyba schovala).
export async function migrate() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

  // Odstraníme řádkové komentáře a rozdělíme podle středníku.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let ok = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (e) {
      // Vypíšeme přesně, který příkaz selhal a proč – ale migraci nezabijeme,
      // ať se doplní i zbývající tabulky (idempotentní CREATE ... IF NOT EXISTS).
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
      console.error(`MIGRACE – chyba u příkazu: "${preview}..." → ${e.message}`);
    }
  }
  console.log(`Databáze připravena (migrace: ${ok}/${statements.length} příkazů OK).`);
}

export default pool;
