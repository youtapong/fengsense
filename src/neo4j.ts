import neo4j from "neo4j-driver";

const host = process.env.NEO4J_DB_HOST || "localhost";
const port = process.env.NEO4J_DB_PORT || "7687";
const username = process.env.NEO4J_DB_USERNAME || "neo4j";
const password = process.env.NEO4J_DB_PASSWORD || "";

const uri = `bolt://${host}:${port}`;

export const neo4jDriver = neo4j.driver(
  uri,
  neo4j.auth.basic(username, password)
);

export async function initializeNeo4j() {
  const session = neo4jDriver.session();
  try {
    // Verify connection readiness
    await neo4jDriver.getServerInfo();
    console.log("✅ Neo4j database connected successfully.");

    // Automatically create Vector Index if it doesn't exist
    await session.run(`
      CREATE VECTOR INDEX \`chunk_vector_index\` IF NOT EXISTS
      FOR (c:Chunk) ON (c.embedding)
      OPTIONS {
        indexConfig: {
          \`vector.dimensions\`: 1536,
          \`vector.similarity_function\`: 'cosine'
        }
      }
    `);
    console.log("✅ Neo4j Vector Index checked/initialized successfully.");
  } catch (error) {
    console.error("❌ Failed to connect or initialize Neo4j database:", error);
  } finally {
    await session.close();
  }
}
