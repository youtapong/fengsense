import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { initializeDatabase } from "./db";
import { initializeNeo4j } from "./neo4j";
import { auth } from "./auth";
import { document } from "./document";
import { queryNeo4j } from "./query-neo4j";

// Initialize PostgreSQL database and user table
await initializeDatabase();

// Initialize Neo4j database connection
await initializeNeo4j();

const app = new Elysia({ prefix: '/fengsense' })
  .use(
    swagger({
      scalarConfig: {
        theme: 'saturn'
      },
      documentation: {
        info: {
          title: "FengSense API Documentation",
          version: "1.0.0"
        },
        security: [
          {
            bearerAuth: []
          }
        ],
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
  .use(queryNeo4j)
  .get("/", () => "Hello Elysia")
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
