"use client";

import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Library,
  Route,
  ScrollText,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/dashboard", label: "Pano", icon: LayoutDashboard },
  { href: "/variants", label: "Ajan Varyantları", icon: Users },
  { href: "/shared-library", label: "Paylaşılan Bilgi", icon: Library },
  { href: "/routing-rules", label: "Yönlendirme", icon: Route },
  { href: "/audit", label: "Denetim Kaydı", icon: ScrollText },
  { href: "/workflows", label: "İş Akışları", icon: Workflow },
  { href: "/settings", label: "Ayarlar", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex h-screen w-60 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
          JO
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Jira AI Orkestra</div>
          <div className="text-[10px] text-muted-foreground">Agent Studio</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-foreground hover:bg-secondary",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border p-3 text-[10px] text-muted-foreground">
        v0.1 · tek-müşteri
      </div>
    </aside>
  );
}
