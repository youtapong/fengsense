import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { neo4jDriver } from "./neo4j";
import { CYPHER_SYSTEM_PROMPT, FENGSHUI_EXPERT_SYSTEM_PROMPT } from "./prompts";
import { generateEmbedding } from "./services/markdownIngest";

export const queryFengSense = new Elysia({ prefix: "/query_FengSense" })
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "default_secret_fallback",
    })
  )
  .post(
    "/",
    async ({ body, headers, jwt, set }) => {
      // 0. Check Authorization JWT Header
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
      const ntUrl = process.env.NT_QWEN_API_URL || "https://aigateway.ntictsolution.com/v1";
      const ntKey = process.env.NT_QWEN_API_KEY || "";
      const ntModel = process.env.NT_QWEN_MODEL || "Qwen3.8-27B";

      try {
        // ========================================================
        // 1. วิเคราะห์คำถาม โดยส่งให้ NT Qwen สร้าง Cypher Query
        // ========================================================
        const cypherRes = await fetch(`${ntUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ntKey}`,
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

        if (!cypherRes.ok) {
          throw new Error(`NT Qwen Cypher generator error: ${cypherRes.statusText}`);
        }

        const cypherData = (await cypherRes.json()) as any;
        let cypherQuery =
          cypherData.choices?.[0]?.messages?.content ||
          cypherData.choices?.[0]?.message?.content ||
          "";
        cypherQuery = cypherQuery.replace(/\`\`\`(cypher)?/g, "").trim();

        // ========================================================
        // 2. ส่งคำถามที่วิเคราะห์แล้ว ค้นหาใน Neo4j
        // ========================================================
        const session = neo4jDriver.session();
        let records: any[] = [];

        if (cypherQuery) {
          try {
            const result = await session.run(cypherQuery);
            records = result.records.map((r) => r.toObject());
          } catch (queryErr) {
            console.warn("⚠️ Cypher execution error, falling back to LLM:", queryErr);
          }
        }

        // ถ้าพบข้อมูลใน Neo4j -> ตอบและจบการทำงาน
        if (records.length > 0) {
          await session.close();
          return {
            success: true,
            question,
            source: "neo4j_graph",
            cypherQuery,
            resultsCount: records.length,
            answer: records[0].content,
            results: records,
          };
        }

        // ========================================================
        // 3. ถ้าไม่พบข้อมูลคล้ายกัน -> ส่งคำถามไปถาม NT Qwen
        // ========================================================
        const expertRes = await fetch(`${ntUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ntKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: ntModel,
            messages: [
              { role: "system", content: FENGSHUI_EXPERT_SYSTEM_PROMPT },
              { role: "user", content: question },
            ],
            temperature: 0.7,
            max_tokens: 1000,
          }),
        });

        if (!expertRes.ok) {
          await session.close();
          set.status = 502;
          return { success: false, error: `NT Qwen API error: ${expertRes.statusText}` };
        }

        const expertData = (await expertRes.json()) as any;
        const answer =
          expertData.choices?.[0]?.messages?.content ||
          expertData.choices?.[0]?.message?.content;

        if (!answer) {
          await session.close();
          set.status = 502;
          return { success: false, error: "Empty response from NT Qwen" };
        }

        // ========================================================
        // 4. บันทึกคำถามและคำตอบไว้ที่ Neo4j
        // ========================================================
        const embedding = await generateEmbedding(question);
        await session.run(
          `
          CREATE (q:ExternalQA {
            question: $question,
            answer: $answer,
            embedding: $embedding,
            source: 'NT_Qwen',
            timestamp: timestamp()
          })
        `,
          { question, answer, embedding }
        );

        await session.close();

        return {
          success: true,
          question,
          answer,
          source: "nt_qwen_ai",
          resultsCount: 1,
          savedToGraph: true,
        };
      } catch (error: any) {
        set.status = 500;
        return {
          success: false,
          question,
          error: error.message || "An unexpected error occurred",
        };
      }
    },
    {
      body: t.Object({
        question: t.String({
          description: "คำถามภาษาไทยเกี่ยวกับฮวงจุ้ยหรือบทเรียนในระบบ",
        }),
      }),
      headers: t.Object({
        authorization: t.String({
          description: "Bearer <token>",
        }),
      }),
      detail: {
        summary: "Query FengSense with NT Qwen AI, Neo4j Graph Search, and Auto-Cache",
        security: [{ bearerAuth: [] }],
      },
    }
  );
