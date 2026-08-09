import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { ingestMarkdownContent } from "./services/markdownIngest";
import fs from "fs";

export const document = new Elysia({ prefix: "/document" })
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "default_secret_fallback",
    })
  )
  .post(
    "/upload",
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

      const { file, courseName } = body;

      try {
        let content = "";
        let fileName = "";
        let fileSize = 0;

        if (typeof file === "string") {
          // If it is a string, treat it as a local file path
          if (!fs.existsSync(file)) {
            set.status = 400;
            return { success: false, error: `Local file path not found: ${file}` };
          }
          content = fs.readFileSync(file, "utf-8");
          fileName = file.split("/").pop() || file;
          fileSize = fs.statSync(file).size;
        } else {
          // If it is a File object (uploaded via multipart/form-data)
          content = await file.text();
          fileName = file.name;
          fileSize = file.size;
        }

        // Ingest into Neo4j
        await ingestMarkdownContent(content, courseName || "FengSense Masterclass");

        return {
          success: true,
          message: "Markdown file ingested successfully",
          fileName,
          fileSize,
        };
      } catch (error: any) {
        set.status = 500;
        return {
          success: false,
          error: error.message || "Failed to process and ingest markdown file",
        };
      }
    },
    {
      body: t.Object({
        file: t.Union([
          t.File({
            description: "Markdown file (.md) to upload",
          }),
          t.String({
            description: "Or local server file path to the markdown file",
          })
        ]),
        courseName: t.Optional(
          t.String({
            description: "Optional course name to associate with the uploaded document",
          })
        ),
      }),
      headers: t.Object({
        authorization: t.String({
          description: "Bearer <token>",
        }),
      }),
      detail: {
        summary: "Upload a Markdown file (or pass local path) and ingest it into Neo4j (JWT protected)",
        security: [
          {
            bearerAuth: [],
          },
        ],
      },
    }
  );
