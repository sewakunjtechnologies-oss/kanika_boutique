import { Sidebar } from '@/components/sidebar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Sidebar businessName="Kanika Designs" />
      <main className="pt-14 md:pl-56 md:pt-0">
        <div className="px-3 py-4 sm:px-6 sm:py-6">{children}</div>
      </main>
    </div>
  );
}
