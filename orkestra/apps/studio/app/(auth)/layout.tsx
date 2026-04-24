export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[hsl(210_40%_98%)] px-4">
      {children}
    </div>
  );
}
