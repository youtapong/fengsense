import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { neo4jDriver } from "./neo4j";
import { generateEmbedding } from "./services/markdownIngest";
import { FENGSHUI_EXPERT_SYSTEM_PROMPT } from "./prompts";

export const queryExternalAI = new Elysia({ prefix: "/query-external-ai" })
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "default_secret_fallback",
    }),
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
        // 1. Generate embedding vector for the user's question
        const embedding = await generateEmbedding(question);

        // 2. Query Neo4j vector index to find if we have a similar question in the cache
        const session = neo4jDriver.session();
        const searchResult = await session.run(
          `
          CALL db.index.vector.queryNodes('external_qa_vector_index', 1, $embedding)
          YIELD node AS q, score
          RETURN q.question AS question, q.answer AS answer, score
        `,
          { embedding },
        );

        const cachedRecord = searchResult.records[0];

        // If we found a cached question and the similarity score is high (>= 90%)
        if (cachedRecord && cachedRecord.get("score") >= 0.9) {
          const answer = cachedRecord.get("answer");
          await session.close();

          return {
            success: true,
            question,
            answer,
            source: "neo4j_cache",
            resultsCount: 1,
          };
        }

        // 3. Cache miss: Query DeepSeek AI
        const deepseekUrl =
          process.env.DEEPSEEK_QWEN_API_URL ||
          process.env.DEEPSEEK_API_URL ||
          "http://1.179.140.78:8002/v1";
        const deepseekKey =
          process.env.DEEPSEEK_QWEN_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
        const deepseekModel =
          process.env.DEEPSEEK_QWEN_MODEL ||
          process.env.DEEPSEEK_MODEL ||
          "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B";
        const deepseekMaxTokens = process.env.DEEPSEEK_QWEN_MAX_TOKENS
          ? parseInt(process.env.DEEPSEEK_QWEN_MAX_TOKENS)
          : 512;
        const deepseekTemperature = process.env.DEEPSEEK_QWEN_TEMPERATURE
          ? parseFloat(process.env.DEEPSEEK_QWEN_TEMPERATURE)
          : 0.6;

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (deepseekKey) {
          headers["Authorization"] = `Bearer ${deepseekKey}`;
        }

        const response = await fetch(`${deepseekUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: deepseekModel,
            messages: [
              {
                role: "system",
                content: FENGSHUI_EXPERT_SYSTEM_PROMPT,
              },
              {
                role: "user",
                content: `${question}\n\n(หมายเหตุ: โปรดตอบเป็นภาษาไทยทั้งหมด หากมีคำศัพท์หรือตัวอักษรภาษาจีนให้แปลและอธิบายเป็นภาษาไทยกำกับด้วยครับ)`,
              },
            ],
            temperature: deepseekTemperature,
            max_tokens: deepseekMaxTokens,
          }),
        });

        if (!response.ok) {
          console.error(
            `❌ DeepSeek API call failed: ${response.status} ${response.statusText}`,
          );
          await session.close();
          set.status = 402;
          return {
            success: false,
            question,
            resultsCount: 0,
            hint: "token หมดไหม",
            error: `DeepSeek API returned status ${response.status}`,
          };
        }

        const data = (await response.json()) as any;
        const rawAnswer = data.choices?.[0]?.message?.content;

        if (!rawAnswer) {
          console.error(
            "❌ DeepSeek response payload did not contain message content:",
            data,
          );
          await session.close();
          set.status = 402;
          return {
            success: false,
            question,
            resultsCount: 0,
            hint: "token หมดไหม",
            error: "Empty response content from DeepSeek",
          };
        }

        const answer = rawAnswer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        // 4. Save the new answer to Neo4j cache
        await session.run(
          `
          CREATE (q:ExternalQA {
            question: $question,
            answer: $answer,
            embedding: $embedding,
            timestamp: timestamp()
          })
        `,
          {
            question,
            answer,
            embedding,
          },
        );

        await session.close();

        return {
          success: true,
          question,
          answer,
          source: "deepseek_api",
          resultsCount: 1,
        };
      } catch (error: any) {
        console.error("❌ Error in queryExternalAI handler:", error);
        set.status = 500;
        return {
          success: false,
          question,
          resultsCount: 0,
          hint: "token หมดไหม",
          error: error.message || "An unexpected error occurred",
        };
      }
    },
    {
      body: t.Object({
        question: t.String({
          description: "Question to ask the external DeepSeek AI",
        }),
      }),
      headers: t.Object({
        authorization: t.String({
          description: "Bearer <token>",
        }),
      }),
      detail: {
        summary:
          "Query external AI with semantic graph caching (JWT protected)",
        security: [
          {
            bearerAuth: [],
          },
        ],
      },
    },
  );
