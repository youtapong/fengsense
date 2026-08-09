import fs from "fs";
import { neo4jDriver } from "../neo4j";

export interface ChunkData {
  chapterTitle: string;
  sectionTitle: string;
  content: string;
}

/**
 * 1. Parses raw markdown content string into structured chunks by H2 (##) and H3 (###).
 */
export function parseMarkdown(content: string): ChunkData[] {
  const lines = content.split("\n");
  
  let currentChapter = "บทนำ";
  let currentSection = "เนื้อหาทั่วไป";
  let chunkBuffer: string[] = [];
  const chunks: ChunkData[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Save current chunk buffer
      if (chunkBuffer.length > 0) {
        chunks.push({
          chapterTitle: currentChapter,
          sectionTitle: currentSection,
          content: chunkBuffer.join("\n").trim(),
        });
        chunkBuffer = [];
      }
      currentChapter = line.replace("## ", "").trim();
      currentSection = "เนื้อหาทั่วไป";
    } else if (line.startsWith("### ")) {
      // Save current chunk buffer
      if (chunkBuffer.length > 0) {
        chunks.push({
          chapterTitle: currentChapter,
          sectionTitle: currentSection,
          content: chunkBuffer.join("\n").trim(),
        });
        chunkBuffer = [];
      }
      currentSection = line.replace("### ", "").trim();
    } else {
      // Skip H1 title lines or decorative separators to keep chunks clean
      if (line.startsWith("# ") || line.trim() === "---") {
        continue;
      }
      chunkBuffer.push(line);
    }
  }

  // Save the last chunk remaining in buffer
  if (chunkBuffer.length > 0) {
    chunks.push({
      chapterTitle: currentChapter,
      sectionTitle: currentSection,
      content: chunkBuffer.join("\n").trim(),
    });
  }

  // Filter out empty or extremely short chunks
  return chunks.filter(c => c.content.length > 20);
}

/**
 * 2. Generates a 1536-dimensional vector embedding.
 * Configured to call OpenAI API if OPENAI_API_KEY is present; otherwise falls back to mock vector.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: "text-embedding-3-small",
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        return data.data[0].embedding;
      } else {
        console.warn(`⚠️ OpenAI Embedding API error: ${response.statusText}. Using fallback mock vector.`);
      }
    } catch (e) {
      console.warn("⚠️ OpenAI Embedding fetch failed. Using fallback mock vector.", e);
    }
  }

  // Mock embedding vector of size 1536
  return new Array(1536).fill(0).map(() => Math.random());
}

/**
 * 3. Ingests raw markdown content directly into Neo4j database.
 */
export async function ingestMarkdownContent(content: string, courseName = "FengSense Masterclass"): Promise<void> {
  const chunks = parseMarkdown(content);
  const session = neo4jDriver.session();

  try {
    for (const chunk of chunks) {
      console.log(`[Neo4j Ingestion] Processing: ${chunk.chapterTitle} -> ${chunk.sectionTitle}`);
      const embedding = await generateEmbedding(chunk.content);

      await session.run(`
        // 1. Merge the main Course node
        MERGE (course:Course { name: $courseName })

        // 2. Merge the Chapter node
        MERGE (chapter:Chapter { title: $chapterTitle })
        MERGE (course)-[:HAS_CHAPTER]->(chapter)

        // 3. Create Chunk node (allow multiple chunks with same title under different runs)
        CREATE (chunk:Chunk {
          title: $sectionTitle,
          content: $content,
          embedding: $embedding,
          timestamp: timestamp()
        })
        CREATE (chapter)-[:HAS_CHUNK]->(chunk)
      `, {
        courseName,
        chapterTitle: chunk.chapterTitle,
        sectionTitle: chunk.sectionTitle,
        content: chunk.content,
        embedding: embedding
      });
    }
    console.log(`🎉 Ingestion completed successfully. ${chunks.length} chunks added.`);
  } catch (error) {
    console.error("❌ Neo4j Ingestion failed:", error);
    throw error;
  } finally {
    await session.close();
  }
}

/**
 * 4. Helper to ingest a local Markdown file from disk path.
 */
export async function ingestMarkdownFile(filePath: string, courseName = "FengSense Masterclass"): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  await ingestMarkdownContent(content, courseName);
}
