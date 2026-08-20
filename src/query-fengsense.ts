import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { neo4jDriver } from "./neo4j";
import {
  CYPHER_SYSTEM_PROMPT,
  FENGSHUI_EXPERT_SYSTEM_PROMPT,
  RAG_SYNTHESIS_SYSTEM_PROMPT,
} from "./prompts";
import { generateEmbedding } from "./services/markdownIngest";

/**
 * คำนวณคะแนนความเกี่ยวข้อง (Relevance Score) ระหว่างคำถามกับแต่ละ Record
 * และจัดลำดับจากคะแนนสูงสุดไปต่ำสุด เพื่อให้ชุดข้อมูลที่ตรงที่สุดขึ้นก่อนเสมอ
 */
function rerankRecords(
  question: string,
  records: Array<{ title?: string; content?: string }>
): Array<{ title: string; content: string; relevanceScore: number }> {
  const normalizedQ = question.toLowerCase();

  // สกัดคำสำคัญ (Keywords) โดยตัดคำเชื่อมทั่วไป
  const stopWords = new Set([
    "การ", "ของ", "ให้", "และ", "หรือ", "ตาม", "แบบ", "ที่", "ใน", "กับ", "เป็น", "มี", "จะ", "ได้", "ช่วย", "ทำ"
  ]);
  const rawWords = normalizedQ.split(/[\s,.\-_/\\+]+/);
  const keywords = rawWords.filter((w) => w.length > 1 && !stopWords.has(w));

  const scoredRecords = records.map((r) => {
    const title = r.title || "";
    const content = r.content || "";
    const lowerTitle = title.toLowerCase();
    const lowerContent = content.toLowerCase();

    let score = 0;

    // 1. ถ้า Title ตรงกับคำถาม หรือคำถามมี Title บรรจุอยู่
    if (lowerTitle && (normalizedQ.includes(lowerTitle) || lowerTitle.includes(normalizedQ))) {
      score += 50;
    }

    // 2. ตรวจสอบการตรงกันของ Keywords ใน Title และ Content
    for (const kw of keywords) {
      if (lowerTitle.includes(kw)) {
        score += 20; // ปรากฏในหัวข้อ ให้คะแนนสูงมาก
      }
      if (lowerContent.includes(kw)) {
        score += 2; // ปรากฏในเนื้อหา
      }
    }

    // 3. โบนัสพิเศษสำหรับคำหลักสำคัญเฉพาะกลุ่ม
    const mainPhrases = [
      "จัดสวน", "สวน", "โต๊ะทำงาน", "ห้องนอน", "เตียงนอน", "ประตู", "หน้าต่าง",
      "บันได", "ห้องน้ำ", "ห้องครัว", "ทิศ", "มังกร", "เสือขาว", "โมเดิร์น", "โมเดิล"
    ];
    for (const phrase of mainPhrases) {
      if (normalizedQ.includes(phrase)) {
        if (lowerTitle.includes(phrase)) score += 30;
        else if (lowerContent.includes(phrase)) score += 5;
      }
    }

    return {
      title,
      content,
      relevanceScore: score,
    };
  });

  // จัดเรียงคะแนนจากมากไปน้อย
  scoredRecords.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // กรองเฉพาะชุดข้อมูลที่มีความเกี่ยวข้อง หากมีรายการที่คะแนนสูง (>= 20) ให้ตัด noise ทิ้ง
  const topScore = scoredRecords[0]?.relevanceScore || 0;
  const filtered =
    topScore >= 20
      ? scoredRecords.filter((r) => r.relevanceScore >= 5)
      : scoredRecords;

  // จำกัดแสดงผลเฉพาะ 3 ลำดับแรกที่มีความเกี่ยวข้องสูงสุด
  return filtered.slice(0, 3);
}

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

      const { question, query_option = "int" } = body;
      const ntUrl = process.env.NT_QWEN_API_URL || "https://aigateway.ntictsolution.com/v1";
      const ntKey = process.env.NT_QWEN_API_KEY || "";
      const ntModel = process.env.NT_QWEN_MODEL || "Qwen3.8-27B";

      const deepseekUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1";
      const deepseekKey = process.env.DEEPSEEK_API_KEY || "";
      const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";

      // ฟังก์ชันสำหรับถาม AI ผู้เชี่ยวชาญภายนอก (DeepSeek -> fallback NT Qwen)
      const askExternalExpert = async () => {
        let answer = "";
        let expertModelUsed = "deepseek";

        const expertRes = await fetch(`${deepseekUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deepseekKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: deepseekModel,
            messages: [
              { role: "system", content: FENGSHUI_EXPERT_SYSTEM_PROMPT },
              { role: "user", content: question },
            ],
            temperature: 0.7,
          }),
        });

        if (expertRes.ok) {
          const expertData = (await expertRes.json()) as any;
          answer = expertData.choices?.[0]?.message?.content || "";
        } else {
          console.warn("⚠️ DeepSeek expert failed, falling back to NT Qwen:", expertRes.statusText);
          const qwenExpertRes = await fetch(`${ntUrl}/chat/completions`, {
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

          if (qwenExpertRes.ok) {
            const qwenData = (await qwenExpertRes.json()) as any;
            answer =
              qwenData.choices?.[0]?.messages?.content ||
              qwenData.choices?.[0]?.message?.content ||
              "";
            expertModelUsed = "nt_qwen";
          }
        }

        return { answer, expertModelUsed };
      };

      // ฟังก์ชันสำหรับบันทึกคำถาม-คำตอบลง Neo4j (Auto-Cache)
      const cacheExternalQA = async (ans: string, sourceModel: string) => {
        const session = neo4jDriver.session();
        try {
          const embedding = await generateEmbedding(question);
          await session.run(
            `
            CREATE (q:ExternalQA {
              question: $question,
              answer: $answer,
              embedding: $embedding,
              source: $source,
              timestamp: timestamp()
            })
          `,
            { question, answer: ans, embedding, source: sourceModel }
          );
        } catch (cacheErr) {
          console.warn("⚠️ Failed to cache external QA to Neo4j:", cacheErr);
        } finally {
          await session.close();
        }
      };

      try {
        // ========================================================
        // ตัวเลือก "ext" : External data - หาค่าใน DeepSeek โดยตรง
        // ========================================================
        if (query_option === "ext") {
          const { answer, expertModelUsed } = await askExternalExpert();

          if (!answer) {
            set.status = 502;
            return { success: false, query_option, error: "Empty response from AI expert" };
          }

          // บันทึกคำถามและคำตอบไว้ที่ Neo4j (Auto-Cache)
          await cacheExternalQA(answer, expertModelUsed);

          return {
            success: true,
            query_option: "ext",
            question,
            answer,
            source: `${expertModelUsed}_ai`,
            resultsCount: 1,
            savedToGraph: true,
          };
        }

        // ========================================================
        // ตัวเลือก "int" (Default) : หาค่าใน Neo4j ก่อน ค่อยไปหา External data
        // ========================================================
        // 1. วิเคราะห์คำถาม โดยส่งให้ NT Qwen สร้าง Cypher Query
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

        // 2. ส่งคำถามที่วิเคราะห์แล้ว ค้นหาใน Neo4j
        const session = neo4jDriver.session();
        let rawRecords: any[] = [];

        if (cypherQuery) {
          try {
            const result = await session.run(cypherQuery);
            rawRecords = result.records.map((r) => r.toObject());
          } catch (queryErr) {
            console.warn("⚠️ Cypher execution error, falling back to external AI:", queryErr);
          }
        }
        await session.close();

        // ทำ Relevance Scoring & Re-ranking จัดเรียงชุดข้อมูลที่ตรงที่สุดขึ้นก่อน
        const records = rerankRecords(question, rawRecords);

        // 3. ถ้าพบข้อมูลใน Neo4j -> ส่งให้ DeepSeek สังเคราะห์และสรุปคำตอบ (RAG Synthesis)
        if (records.length > 0) {
          const contextText = records
            .map(
              (r, i) =>
                `[ข้อมูลชุดที่ ${i + 1}] ${r.title ? `หัวข้อ: ${r.title}\n` : ""}${r.content}`
            )
            .join("\n\n---\n\n");

          let answer = records[0].content;
          let synthesisModelUsed = "deepseek";

          try {
            // เรียก DeepSeek เพื่อทำ RAG Synthesis
            const ragRes = await fetch(`${deepseekUrl}/chat/completions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${deepseekKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: deepseekModel,
                messages: [
                  { role: "system", content: RAG_SYNTHESIS_SYSTEM_PROMPT },
                  {
                    role: "user",
                    content: `ข้อมูลบริบท (Context):\n${contextText}\n\nคำถาม: "${question}"\n\nโปรดคัดกรองและสรุปตอบคำถามตามแนวทางที่กำหนด:`,
                  },
                ],
                temperature: 0.3,
              }),
            });

            if (ragRes.ok) {
              const ragData = (await ragRes.json()) as any;
              const aiAnswer = ragData.choices?.[0]?.message?.content;
              if (aiAnswer) {
                answer = aiAnswer;
              }
            } else {
              console.warn("⚠️ DeepSeek RAG synthesis failed, falling back to NT Qwen:", ragRes.statusText);
              // Fallback to NT Qwen if DeepSeek fails
              const qwenFallbackRes = await fetch(`${ntUrl}/chat/completions`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${ntKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: ntModel,
                  messages: [
                    { role: "system", content: RAG_SYNTHESIS_SYSTEM_PROMPT },
                    {
                      role: "user",
                      content: `ข้อมูลบริบท (Context):\n${contextText}\n\nคำถาม: "${question}"\n\nโปรดตอบคำถามโดยอ้างอิงข้อมูลจากบริบทข้างต้น:`,
                    },
                  ],
                  temperature: 0.3,
                  max_tokens: 1000,
                }),
              });

              if (qwenFallbackRes.ok) {
                const qwenData = (await qwenFallbackRes.json()) as any;
                const qwenAnswer =
                  qwenData.choices?.[0]?.messages?.content ||
                  qwenData.choices?.[0]?.message?.content;
                if (qwenAnswer) {
                  answer = qwenAnswer;
                  synthesisModelUsed = "nt_qwen";
                }
              }
            }
          } catch (ragErr) {
            console.warn("⚠️ RAG synthesis error, falling back to raw record content:", ragErr);
          }

          return {
            success: true,
            query_option: "int",
            question,
            source: "neo4j_graph",
            cypherQuery,
            resultsCount: records.length,
            synthesisModel: synthesisModelUsed,
            answer,
            results: records,
          };
        }

        // ========================================================
        // 4. ถ้าไม่พบข้อมูลใน Neo4j (Internal) -> ไปหาที่ External data (DeepSeek)
        // ========================================================
        const { answer, expertModelUsed } = await askExternalExpert();

        if (!answer) {
          set.status = 502;
          return { success: false, query_option: "int", error: "Empty response from AI expert" };
        }

        // บันทึกคำถามและคำตอบไว้ที่ Neo4j (Auto-Cache)
        await cacheExternalQA(answer, expertModelUsed);

        return {
          success: true,
          query_option: "int",
          question,
          answer,
          source: `${expertModelUsed}_ai`,
          resultsCount: 1,
          savedToGraph: true,
          fallbackToExternal: true,
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
        query_option: t.Optional(
          t.Union([t.Literal("int"), t.Literal("ext")], {
            description: 'ตัวเลือกการค้นหา: "int" = หาใน Neo4j ก่อน ค่อยไปหาที่ External data (ค่าเริ่มต้น), "ext" = หาที่ External data (DeepSeek) โดยตรง',
            default: "int",
          })
        ),
      }),
      headers: t.Object({
        authorization: t.String({
          description: "Bearer <token>",
        }),
      }),
      detail: {
        summary: "Query FengSense (Option: 'int' for Neo4j first then external fallback [Default], 'ext' for DeepSeek external AI directly)",
        security: [{ bearerAuth: [] }],
      },
    }
  );
