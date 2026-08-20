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
 * ตัดตัวอักษรภาษาจีน เครื่องหมายวรรคตอนภาษาจีน และประโยคภาษาจีนออกจากข้อความผลลัพธ์
 */
function removeChinese(text: string): string {
  if (!text) return "";

  // 1. ตัดแท็ก <think>...</think> ออกก่อน
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // 2. แยกบรรทัด หากบรรทัดใดเป็นภาษาจีนล้วนหรือเกือบทั้งหมด (> 40% อักษรจีน) ให้ตัดบรรทัดนั้นทิ้ง
  const lines = cleaned.split("\n");
  const filteredLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    const chineseChars = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const totalChars = trimmed.replace(/\s+/g, "").length;
    if (totalChars > 0 && chineseChars / totalChars > 0.4) {
      return false;
    }
    return true;
  });
  cleaned = filteredLines.join("\n");

  // 3. ลบตัวอักษรจีนและเครื่องหมายวรรคตอนภาษาจีนที่แทรกอยู่ในข้อความ
  cleaned = cleaned
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "")
    .replace(/[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\{\s*\}/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

/**
 * ฟังก์ชันจัดลำดับความเกี่ยวข้อง (Relevance Scoring & Re-ranking)
 * ให้คะแนนความสอดคล้องระหว่างคำถามกับ Title และ Content ของแต่ละ Record
 * และจัดลำดับจากคะแนนสูงสุดไปต่ำสุด เพื่อให้ชุดข้อมูลที่ตรงที่สุดขึ้นก่อนเสมอ
 * (โดยให้โบนัสคะแนนพิเศษกับ External Data เพื่อให้มี relevanceScore สูงกว่าข้อมูลทั่วไป)
 */
function rerankRecords(
  question: string,
  records: Array<{ title?: string; content?: string; source?: string }>
): Array<{ title: string; content: string; source: string; relevanceScore: number }> {
  const normalizedQ = question.toLowerCase().trim();

  // สกัดคำสำคัญ (Keywords) โดยตัดคำเชื่อมทั่วไป
  const stopWords = new Set([
    "การ", "ของ", "ให้", "และ", "หรือ", "ตาม", "แบบ", "ที่", "ใน", "กับ", "เป็น", "มี", "จะ", "ได้", "ช่วย", "ทำ"
  ]);
  const rawWords = normalizedQ.split(/[\s,.\-_/\\+]+/);
  const keywords = rawWords.filter((w) => w.length > 1 && !stopWords.has(w));

  // 1. ตัดรายการที่ซ้ำซ้อนกันออก (Deduplication) โดยจัดเก็บ source เอาไว้
  const uniqueRecords: Array<{ title: string; content: string; source: string }> = [];
  const seen = new Map<string, { title: string; content: string; source: string }>();
  for (const r of records) {
    const key = `${(r.title || "").trim()}:::${(r.content || "").trim().substring(0, 100)}`;
    const src = r.source || "internal_doc";
    if (!seen.has(key)) {
      const item = { title: r.title || "", content: r.content || "", source: src };
      seen.set(key, item);
      uniqueRecords.push(item);
    } else if (src === "external_data") {
      // หากข้อมูลซ้ำกันแต่ตัวใดตัวหนึ่งมาจาก external_data ให้อัปเดตเป็น external_data
      const existing = seen.get(key);
      if (existing) existing.source = "external_data";
    }
  }

  const scoredRecords = uniqueRecords.map((r) => {
    const title = r.title || "";
    const content = r.content || "";
    const source = r.source || "internal_doc";
    const lowerTitle = title.toLowerCase().trim();
    const lowerContent = content.toLowerCase();
    const isExternal = source === "external_data" || source.includes("external");

    let score = 0;

    // 2. ถ้า Title ตรงกับคำถามเป๊ะๆ (Exact Match เช่น ExternalQA หรือหัวข้อตรงเป๊ะ)
    if (lowerTitle && lowerTitle === normalizedQ) {
      score += isExternal ? 300 : 200; // ExternalQA ที่ตรงเป๊ะได้คะแนนสูงสุดพิเศษ
    } else if (lowerTitle && (normalizedQ.includes(lowerTitle) || lowerTitle.includes(normalizedQ))) {
      score += isExternal ? 120 : 80;
    }

    // 3. ตรวจสอบการตรงกันของ Keywords ใน Title และ Content
    for (const kw of keywords) {
      if (lowerTitle.includes(kw)) {
        score += isExternal ? 30 : 20; // ปรากฏในหัวข้อ ให้คะแนนสูงกว่าเมื่อมาจาก external
      }
      if (lowerContent.includes(kw)) {
        score += isExternal ? 3 : 2; // ปรากฏในเนื้อหา
      }
    }

    // 4. โบนัสพิเศษสำหรับคำหลักสำคัญเฉพาะกลุ่ม
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

    // 5. โบนัสคะแนนพิเศษสำหรับ External Data (ExternalQA)
    // ให้ค่า relevanceScore สูงกว่าข้อมูลภายในที่เก็บไว้ เพื่อให้นำมาแสดงผลก่อนเมื่อค้นหาด้วย internal ในคราวถัดไป
    if (isExternal && score > 0) {
      score += 50;
    }

    return {
      title,
      content,
      source,
      relevanceScore: score,
    };
  });

  // จัดเรียงคะแนนจากมากไปน้อย
  scoredRecords.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // ถ้าอันดับ 1 เป็นคำตอบที่ตรงกับคำถามเป๊ะๆ (score >= 200) ให้ส่งคืนเฉพาะคำตอบที่ตรงเป๊ะอันดับ 1
  const topScore = scoredRecords[0]?.relevanceScore || 0;
  if (topScore >= 200) {
    return scoredRecords.slice(0, 1);
  }

  // กรองเฉพาะชุดข้อมูลที่มีความเกี่ยวข้อง หากมีรายการที่คะแนนสูง (>= 20) ให้ตัด noise ทิ้ง
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

      const getDeepseekHeaders = () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (deepseekKey) {
          headers["Authorization"] = `Bearer ${deepseekKey}`;
        }
        return headers;
      };

      // ฟังก์ชันสำหรับถาม AI ผู้เชี่ยวชาญภายนอก (DeepSeek-Qwen -> fallback NT Qwen)
      const askExternalExpert = async () => {
        let answer = "";
        let expertModelUsed = "deepseek-qwen";

        try {
          const expertRes = await fetch(`${deepseekUrl}/chat/completions`, {
            method: "POST",
            headers: getDeepseekHeaders(),
            signal: AbortSignal.timeout(25000), // Timeout 25 วินาที ป้องกันค้าง
            body: JSON.stringify({
              model: deepseekModel,
              messages: [
                { role: "system", content: FENGSHUI_EXPERT_SYSTEM_PROMPT },
                {
                  role: "user",
                  content: `${question}\n\n(หมายเหตุ: โปรดตอบเป็นภาษาไทยทั้งหมด หากมีคำศัพท์หรือตัวอักษรภาษาจีนให้แปลและอธิบายเป็นภาษาไทยกำกับด้วยครับ)`,
                },
              ],
              temperature: deepseekTemperature,
              max_tokens: deepseekMaxTokens,
            }),
          });

          if (expertRes.ok) {
            const expertData = (await expertRes.json()) as any;
            const rawAnswer = expertData.choices?.[0]?.message?.content || "";
            answer = rawAnswer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
          } else {
            console.warn("⚠️ DeepSeek expert failed, falling back to NT Qwen:", expertRes.statusText);
          }
        } catch (deepseekErr) {
          console.warn("⚠️ DeepSeek expert error or timeout (25s), falling back to NT Qwen:", deepseekErr);
        }

        // Fallback to NT Qwen if DeepSeek-Qwen failed or timed out
        if (!answer) {
          try {
            const qwenExpertRes = await fetch(`${ntUrl}/chat/completions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${ntKey}`,
                "Content-Type": "application/json",
              },
              signal: AbortSignal.timeout(20000),
              body: JSON.stringify({
                model: ntModel,
                messages: [
                  { role: "system", content: FENGSHUI_EXPERT_SYSTEM_PROMPT },
                  {
                    role: "user",
                    content: `${question}\n\n(หมายเหตุ: โปรดตอบเป็นภาษาไทยทั้งหมด หากมีคำศัพท์หรือตัวอักษรภาษาจีนให้แปลและอธิบายเป็นภาษาไทยกำกับด้วยครับ)`,
                  },
                ],
                temperature: 0.7,
                max_tokens: 1000,
              }),
            });

            if (qwenExpertRes.ok) {
              const qwenData = (await qwenExpertRes.json()) as any;
              const rawQwenAnswer =
                qwenData.choices?.[0]?.messages?.content ||
                qwenData.choices?.[0]?.message?.content ||
                "";
              answer = rawQwenAnswer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
              expertModelUsed = "nt_qwen";
            }
          } catch (ntErr) {
            console.warn("⚠️ NT Qwen expert error or timeout:", ntErr);
          }
        }

        return { answer, expertModelUsed };
      };

      // ฟังก์ชันสำหรับบันทึกคำถาม-คำตอบลง Neo4j (Auto-Cache) แบบ MERGE เพื่อไม่ให้เกิดข้อมูลซ้ำ
      const cacheExternalQA = async (ans: string, sourceModel: string) => {
        const session = neo4jDriver.session();
        try {
          const embedding = await generateEmbedding(question);
          await session.run(
            `
            MERGE (q:ExternalQA { question: $question })
            SET q.answer = $answer,
                q.embedding = $embedding,
                q.source = $source,
                q.timestamp = timestamp()
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

          const cleanedAnswer = removeChinese(answer);

          // บันทึกคำถามและคำตอบไว้ที่ Neo4j (Auto-Cache)
          await cacheExternalQA(cleanedAnswer, expertModelUsed);

          return {
            success: true,
            query_option: "ext",
            question,
            answer: cleanedAnswer,
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
          let synthesisModelUsed = "neo4j_direct";

          // ถ้าพบว่าคำถามตรงกับหัวข้อพอดี (เช่น ExternalQA Cache หรือคำตอบที่ตรงเป๊ะ) ให้ใช้คำตอบจาก Neo4j ได้ทันที
          const isDirectMatch =
            records[0].title &&
            records[0].title.toLowerCase().trim() === question.toLowerCase().trim();

          if (!isDirectMatch) {
            try {
              // เรียก DeepSeek-Qwen เพื่อทำ RAG Synthesis พร้อม Timeout 15 วินาที
              const ragRes = await fetch(`${deepseekUrl}/chat/completions`, {
                method: "POST",
                headers: getDeepseekHeaders(),
                signal: AbortSignal.timeout(15000), // Timeout 15s ป้องกันค้างจนเกิด 504 Gateway Timeout
                body: JSON.stringify({
                  model: deepseekModel,
                  messages: [
                    { role: "system", content: RAG_SYNTHESIS_SYSTEM_PROMPT },
                    {
                      role: "user",
                      content: `ข้อมูลบริบท (Context):\n${contextText}\n\nคำถาม: "${question}"\n\nโปรดคัดกรองและสรุปตอบคำถามเป็นภาษาไทยทั้งหมด (หากมีคำศัพท์หรือตัวอักษรภาษาจีนให้แปลและอธิบายเป็นภาษาไทยกำกับด้วยครับ):`,
                    },
                  ],
                  temperature: deepseekTemperature,
                  max_tokens: deepseekMaxTokens,
                }),
              });

              if (ragRes.ok) {
                const ragData = (await ragRes.json()) as any;
                const aiAnswer = ragData.choices?.[0]?.message?.content;
                if (aiAnswer) {
                  answer = aiAnswer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
                  synthesisModelUsed = "deepseek-qwen";
                }
              } else {
                console.warn("⚠️ DeepSeek RAG synthesis failed, using Neo4j record directly:", ragRes.statusText);
              }
            } catch (ragErr) {
              console.warn("⚠️ DeepSeek RAG synthesis timeout (15s) or error, falling back to Neo4j record directly:", ragErr);
            }
          }

          const cleanedAnswer = removeChinese(answer);

          return {
            success: true,
            query_option: "int",
            question,
            source: "neo4j_graph",
            cypherQuery,
            resultsCount: records.length,
            synthesisModel: synthesisModelUsed,
            answer: cleanedAnswer,
            results: records.map((r) => ({
              ...r,
              title: removeChinese(r.title),
              content: removeChinese(r.content),
            })),
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

        const cleanedAnswer = removeChinese(answer);

        // บันทึกคำถามและคำตอบไว้ที่ Neo4j (Auto-Cache)
        await cacheExternalQA(cleanedAnswer, expertModelUsed);

        return {
          success: true,
          query_option: "int",
          question,
          answer: cleanedAnswer,
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
