import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { neo4jDriver } from "./neo4j";

const systemPrompt = `
You are a Neo4j Cypher query generator.
Your job is to translate a Thai natural language question into a valid Cypher query based on the following graph schema:

Nodes & Properties:
- (:Course {name: string})
- (:Chapter {title: string})
- (:Chunk {title: string, content: string})
- (:ExternalQA {question: string, answer: string})

Relationships:
- (:Course)-[:HAS_CHAPTER]->(:Chapter)
- (:Chapter)-[:HAS_CHUNK]->(:Chunk)

Instructions:
1. Answer ONLY with the raw Cypher query.
2. Do not include markdown code block syntax (like \`\`\`cypher) or any explanation. Just return the raw Cypher string.
3. Use case-insensitive regex or 'CONTAINS' for search terms.
4. You can search both (:Chunk) and (:ExternalQA) nodes.
5. IMPORTANT: Unify the return fields. The query MUST return exactly two columns: 'title' and 'content'.
   - For (:Chunk) nodes: RETURN c.title AS title, c.content AS content
   - For (:ExternalQA) nodes: RETURN q.question AS title, q.answer AS content
   - You may use UNION to search and return results from both types of nodes if relevant to the query.
`;

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
        const qwenUrl = process.env.QWEN_API_URL || "http://209.15.120.6:8000/v1";
        const qwenKey = process.env.QWEN_API_KEY || "dG9rZW5fdG90X2lkY19hc3NldA==";
        const qwenModel = process.env.QWEN_MODEL || "Qwen/Qwen3-14B-AWQ";

        // Call Qwen API to translate question into Cypher query
        const response = await fetch(`${qwenUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${qwenKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: qwenModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `คำถาม: "${question}" \nสร้าง Cypher query:` },
            ],
            temperature: 0.1,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to contact Qwen API: ${response.statusText}`);
        }

        const data = (await response.json()) as any;
        let cypherQuery = data.choices[0].messages?.content || data.choices[0].message?.content;
        
        if (!cypherQuery) {
          throw new Error("No Cypher query was returned from Qwen API.");
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
        summary: "Ask questions in natural language and query Neo4j using Qwen AI (JWT protected)",
        security: [
          {
            bearerAuth: [],
          },
        ],
      },
    }
  );
