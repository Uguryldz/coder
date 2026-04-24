import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "admin" | "team_lead" | "analyst" | "viewer";
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
    role: "admin" | "team_lead" | "analyst" | "viewer";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "admin" | "team_lead" | "analyst" | "viewer";
  }
}
