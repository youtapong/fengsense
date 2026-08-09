import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { sql } from "./db";

export const auth = new Elysia({ prefix: "/auth" })
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "default_secret_fallback",
    })
  )
  .post(
    "/login",
    async ({ body, jwt, set }) => {
      const { username, password } = body;
      try {
        const [user] = await sql`
          SELECT * FROM "user" WHERE username = ${username}
        `;

        if (!user) {
          set.status = 401;
          return { success: false, error: "Invalid username or password" };
        }

        const isPasswordValid = await Bun.password.verify(password, user.password);
        if (!isPasswordValid) {
          set.status = 401;
          return { success: false, error: "Invalid username or password" };
        }

        const token = await jwt.sign({
          id: user.id,
          username: user.username,
        });

        return {
          success: true,
          token,
          user: {
            id: user.id,
            username: user.username,
            created_at: user.created_at,
          },
        };
      } catch (error: any) {
        set.status = 500;
        return { success: false, error: error.message || "Login failed" };
      }
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
      }),
      detail: {
        summary: "Log in with username and password",
        security: [],
      },
    }
  )
  .post(
    "/signup",
    async ({ body, set }) => {
      const { username, password } = body;
      try {
        // Hash password using Bun's built-in high-performance password hashing API
        const passwordHash = await Bun.password.hash(password);

        const [newUser] = await sql`
          INSERT INTO "user" (username, password)
          VALUES (${username}, ${passwordHash})
          RETURNING id, username, created_at
        `;

        return {
          success: true,
          message: "User registered successfully",
          user: newUser,
        };
      } catch (error: any) {
        set.status = 400;
        if (error.code === "23505") { // Unique constraint violation code in PostgreSQL
          return { success: false, error: "Username already exists" };
        }
        return { success: false, error: error.message || "Failed to register user" };
      }
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
      }),
      detail: {
        summary: "Sign up a new user",
        security: [],
      },
    }
  )
  .get(
    "/me",
    async ({ headers, jwt, set }) => {
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

      try {
        const [user] = await sql`
          SELECT id, username, created_at FROM "user" WHERE id = ${payload.id}
        `;

        if (!user) {
          set.status = 404;
          return { success: false, error: "User not found" };
        }

        return {
          success: true,
          user,
        };
      } catch (error: any) {
        set.status = 500;
        return { success: false, error: error.message || "Failed to fetch profile" };
      }
    },
    {
      headers: t.Object({
        authorization: t.String({
          description: "Bearer <token>",
        }),
      }),
      detail: {
        summary: "Get current user profile (JWT protected)",
        security: [
          {
            bearerAuth: []
          }
        ]
      },
    }
  );
