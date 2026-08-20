import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { neo4jDriver } from "./neo4j";
import { CYPHER_SYSTEM_PROMPT } from "./prompts";

export const queryNeo4j = new Elysia({ prefix: "/query-neo4j" })
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "default_secret_fallback",
    })
  )
  .post(
    "/",
    async ({ body, headers, jwt, set }) => {
      const authHeader = headers["authorization"];
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        set.status = 401;
        return { success: false, error: "Unauthorized" };
      }

      const token = authHeader.substring(7);
      const payload = await jwt.verify(token);

      if (!payload) {
        set.status = 401;
        return { success: false, error: "Invalid or expired token" };
      }

      const { question } = body;

      try {
        const ntUrl = process.env.NT_QWEN_API_URL || "https://aigateway.ntictsolution.com/v1";
        const ntKey = process.env.NT_QWEN_API_KEY || "";
        const ntModel = process.env.NT_QWEN_MODEL || "Qwen3.8-27B";

        // Call NT Qwen API to translate question into Cypher query
        const response = await fetch(`${ntUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${ntKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: ntModel,
            messages: [
              { role: "system", content: CYPHER_SYSTEM_PROMPT },
              { role: "user", content: `คำถาม: "${question}" \nสร้าง Cypher query:` },
            ],
            temperature: 0.1,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to contact NT Qwen API: ${response.statusText}`);
        }

        const data = (await response.json()) as any;
        let cypherQuery = data.choices[0].messages?.content || data.choices[0].message?.content;
        
        if (!cypherQuery) {
          throw new Error("No Cypher query was returned from NT Qwen API.");
        }

        // Clean up markdown block styling from generated Cypher
        cypherQuery = cypherQuery.replace(/\`\`\`(cypher)?/g, "").trim();

        // Run the generated Cypher on Neo4j
        const session = neo4jDriver.session();
        const result = await session.run(cypherQuery);

        const records = result.records.map(record => record.toObject());
        await session.close();

        return {
          success: true,
          question,
          cypherQuery,
          resultsCount: records.length,
          results: records,
          ...(records.length === 0 ? { hint: "ลองใส่คำค้นหาให้กว้างกว่านี้" } : {}),
        };
      } catch (error: any) {
        set.status = 500;
        return {
          success: false,
          error: error.message || "Failed to process natural language graph query",
        };
      }
    },
    {
      body: t.Object({
        question: t.String({
          description: "Thai natural language question to search the graph database",
        }),
      }),
      headers: t.Object({
        authorization: t.String({
          description: "Bearer <token>",
        }),
      }),
      detail: {
        summary: "Ask questions in natural language and query Neo4j using NT Qwen AI (JWT protected)",
        security: [
          {
            bearerAuth: [],
          },
        ],
      },
    }
  );
