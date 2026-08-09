import postgres from "postgres";

const host = process.env.PG_DB_HOST || "localhost";
const port = parseInt(process.env.PG_DB_PORT || "5432", 10);
const username = process.env.PG_DB_USERNAME;
const password = process.env.PG_DB_PASSWORD;
const database = process.env.PG_DB_DATABASE;

if (!username || !password || !database) {
  console.warn("⚠️ Postgres database environment variables are missing in .env!");
}

export const sql = postgres({
  host,
  port,
  username,
  password,
  database,
  ssl: false,
});

// Helper to initialize the database tables if they do not exist
export async function initializeDatabase() {
  try {
    // PostgreSQL has "user" as a reserved keyword, so we wrap it in double quotes "user"
    await sql`
      CREATE TABLE IF NOT EXISTS "user" (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("✅ Database 'user' table checked/initialized successfully.");
  } catch (error) {
    console.error("❌ Failed to initialize database:", error);
  }
}
