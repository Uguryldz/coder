"use client";

import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LogOut, User as UserIcon } from "lucide-react";
import { signOut, useSession } from "next-auth/react";

export function Topbar() {
  const { data: session } = useSession();
  const user = session?.user;
  const initials = (user?.name ?? user?.email ?? "?")
    .split(/\s|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-5">
      <div className="text-sm font-medium">Agent Studio</div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" className="gap-2 px-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {initials}
            </span>
            <div className="text-left leading-tight">
              <div className="text-xs font-medium">{user?.name ?? user?.email}</div>
              <div className="text-[10px] text-muted-foreground">{user?.role}</div>
            </div>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-50 min-w-[180px] rounded-md border border-border bg-background p-1 shadow-md"
          >
            <DropdownMenu.Item className="flex items-center gap-2 rounded px-3 py-2 text-xs text-muted-foreground">
              <UserIcon className="h-3.5 w-3.5" />
              {user?.email}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm outline-none hover:bg-secondary"
              onSelect={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="h-4 w-4" />
              Çıkış yap
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}
