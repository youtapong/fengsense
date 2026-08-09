import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { initializeDatabase } from "./db";
import { initializeNeo4j } from "./neo4j";
import { auth } from "./auth";
import { document } from "./document";

// Initialize PostgreSQL database and user table
await initializeDatabase();

// Initialize Neo4j database connection
await initializeNeo4j();

const app = new Elysia({ prefix: '/fengsense' })
  .use(
    swagger({
      documentation: {
        info: {
          title: "FengSense API Documentation",
          version: "1.0.0"
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT"
            }
          }
        }
      }
    })
  )
  .use(auth)
  .use(document)
  .get("/", () => "Hello Elysia")
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
