'use client';

// app/(admin)/admin/cms/skill-clusters/page.tsx
// /admin/cms/skill-clusters — Skill Cluster catalog list (Admin CMS)
// Protected by AdminGuard via app/(admin)/layout.tsx

import { AdminTopbar } from '@/components/layout/AdminTopbar';
import { SkillClusterTable } from '@/features/admin/cms/skill-clusters/components/SkillClusterTable';

export default function AdminSkillClustersPage() {
  return (
    <div className="flex flex-col h-full">
      <AdminTopbar title="Skill Clusters" />
      <div className="p-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-surface-900">Skill Clusters</h2>
          <p className="mt-1 text-sm text-surface-500">
            Manage skill clusters grouped under career domains. Skill clusters power
            skill grouping, career matching, and the CHI Engine.
          </p>
        </div>
        <SkillClusterTable />
      </div>
    </div>
  );
}
